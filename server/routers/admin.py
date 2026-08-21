"""Administrator user-management routes."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from lib.db import get_async_session
from lib.db.base import DEFAULT_USER_ID
from lib.db.models.project import ProjectRegistry
from lib.db.models.user import User
from lib.i18n import Translator
from server.auth import AdminUser, generate_password, hash_password, revoke_all_user_sessions

router = APIRouter(prefix="/admin", tags=["管理员"])


class AdminUserSummary(BaseModel):
    id: str
    username: str
    role: Literal["admin", "member"]
    is_superadmin: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str | None = Field(default=None, min_length=8, max_length=200)
    role: Literal["admin", "member"] = "member"


class UpdateUserRequest(BaseModel):
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


def _normalize_username(value: str) -> str:
    return " ".join(value.strip().split())


def _as_summary(user: User) -> AdminUserSummary:
    role = user.role if user.role in {"admin", "member"} else "member"
    return AdminUserSummary(
        id=user.id,
        username=user.username,
        role=role,  # type: ignore[arg-type]
        is_superadmin=user.id == DEFAULT_USER_ID,
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
    if user.id == DEFAULT_USER_ID:
        raise HTTPException(status_code=403, detail=translate("admin_superadmin_protected"))


@router.get("/users", response_model=AdminUsersResponse)
async def list_users(
    _admin: AdminUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    session: AsyncSession = Depends(get_async_session),
) -> AdminUsersResponse:
    total_result = await session.execute(select(func.count()).select_from(User))
    total = int(total_result.scalar_one())
    result = await session.execute(
        select(User).order_by(User.created_at.asc()).offset((page - 1) * page_size).limit(page_size)
    )
    return AdminUsersResponse(
        users=[_as_summary(user) for user in result.scalars()],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/users", response_model=CreateUserResponse, status_code=201)
async def create_user(
    body: CreateUserRequest,
    _admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> CreateUserResponse:
    username = _normalize_username(body.username)
    if not username:
        raise HTTPException(status_code=422, detail=_t("admin_username_required"))
    existing = await session.execute(select(User).where(User.username == username))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail=_t("admin_user_exists"))

    temporary_password = body.password or generate_password()
    user = User(
        id=uuid4().hex,
        username=username,
        password_hash=hash_password(temporary_password),
        role=body.role,
        is_active=True,
    )
    session.add(user)
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

    user.role = next_role
    user.is_active = next_active
    await session.commit()
    await session.refresh(user)
    if not user.is_active:
        await revoke_all_user_sessions(user.id)
    return _as_summary(user)


@router.post("/users/{user_id}/reset-password", response_model=PasswordResponse)
async def reset_password(
    user_id: str,
    body: ResetPasswordRequest,
    _admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> PasswordResponse:
    user = await _get_user(session, user_id, _t)
    _reject_superadmin_mutation(user, _t)
    temporary_password = body.password or generate_password()
    user.password_hash = hash_password(temporary_password)
    await session.commit()
    await revoke_all_user_sessions(user.id)
    return PasswordResponse(temporary_password=temporary_password)


@router.post("/users/{user_id}/revoke-sessions", status_code=204)
async def revoke_sessions(
    user_id: str,
    _admin: AdminUser,
    _t: Translator,
    session: AsyncSession = Depends(get_async_session),
) -> None:
    user = await _get_user(session, user_id, _t)
    _reject_superadmin_mutation(user, _t)
    await revoke_all_user_sessions(user.id)
