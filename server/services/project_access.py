"""Project identity, membership, and request authorization.

The project directory remains the content store. This module is the single
authorization seam used by project-scoped routes and data queries.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from lib.api_errors import BadRequestError, ForbiddenError, NotFoundError
from lib.db import async_session_factory, get_async_session
from lib.db.base import LEGACY_DEFAULT_USER_ID, utc_now
from lib.db.models.project import ProjectMember, ProjectRegistry
from lib.db.models.user import User
from lib.db.project_identity import backfill_project_record_ids
from lib.project_manager import get_project_manager
from server.auth import CurrentUser, CurrentUserFlexible, database_auth_initialized, is_auth_enabled, is_testing

logger = logging.getLogger(__name__)

ROLE_ORDER = {"viewer": 10, "editor": 20, "owner": 30}
READ_ONLY_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True, slots=True)
class ProjectAccess:
    """Resolved project context returned by the authorization seam."""

    project_id: str
    project_name: str
    project_path: Path
    content_mode: str | None
    generation_mode: str | None
    owner_id: str
    role: str
    # Physical project directory key. Legacy/test access may omit it and use
    # the display name as the historical directory locator.
    storage_key: str | None = None


def _required_role(request: Request, project_name: str) -> str:
    """Map an HTTP request to the minimum project role it may mutate."""

    if request.method in READ_ONLY_METHODS:
        return "viewer"

    path = request.url.path.rstrip("/")
    # These POST endpoints only calculate data or issue a download token. They
    # do not mutate project content and are intentionally readable by viewers.
    if path.endswith(("/workflow-plan", "/export/token", "/script-preview")):
        return "viewer"

    segments = [segment for segment in request.url.path.split("/") if segment]
    try:
        project_index = segments.index("projects")
    except ValueError:
        return "editor"

    is_project_root = len(segments) == project_index + 2
    is_member_management = len(segments) > project_index + 2 and segments[project_index + 2] == "members"
    if is_member_management or (is_project_root and request.method == "DELETE"):
        return "owner"
    return "editor"


async def resolve_project_access(
    project_name: str,
    user,
    session: AsyncSession,
    *,
    required_role: str = "viewer",
) -> ProjectAccess:
    """Resolve and authorize one project for a user."""

    try:
        project_identifier = get_project_manager().normalize_project_name(project_name)
    except ValueError as exc:
        raise BadRequestError("invalid_project_name") from exc

    registry_unavailable_in_testing = False
    try:
        registry = await session.get(ProjectRegistry, project_identifier)
    except OperationalError:
        # Older isolated route tests intentionally omit the registry schema.
        # This compatibility path is gated by TESTING and the legacy actor;
        # a real deployment still fails closed when its database is unusable.
        if not (is_testing() and user.id == LEGACY_DEFAULT_USER_ID):
            logger.exception("项目授权查询失败 project=%s", project_identifier)
            raise
        registry = None
        registry_unavailable_in_testing = True

    resolved_by_name = False
    if registry is None and not registry_unavailable_in_testing:
        registry = await session.scalar(
            select(ProjectRegistry).where(ProjectRegistry.storage_key == project_identifier)
        )

    normalized_name = registry.name if registry is not None else project_identifier

    if registry is None and not registry_unavailable_in_testing:
        matches = list(
            (await session.scalars(select(ProjectRegistry).where(ProjectRegistry.name == project_identifier))).all()
        )
        if len(matches) > 1 and user.role != "admin":
            project_ids = [candidate.id for candidate in matches]
            member_project_ids = set(
                (
                    await session.scalars(
                        select(ProjectMember.project_id).where(
                            ProjectMember.user_id == user.id,
                            ProjectMember.project_id.in_(project_ids),
                        )
                    )
                ).all()
            )
            matches = [
                candidate
                for candidate in matches
                if candidate.owner_id == user.id or candidate.id in member_project_ids
            ]
        if len(matches) > 1:
            raise BadRequestError("project_identifier_ambiguous", name=project_identifier)
        registry = matches[0] if matches else None
        resolved_by_name = registry is not None
        normalized_name = registry.name if registry is not None else project_identifier

    # Local development with AUTH_ENABLED=false intentionally preserves the
    # legacy single-user mode. A mini FastAPI app used by older route tests does
    # not run the application lifespan, so it has no opportunity to backfill the
    # registry; keep that isolated test mode compatible with the pre-registry
    # routes without weakening a started production application.
    legacy_uninitialized = user.id == LEGACY_DEFAULT_USER_ID and not database_auth_initialized()
    if (
        registry is None
        and user.id == LEGACY_DEFAULT_USER_ID
        and is_testing()
        and (not is_auth_enabled() or legacy_uninitialized or registry_unavailable_in_testing)
    ):
        if legacy_uninitialized and is_auth_enabled():
            project_path = get_project_manager().projects_root / normalized_name
            return ProjectAccess(
                project_id=f"legacy:{normalized_name}",
                project_name=normalized_name,
                project_path=project_path,
                content_mode=None,
                generation_mode=None,
                owner_id=LEGACY_DEFAULT_USER_ID,
                role="owner",
                storage_key=normalized_name,
            )
        try:
            project_path = get_project_manager().get_project_path(normalized_name)
        except (FileNotFoundError, ValueError) as exc:
            raise NotFoundError("project_not_found", name=normalized_name) from exc
        project = await asyncio.to_thread(get_project_manager().load_project, normalized_name)
        return ProjectAccess(
            project_id=f"legacy:{normalized_name}",
            project_name=normalized_name,
            project_path=project_path,
            content_mode=project.get("content_mode"),
            generation_mode=project.get("generation_mode"),
            owner_id=LEGACY_DEFAULT_USER_ID,
            role="owner",
            storage_key=normalized_name,
        )

    if registry is None:
        raise NotFoundError("project_not_found", name=normalized_name)

    if resolved_by_name:
        manager = get_project_manager()
        register_name_alias = getattr(manager, "register_project_name_alias", None)
        if callable(register_name_alias):
            register_name_alias(registry.name, registry.storage_key)

    member = await session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == registry.id,
            ProjectMember.user_id == user.id,
        )
    )
    if user.is_superadmin or registry.owner_id == user.id:
        effective_role = "owner"
    elif user.role == "admin":
        # 普通管理员（非超管）对所有项目只读：可查看，不可写、不可成员管理。
        effective_role = "viewer"
    else:
        effective_role = member.role if member else None
    if effective_role is None or ROLE_ORDER.get(effective_role, 0) < ROLE_ORDER.get(required_role, 0):
        raise ForbiddenError("project_access_denied", name=normalized_name)

    try:
        project_path = get_project_manager().get_project_path(registry.storage_key)
    except (FileNotFoundError, ValueError) as exc:
        raise NotFoundError("project_not_found", name=normalized_name) from exc
    project = await asyncio.to_thread(get_project_manager().load_project, registry.storage_key)
    return ProjectAccess(
        project_id=registry.id,
        project_name=normalized_name,
        project_path=project_path,
        content_mode=project.get("content_mode"),
        generation_mode=project.get("generation_mode"),
        owner_id=registry.owner_id,
        role=effective_role,
        storage_key=registry.storage_key,
    )


async def resolve_project_access_by_id(
    project_id: str,
    user,
    session: AsyncSession,
    *,
    required_role: str = "viewer",
) -> ProjectAccess:
    """Resolve a project by its immutable registry id."""

    registry = await session.get(ProjectRegistry, project_id)
    if registry is None:
        raise NotFoundError("project_not_found", id=project_id)
    return await resolve_project_access(registry.id, user, session, required_role=required_role)


async def require_project_request_access(
    request: Request,
    user: CurrentUser,
    project_name: str | None = None,
    name: str | None = None,
    session: AsyncSession = Depends(get_async_session),
) -> ProjectAccess | None:
    """Authorize any route carrying a ``project_name`` or ``name`` path value.

    Routers also contain global endpoints such as ``/projects`` and ``/tasks``;
    those are intentionally skipped here and use their own user/project list
    query. The HTTP method provides a conservative default: reads require
    viewer, mutations require editor, and deletion/member administration
    require owner.
    """

    target = project_name or name
    if not target:
        return None
    return await resolve_project_access(target, user, session, required_role=_required_role(request, target))


async def require_project_flexible_access(
    request: Request,
    user: CurrentUserFlexible,
    project_name: str | None = None,
    name: str | None = None,
    session: AsyncSession = Depends(get_async_session),
) -> ProjectAccess | None:
    """Authorization equivalent for browser-native SSE/download routes."""

    target = project_name or name
    if not target:
        return None
    return await resolve_project_access(target, user, session, required_role=_required_role(request, target))


async def register_project(
    session: AsyncSession,
    project_name: str,
    owner_id: str,
    *,
    storage_key: str | None = None,
) -> ProjectRegistry:
    """Register a newly created project and its owner."""

    normalized_name = get_project_manager().normalize_project_name(project_name)
    now = utc_now()
    # The database identity is always a generated UUID.  ``storage_key`` is
    # only the physical directory locator and may intentionally retain a
    # legacy display-name path during backfill.
    project_id = uuid4().hex
    registry = ProjectRegistry(
        id=project_id,
        name=normalized_name,
        storage_key=storage_key or project_id,
        owner_id=owner_id,
        created_at=now,
        updated_at=now,
    )
    session.add(registry)
    await session.flush()
    get_project_manager().register_project_id_alias(registry.id, registry.name, registry.storage_key)
    return registry


async def find_project_registration(session: AsyncSession, project_ref: str) -> ProjectRegistry | None:
    """Resolve a registry row from its stable ID, storage key, or display name."""

    identifier = str(project_ref).strip()
    if not identifier:
        return None
    registry = await session.get(ProjectRegistry, identifier)
    if registry is not None:
        return registry
    registry = await session.scalar(select(ProjectRegistry).where(ProjectRegistry.storage_key == identifier))
    if registry is not None:
        return registry
    normalized_name = get_project_manager().normalize_project_name(identifier)
    matches = list(
        (await session.scalars(select(ProjectRegistry).where(ProjectRegistry.name == normalized_name))).all()
    )
    if len(matches) > 1:
        raise BadRequestError("project_identifier_ambiguous", name=normalized_name)
    return matches[0] if matches else None


async def remove_project_registration(session: AsyncSession, project_ref: str) -> None:
    """Remove a registry row after its project directory is staged for deletion."""

    registry = await find_project_registration(session, project_ref)
    if registry is not None:
        get_project_manager().remove_project_id_alias(registry.id)
        await session.delete(registry)


async def reconcile_staged_project_deletions() -> int:
    """Restore or finish project deletions interrupted by process termination."""

    manager = get_project_manager()
    staged = await asyncio.to_thread(manager.list_staged_project_deletions)
    reconciled = 0
    if staged:
        async with async_session_factory() as session:
            for staged_dir, project_name, project_id in staged:
                registry = await find_project_registration(session, project_id or project_name)
                if registry is None:
                    await asyncio.to_thread(manager.finalize_staged_project_deletion, staged_dir)
                    logger.warning("completed interrupted project deletion project=%s", project_name)
                else:
                    original_dir = manager.projects_root / registry.storage_key
                    await asyncio.to_thread(manager.restore_staged_project_deletion, original_dir, staged_dir)
                    manager.register_project_id_alias(registry.id, registry.name, registry.storage_key)
                    logger.warning("restored interrupted project deletion project=%s", registry.name)
                reconciled += 1

    for project_name in await asyncio.to_thread(manager.list_projects):
        marker = manager.projects_root / project_name / manager.DELETION_MARKER_FILE
        if marker.exists():
            await asyncio.to_thread(marker.unlink, missing_ok=True)
    return reconciled


async def backfill_project_registry() -> int:
    """Register file-backed projects that predate project-level isolation."""

    names = await asyncio.to_thread(get_project_manager().list_projects)
    if not names:
        return 0

    created = 0
    async with async_session_factory() as session:
        async with session.begin():
            owner = await session.scalar(select(User).where(User.is_superadmin.is_(True)).limit(1))
            if owner is None:
                logger.warning("项目注册回填跳过：默认用户不存在")
                return 0
            for name in names:
                # Prefer the immutable storage locator.  Falling back to a
                # display-name lookup is safe only when that name is unique.
                existing = await session.scalar(select(ProjectRegistry).where(ProjectRegistry.storage_key == name))
                if existing is None:
                    matches = list(
                        (await session.scalars(select(ProjectRegistry).where(ProjectRegistry.name == name))).all()
                    )
                    if len(matches) > 1:
                        raise ValueError(f"project registry backfill is ambiguous; storage key required: {name}")
                    existing = matches[0] if matches else None
                if existing is None:
                    # These directories predate UUID-backed storage. Preserve
                    # their physical locator during backfill; only newly
                    # created/imported projects are allocated UUID directories.
                    existing = await register_project(session, name, owner.id, storage_key=name)
                    created += 1
                else:
                    get_project_manager().register_project_id_alias(existing.id, existing.name, existing.storage_key)
            linked_records = await backfill_project_record_ids(session)
    if created:
        logger.info("项目注册回填完成：新增 %d 个项目", created)
    if linked_records:
        logger.info("项目记录身份回填完成：关联 %d 条记录", linked_records)
    return created


async def list_accessible_projects(
    user_id: str,
    session: AsyncSession,
    *,
    include_all: bool = False,
    name_query: str | None = None,
    offset: int | None = None,
    limit: int | None = None,
) -> list[ProjectRegistry]:
    """Return only projects visible to one user, ordered by update time."""

    stmt = select(ProjectRegistry)
    if not include_all:
        stmt = (
            stmt.outerjoin(ProjectMember, ProjectMember.project_id == ProjectRegistry.id)
            .where(or_(ProjectRegistry.owner_id == user_id, ProjectMember.user_id == user_id))
            .distinct()
        )
    if name_query:
        stmt = stmt.where(ProjectRegistry.name.ilike(f"%{name_query}%"))
    stmt = stmt.order_by(ProjectRegistry.updated_at.desc(), ProjectRegistry.name.asc())
    if offset is not None:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit)
    return list((await session.scalars(stmt)).all())


async def count_accessible_projects(
    user_id: str,
    session: AsyncSession,
    *,
    include_all: bool = False,
    name_query: str | None = None,
) -> int:
    """Count visible registry rows without touching file-backed projects."""

    stmt = select(func.count(func.distinct(ProjectRegistry.id)))
    if not include_all:
        stmt = stmt.outerjoin(ProjectMember, ProjectMember.project_id == ProjectRegistry.id).where(
            or_(ProjectRegistry.owner_id == user_id, ProjectMember.user_id == user_id)
        )
    if name_query:
        stmt = stmt.where(ProjectRegistry.name.ilike(f"%{name_query}%"))
    return int((await session.scalar(stmt)) or 0)
