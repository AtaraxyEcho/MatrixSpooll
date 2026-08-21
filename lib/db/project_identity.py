"""Stable project identity helpers for project-scoped audit records."""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from lib.db.models.api_call import ApiCall
from lib.db.models.project import ProjectRegistry
from lib.db.models.session import AgentSession
from lib.db.models.task import Task


async def resolve_project_id(session: AsyncSession, project_name: str) -> str | None:
    """Resolve a file-backed project name to its stable registry ID."""

    return await session.scalar(select(ProjectRegistry.id).where(ProjectRegistry.name == project_name))


async def backfill_project_record_ids(session: AsyncSession) -> int:
    """Attach registered project IDs to legacy task, session, and usage rows."""

    affected = 0
    for model in (Task, AgentSession, ApiCall):
        project_id = (
            select(ProjectRegistry.id)
            .where(ProjectRegistry.name == model.project_name)
            .correlate(model)
            .scalar_subquery()
        )
        result = await session.execute(
            update(model).where(model.project_id.is_(None), project_id.is_not(None)).values(project_id=project_id)
        )
        affected += int(getattr(result, "rowcount", 0) or 0)
    return affected


__all__ = ["backfill_project_record_ids", "resolve_project_id"]
