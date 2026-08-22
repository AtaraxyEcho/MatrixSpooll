"""Stable project identity helpers for project-scoped audit records."""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from lib.agent_session_store.models import AgentSessionEntry, AgentSessionSummary
from lib.db.models.api_call import ApiCall
from lib.db.models.project import ProjectRegistry
from lib.db.models.session import AgentSession
from lib.db.models.session_event import AgentSessionEventLogEntry
from lib.db.models.session_message_link import AgentSessionUserMessageLink
from lib.db.models.task import Task


async def resolve_project_id(session: AsyncSession, project_name: str) -> str | None:
    """Resolve a file-backed project name to its stable registry ID."""

    return await session.scalar(select(ProjectRegistry.id).where(ProjectRegistry.name == project_name))


async def backfill_project_record_ids(session: AsyncSession) -> int:
    """Attach registered project IDs to all legacy project-scoped records.

    Agent transcript rows retain their SDK ``project_key`` for compatibility,
    but their authoritative project identity is inherited from
    ``agent_sessions`` through ``session_id``.
    """

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

    for model in (
        AgentSessionEventLogEntry,
        AgentSessionUserMessageLink,
        AgentSessionEntry,
        AgentSessionSummary,
    ):
        session_project_id = (
            select(AgentSession.project_id)
            .where(AgentSession.id == model.session_id)
            .correlate(model)
            .scalar_subquery()
        )
        result = await session.execute(
            update(model)
            .where(model.project_id.is_(None), session_project_id.is_not(None))
            .values(project_id=session_project_id)
        )
        affected += int(getattr(result, "rowcount", 0) or 0)
    return affected


__all__ = ["backfill_project_record_ids", "resolve_project_id"]
