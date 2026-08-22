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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lib.api_errors import BadRequestError, ForbiddenError, NotFoundError
from lib.db import async_session_factory, get_async_session
from lib.db.base import DEFAULT_USER_ID, utc_now
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
    if is_project_root or is_member_management:
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

    try:
        registry = await session.get(ProjectRegistry, project_identifier)
        if registry is None:
            registry = await session.scalar(select(ProjectRegistry).where(ProjectRegistry.name == project_identifier))
    except Exception:
        logger.exception("项目授权查询失败 project=%s", project_identifier)
        raise

    normalized_name = registry.name if registry is not None else project_identifier

    # Local development with AUTH_ENABLED=false intentionally preserves the
    # legacy single-user mode. A mini FastAPI app used by older route tests does
    # not run the application lifespan, so it has no opportunity to backfill the
    # registry; keep that isolated test mode compatible with the pre-registry
    # routes without weakening a started production application.
    legacy_uninitialized = user.id == DEFAULT_USER_ID and not database_auth_initialized()
    if (
        registry is None
        and user.id == DEFAULT_USER_ID
        and is_testing()
        and (not is_auth_enabled() or legacy_uninitialized)
    ):
        if legacy_uninitialized and is_auth_enabled():
            project_path = get_project_manager().projects_root / normalized_name
            return ProjectAccess(
                project_id=f"legacy:{normalized_name}",
                project_name=normalized_name,
                project_path=project_path,
                content_mode=None,
                generation_mode=None,
                owner_id=DEFAULT_USER_ID,
                role="owner",
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
            owner_id=DEFAULT_USER_ID,
            role="owner",
        )

    if registry is None:
        raise NotFoundError("project_not_found", name=normalized_name)

    member = await session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == registry.id,
            ProjectMember.user_id == user.id,
        )
    )
    effective_role = "owner" if user.role == "admin" else (member.role if member else None)
    if effective_role is None or ROLE_ORDER.get(effective_role, 0) < ROLE_ORDER.get(required_role, 0):
        raise ForbiddenError("project_access_denied", name=normalized_name)

    try:
        project_path = get_project_manager().get_project_path(normalized_name)
    except (FileNotFoundError, ValueError) as exc:
        raise NotFoundError("project_not_found", name=normalized_name) from exc
    project = await asyncio.to_thread(get_project_manager().load_project, normalized_name)
    return ProjectAccess(
        project_id=registry.id,
        project_name=normalized_name,
        project_path=project_path,
        content_mode=project.get("content_mode"),
        generation_mode=project.get("generation_mode"),
        owner_id=registry.owner_id,
        role=effective_role,
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
    return await resolve_project_access(registry.name, user, session, required_role=required_role)


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
    viewer, mutations editor, and project/member administration owner.
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


async def register_project(session: AsyncSession, project_name: str, owner_id: str) -> ProjectRegistry:
    """Register a newly created project and its owner in one transaction."""

    normalized_name = get_project_manager().normalize_project_name(project_name)
    existing = await session.scalar(select(ProjectRegistry).where(ProjectRegistry.name == normalized_name))
    if existing is not None:
        get_project_manager().register_project_id_alias(existing.id, existing.name)
        member = await session.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == existing.id,
                ProjectMember.user_id == existing.owner_id,
            )
        )
        if member is None:
            session.add(ProjectMember(project_id=existing.id, user_id=existing.owner_id, role="owner"))
        return existing

    now = utc_now()
    registry = ProjectRegistry(
        id=uuid4().hex,
        name=normalized_name,
        owner_id=owner_id,
        created_at=now,
        updated_at=now,
    )
    session.add(registry)
    await session.flush()
    session.add(ProjectMember(project_id=registry.id, user_id=owner_id, role="owner", created_at=now, updated_at=now))
    get_project_manager().register_project_id_alias(registry.id, registry.name)
    return registry


async def find_project_registration(session: AsyncSession, project_ref: str) -> ProjectRegistry | None:
    """Resolve a registry row from either its stable id or legacy name."""

    identifier = str(project_ref).strip()
    if not identifier:
        return None
    registry = await session.get(ProjectRegistry, identifier)
    if registry is not None:
        return registry
    normalized_name = get_project_manager().normalize_project_name(identifier)
    return await session.scalar(select(ProjectRegistry).where(ProjectRegistry.name == normalized_name))


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
                    original_dir = manager.projects_root / registry.name
                    await asyncio.to_thread(manager.restore_staged_project_deletion, original_dir, staged_dir)
                    manager.register_project_id_alias(registry.id, registry.name)
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
            owner = await session.get(User, DEFAULT_USER_ID)
            if owner is None:
                logger.warning("项目注册回填跳过：默认用户不存在")
                return 0
            for name in names:
                existing = await session.scalar(select(ProjectRegistry).where(ProjectRegistry.name == name))
                if existing is None:
                    existing = await register_project(session, name, owner.id)
                    created += 1
                else:
                    get_project_manager().register_project_id_alias(existing.id, existing.name)
                    member = await session.scalar(
                        select(ProjectMember).where(
                            ProjectMember.project_id == existing.id,
                            ProjectMember.user_id == existing.owner_id,
                        )
                    )
                    if member is None:
                        session.add(
                            ProjectMember(
                                project_id=existing.id,
                                user_id=existing.owner_id,
                                role="owner",
                            )
                        )
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
) -> list[ProjectRegistry]:
    """Return only projects visible to one user, ordered by update time."""

    stmt = select(ProjectRegistry)
    if not include_all:
        stmt = stmt.join(ProjectMember, ProjectMember.project_id == ProjectRegistry.id).where(
            ProjectMember.user_id == user_id
        )
    stmt = stmt.order_by(ProjectRegistry.updated_at.desc(), ProjectRegistry.name.asc())
    return list((await session.scalars(stmt)).all())
