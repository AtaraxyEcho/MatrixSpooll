"""Append-only audit recording for privileged actions."""

from __future__ import annotations

from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from lib.db.models.audit import AuditEvent
from server.auth import CurrentUserInfo


class AuditAction(StrEnum):
    """Stable identifiers for privileged actions."""

    USER_CREATE = "system.users.create"
    USER_UPDATE = "system.users.update"
    USER_RESET_PASSWORD = "system.users.reset_password"
    USER_REVOKE_SESSIONS = "system.users.revoke_sessions"
    SESSION_REVOKE = "system.sessions.revoke"
    TASK_CANCEL = "system.tasks.cancel"
    TASK_RETRY = "system.tasks.retry"
    API_KEY_CREATE = "system.api_keys.create"
    API_KEY_REVOKE = "system.api_keys.revoke"
    PROJECT_CREATE = "project.create"
    PROJECT_IMPORT = "project.import"
    PROJECT_MEMBER_ADD = "project.members.add"
    PROJECT_MEMBER_UPDATE = "project.members.update"
    PROJECT_MEMBER_REMOVE = "project.members.remove"
    PROJECT_TRANSFER = "project.transfer"
    PROJECT_DELETE = "project.delete"


class AuditResourceType(StrEnum):
    """Stable resource categories used by audit events."""

    USER = "user"
    API_KEY = "api_key"
    PROJECT = "project"
    PROJECT_MEMBER = "project_member"
    SESSION = "session"
    TASK = "task"


def record_audit_event(
    session: AsyncSession,
    *,
    actor: CurrentUserInfo,
    action: AuditAction,
    resource_type: AuditResourceType,
    resource_id: str | None = None,
    project_id: str | None = None,
    project_name: str | None = None,
    details: dict[str, object] | None = None,
) -> AuditEvent:
    """Add a sanitized audit event to the caller's transaction."""

    event = AuditEvent(
        actor_user_id=actor.id,
        actor_username=actor.sub,
        action=action.value,
        resource_type=resource_type.value,
        resource_id=resource_id,
        project_id=project_id,
        project_name=project_name,
        details=details or {},
    )
    session.add(event)
    return event
