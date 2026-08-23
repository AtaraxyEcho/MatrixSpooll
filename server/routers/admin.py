"""Administrator user-management routes."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from lib.db import get_async_session
from lib.db.base import DEFAULT_USER_ID, utc_now
from lib.db.models.audit import AuditEvent
from lib.db.models.project import ProjectRegistry
from lib.db.models.user import User
from lib.db.models.user_session import UserSession
from lib.generation_queue import get_generation_queue
from lib.i18n import Translator
from server.auth import AdminUser, generate_password, hash_password, revoke_all_user_sessions
from server.routers.tasks import _localize_task
from server.services.audit import AuditAction, AuditResourceType, record_audit_event
from server.services.user_validation import NICKNAME_MAX_LENGTH, validate_nickname

router = APIRouter(prefix="/admin", tags=["管理员"])

USERNAME_MIN_LENGTH = 4
USERNAME_MAX_LENGTH = 32
USERNAME_SEPARATORS = frozenset("._-")


class AdminUserSummary(BaseModel):
    id: str
    username: str
    nickname: str | None
    avatar_path: str | None
    email: str | None
    last_login_at: datetime | None
    last_login_ip: str | None
    role: Literal["admin", "member"]
    is_superadmin: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime


class CreateUserRequest(BaseModel):
    username: str
    email: str | None = Field(default=None, max_length=254)
    nickname: str | None = Field(default=None, max_length=NICKNAME_MAX_LENGTH)
    password: str | None = Field(default=None, min_length=8, max_length=200)
    role: Literal["admin", "member"] = "member"


class UpdateUserRequest(BaseModel):
    email: str | None = Field(default=None, max_length=254)
    nickname: str | None = Field(default=None, max_length=NICKNAME_MAX_LENGTH)
    role: Literal["admin", "member"] | None = None
    is_active: bool | None = None


class ResetPasswordRequest(BaseModel):
    password: str | None = Field(default=None, min_length=8, max_length=200)


class PasswordResponse(BaseModel):
    temporary_password: str | None = None


class CreateUserResponse(BaseModel):
    user: AdminUserSummary
    temporary_password: str | None = None


class AdminUsersResponse(BaseModel):
    users: list[AdminUserSummary]
    total: int
    page: int
    page_size: int


class AdminAuditEventSummary(BaseModel):
    id: int
    actor_user_id: str | None
    actor_username: str | None
    action: str
    resource_type: str
    resource_id: str | None
    project_id: str | None
    project_name: str | None
    details: dict[str, object]
    created_at: datetime


class AdminAuditEventsResponse(BaseModel):
    events: list[AdminAuditEventSummary]
    total: int
    page: int
    page_size: int


class AdminSessionSummary(BaseModel):
    id: str
    user_id: str
    username: str
    device_id: str
    ip_address: str | None
    user_agent: str | None
    status: Literal["active", "expired", "revoked"]
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None


class AdminSessionsResponse(BaseModel):
    sessions: list[AdminSessionSummary]
    total: int
    page: int
    page_size: int


class AdminTaskListResponse(BaseModel):
    items: list[dict[str, object]]
    total: int
    page: int
    page_size: int


class AdminTaskResponse(BaseModel):
    task: dict[str, object]


class AdminTaskStatsResponse(BaseModel):
    stats: dict[str, int]


def _validate_username(value: str, translate: Callable[..., str]) -> str:
    username = value.strip()
    if not username:
        raise HTTPException(status_code=422, detail=translate("admin_username_required"))
    if not USERNAME_MIN_LENGTH <= len(username) <= USERNAME_MAX_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=translate(
                "admin_username_length",
                min=USERNAME_MIN_LENGTH,
                max=USERNAME_MAX_LENGTH,
            ),
        )
    if not username[0].isascii() or not username[0].isalpha():
        raise HTTPException(status_code=422, detail=translate("admin_username_start"))
    if any(
        not character.isascii() or (not character.isalnum() and character not in USERNAME_SEPARATORS)
        for character in username
    ):
        raise HTTPException(status_code=422, detail=translate("admin_username_characters"))
    if username[-1] in USERNAME_SEPARATORS or any(
        current in USERNAME_SEPARATORS and following in USERNAME_SEPARATORS
        for current, following in zip(username, username[1:], strict=False)
    ):
        raise HTTPException(status_code=422, detail=translate("admin_username_separators"))
    return username


def _normalize_email(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    return normalized or None


def _as_summary(user: User) -> AdminUserSummary:
    role = user.role if user.role in {"admin", "member"} else "member"
    return AdminUserSummary(
        id=user.id,
        username=user.username,
        nickname=user.nickname,
        avatar_path=user.avatar_path,
        email=user.email,
        last_login_at=user.last_login_at,
        last_login_ip=user.last_login_ip,
        role=role,  # type: ignore[arg-type]
        is_superadmin=bool(user.is_superadmin),
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


async def _active_admin_count(session: AsyncSession) -> int:
    result = await session.execute(
        select(func.count()).select_from(User).where(User.role == "admin", User.is_active.is_(True))
    )
    return int(result.scalar_one())


async def _get_user(session: AsyncSession, user_id: str, translate: Callable[..., str]) -> User:
    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail=translate("admin_user_not_found"))
    return user


def _reject_superadmin_mutation(user: User, translate: Callable[..., str]) -> None:
    if user.is_superadmin:
        raise HTTPException(status_code=403, detail=translate("admin_superadmin_protected"))


@router.get("/users", response_model=AdminUsersResponse)
async def list_users(
    _admin: AdminUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    username: str | None = Query(default=None, min_length=1, max_length=254),
    session: AsyncSession = Depends(get_async_session),
) -> AdminUsersResponse:
    filters = []
    if username:
        pattern = f"%{username.strip()}%"
        filters.append(or_(User.username.ilike(pattern), User.email.ilike(pattern)))
    total_result = await session.execute(select(func.count()).select_from(User).where(*filters))
    total = int(total_result.scalar_one())
    result = await session.execute(
        select(User).where(*filters).order_by(User.created_at.asc()).offset((page - 1) * page_size).limit(page_size)
    )
    return AdminUsersResponse(
        users=[_as_summary(user) for user in result.scalars()],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/audit-events", response_model=AdminAuditEventsResponse)
async def list_audit_events(
    _admin: AdminUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    action: str | None = Query(default=None, min_length=1, max_length=128),
    project_id: str | None = Query(default=None, min_length=1, max_length=128),
    actor_user_id: str | None = Query(default=None, min_length=1, max_length=128),
    actor_username: str | None = Query(default=None, min_length=1, max_length=80),
    project_name: str | None = Query(default=None, min_length=1, max_length=160),
    session: AsyncSession = Depends(get_async_session),
) -> AdminAuditEventsResponse:
    filters = []
    if action:
        filters.append(AuditEvent.action == action)
    if project_id:
        filters.append(AuditEvent.project_id == project_id)
    if actor_user_id:
        filters.append(AuditEvent.actor_user_id == actor_user_id)
    if actor_username:
        filters.append(AuditEvent.actor_username.ilike(f"%{actor_username.strip()}%"))
    if project_name:
        filters.append(AuditEvent.project_name.ilike(f"%{project_name.strip()}%"))

    total_result = await session.execute(select(func.count()).select_from(AuditEvent).where(*filters))
    total = int(total_result.scalar_one())
    result = await session.execute(
        select(AuditEvent)
        .where(*filters)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return AdminAuditEventsResponse(
        events=[
            AdminAuditEventSummary(
                id=event.id,
                actor_user_id=event.actor_user_id,
                actor_username=event.actor_username,
                action=event.action,
                resource_type=event.resource_type,
                resource_id=event.resource_id,
                project_id=event.project_id,
                project_name=event.project_name,
                details=event.details,
                created_at=event.created_at,
            )
            for event in result.scalars()
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


def _session_status(row: UserSession, now: datetime) -> Literal["active", "expired", "revoked"]:
    if row.revoked_at is not None:
        return "revoked"
    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return "expired" if expires_at <= now else "active"


@router.get("/sessions", response_model=AdminSessionsResponse)
async def list_sessions(
    _admin: AdminUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    username: str | None = Query(default=None, min_length=1, max_length=80),
    session: AsyncSession = Depends(get_async_session),
) -> AdminSessionsResponse:
    now = utc_now()
    filters = []
    if username:
        filters.append(User.username.ilike(f"%{username.strip()}%"))
    filters.extend([UserSession.revoked_at.is_(None), UserSession.expires_at > now])
    count = await session.scalar(select(func.count()).select_from(UserSession).join(User).where(*filters))
    result = await session.execute(
        select(UserSession, User.username)
        .join(User, UserSession.user_id == User.id)
        .where(*filters)
        .order_by(UserSession.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    sessions = [
        AdminSessionSummary(
            id=row.id,
            user_id=row.user_id,
            username=username_value,
            device_id=row.device_id,
            ip_address=row.ip_address,
            user_agent=row.user_agent,
            status=_session_status(row, now),
            created_at=row.created_at,
            expires_at=row.expires_at,
            revoked_at=row.revoked_at,
        )
        for row, username_value in result.all()
    ]
    return AdminSessionsResponse(sessions=sessions, total=int(count or 0), page=page, page_size=page_size)


@router.post("/sessions/{session_id}/revoke", status_code=204)
async def revoke_session(
    session_id: str,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> None:
    row = await session.scalar(select(UserSession).where(UserSession.id == session_id))
    if row is None:
        raise HTTPException(status_code=404, detail=_t("admin_session_not_found"))
    if row.revoked_at is None:
        now = utc_now()
        row.revoked_at = now
        row.updated_at = now
        record_audit_event(
            session,
            actor=admin,
            action=AuditAction.SESSION_REVOKE,
            resource_type=AuditResourceType.SESSION,
            resource_id=row.id,
            details={"user_id": row.user_id, "device_id": row.device_id},
        )
        await session.commit()


@router.get("/tasks", response_model=AdminTaskListResponse)
async def list_admin_tasks(
    _admin: AdminUser,
    _t: Translator,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    status: str | None = Query(default=None, min_length=1, max_length=32),
    task_type: str | None = Query(default=None, min_length=1, max_length=80),
    project_name: str | None = Query(default=None, min_length=1, max_length=160),
    user_id: str | None = Query(default=None, min_length=1, max_length=128),
) -> AdminTaskListResponse:
    payload = await get_generation_queue().list_tasks(
        status=status,
        task_type=task_type,
        project_name=project_name.strip() if project_name else None,
        user_id=user_id,
        page=page,
        page_size=page_size,
    )
    return AdminTaskListResponse(
        items=[_localize_task(item, _t) for item in payload["items"]],
        total=int(payload["total"]),
        page=int(payload["page"]),
        page_size=int(payload["page_size"]),
    )


@router.get("/tasks/stats", response_model=AdminTaskStatsResponse)
async def admin_task_stats(_admin: AdminUser) -> AdminTaskStatsResponse:
    return AdminTaskStatsResponse(stats=await get_generation_queue().get_task_stats())


@router.get("/tasks/{task_id}", response_model=AdminTaskResponse)
async def get_admin_task(task_id: str, _admin: AdminUser, _t: Translator) -> AdminTaskResponse:
    task = await get_generation_queue().get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=_t("admin_task_not_found"))
    return AdminTaskResponse(task=_localize_task(task, _t))


@router.post("/tasks/{task_id}/cancel")
async def cancel_admin_task(
    task_id: str,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> dict[str, object]:
    task = await get_generation_queue().get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=_t("admin_task_not_found"))
    result = await get_generation_queue().cancel_task(task_id)
    if not result.get("cancelled") and not result.get("cancelling"):
        raise HTTPException(status_code=409, detail=_t("admin_task_not_active"))
    record_audit_event(
        session,
        actor=admin,
        action=AuditAction.TASK_CANCEL,
        resource_type=AuditResourceType.TASK,
        resource_id=task_id,
        project_id=task.get("project_id"),
        project_name=task.get("project_name"),
        details={"task_type": task.get("task_type"), "status": task.get("status")},
    )
    await session.commit()
    return {"task": _localize_task(task, _t), "result": result}


@router.post("/tasks/{task_id}/retry", response_model=AdminTaskResponse, status_code=202)
async def retry_admin_task(
    task_id: str,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> AdminTaskResponse:
    task = await get_generation_queue().get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=_t("admin_task_not_found"))
    if task.get("status") not in {"failed", "cancelled"}:
        raise HTTPException(status_code=409, detail=_t("admin_task_retry_terminal_only"))
    payload = task.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    retry_user_id = task.get("user_id")
    if not isinstance(retry_user_id, str) or not retry_user_id:
        retry_user_id = DEFAULT_USER_ID
    retried = await get_generation_queue().enqueue_task(
        project_name=str(task["project_name"]),
        task_type=str(task["task_type"]),
        media_type=str(task["media_type"]),
        resource_id=str(task["resource_id"]),
        payload=payload,
        script_file=task.get("script_file") if isinstance(task.get("script_file"), str) else None,
        resource_type=task.get("resource_type") if isinstance(task.get("resource_type"), str) else None,
        source="admin_retry",
        user_id=retry_user_id,
    )
    record_audit_event(
        session,
        actor=admin,
        action=AuditAction.TASK_RETRY,
        resource_type=AuditResourceType.TASK,
        resource_id=task_id,
        project_id=task.get("project_id"),
        project_name=task.get("project_name"),
        details={"new_task_id": retried.get("task_id"), "task_type": task.get("task_type")},
    )
    await session.commit()
    return AdminTaskResponse(task=_localize_task(retried, _t))


@router.post("/users", response_model=CreateUserResponse, status_code=201)
async def create_user(
    body: CreateUserRequest,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> CreateUserResponse:
    username = _validate_username(body.username, _t)
    existing = await session.execute(select(User).where(func.lower(User.username) == username.lower()))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail=_t("admin_user_exists"))

    nickname = validate_nickname(body.nickname, _t)
    if nickname is not None:
        existing_nickname = await session.execute(select(User).where(User.nickname == nickname))
        if existing_nickname.scalar_one_or_none() is not None:
            raise HTTPException(status_code=409, detail=_t("admin_nickname_exists"))

    temporary_password = body.password or generate_password()
    user = User(
        id=uuid4().hex,
        username=username,
        email=_normalize_email(body.email),
        nickname=nickname,
        password_hash=hash_password(temporary_password),
        role=body.role,
        is_active=True,
    )
    session.add(user)
    record_audit_event(
        session,
        actor=admin,
        action=AuditAction.USER_CREATE,
        resource_type=AuditResourceType.USER,
        resource_id=user.id,
        details={"role": user.role},
    )
    await session.commit()
    await session.refresh(user)
    return CreateUserResponse(
        user=_as_summary(user), temporary_password=temporary_password if body.password is None else None
    )


@router.patch("/users/{user_id}", response_model=AdminUserSummary)
async def update_user(
    user_id: str,
    body: UpdateUserRequest,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> AdminUserSummary:
    user = await _get_user(session, user_id, _t)
    _reject_superadmin_mutation(user, _t)
    next_role = body.role or user.role
    next_active = user.is_active if body.is_active is None else body.is_active
    is_last_admin = user.role == "admin" and user.is_active and (next_role != "admin" or not next_active)
    if user.id == admin.id and is_last_admin:
        raise HTTPException(status_code=400, detail=_t("admin_last_admin"))
    if is_last_admin and await _active_admin_count(session) <= 1:
        raise HTTPException(status_code=400, detail=_t("admin_last_admin"))
    if user.is_active and not next_active:
        owned_project = await session.scalar(
            select(ProjectRegistry.name).where(ProjectRegistry.owner_id == user.id).limit(1)
        )
        if owned_project is not None:
            raise HTTPException(
                status_code=400,
                detail=_t("admin_project_owner_deactivate_forbidden", project=owned_project),
            )

    previous_role = user.role
    previous_active = user.is_active
    if "email" in body.model_fields_set:
        user.email = _normalize_email(body.email)
    if "nickname" in body.model_fields_set:
        nickname = validate_nickname(body.nickname, _t)
        if nickname is not None:
            existing_nickname = await session.execute(select(User).where(User.nickname == nickname, User.id != user.id))
            if existing_nickname.scalar_one_or_none() is not None:
                raise HTTPException(status_code=409, detail=_t("admin_nickname_exists"))
        user.nickname = nickname
    user.role = next_role
    user.is_active = next_active
    if not user.is_active:
        await revoke_all_user_sessions(user.id, session=session)
    record_audit_event(
        session,
        actor=admin,
        action=AuditAction.USER_UPDATE,
        resource_type=AuditResourceType.USER,
        resource_id=user.id,
        details={
            "from_role": previous_role,
            "to_role": next_role,
            "from_active": previous_active,
            "to_active": next_active,
        },
    )
    await session.commit()
    await session.refresh(user)
    return _as_summary(user)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: str,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> None:
    """Delete a user account (physical delete, DB cascades related records).

    Guard rails: superadmin is immutable; an admin cannot delete itself; the
    last active admin is protected; a user who still owns projects must transfer
    ownership first.
    """

    user = await _get_user(session, user_id, _t)
    _reject_superadmin_mutation(user, _t)
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail=_t("admin_cannot_delete_self"))
    if user.role == "admin" and user.is_active and await _active_admin_count(session) <= 1:
        raise HTTPException(status_code=400, detail=_t("admin_last_admin"))
    owned_project = await session.scalar(
        select(ProjectRegistry.name).where(ProjectRegistry.owner_id == user.id).limit(1)
    )
    if owned_project is not None:
        raise HTTPException(
            status_code=400,
            detail=_t("admin_project_owner_delete_forbidden", project=owned_project),
        )
    await session.delete(user)
    record_audit_event(
        session,
        actor=admin,
        action=AuditAction.USER_DELETE,
        resource_type=AuditResourceType.USER,
        resource_id=user.id,
        details={"username": user.username},
    )
    await session.commit()


@router.post("/users/{user_id}/reset-password", response_model=PasswordResponse)
async def reset_password(
    user_id: str,
    body: ResetPasswordRequest,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> PasswordResponse:
    user = await _get_user(session, user_id, _t)
    _reject_superadmin_mutation(user, _t)
    temporary_password = body.password or generate_password()
    user.password_hash = hash_password(temporary_password)
    await revoke_all_user_sessions(user.id, session=session)
    record_audit_event(
        session,
        actor=admin,
        action=AuditAction.USER_RESET_PASSWORD,
        resource_type=AuditResourceType.USER,
        resource_id=user.id,
    )
    await session.commit()
    return PasswordResponse(temporary_password=temporary_password)


@router.post("/users/{user_id}/revoke-sessions", status_code=204)
async def revoke_sessions(
    user_id: str,
    admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> None:
    user = await _get_user(session, user_id, _t)
    _reject_superadmin_mutation(user, _t)
    await revoke_all_user_sessions(user.id, session=session)
    record_audit_event(
        session,
        actor=admin,
        action=AuditAction.USER_REVOKE_SESSIONS,
        resource_type=AuditResourceType.USER,
        resource_id=user.id,
    )
    await session.commit()
