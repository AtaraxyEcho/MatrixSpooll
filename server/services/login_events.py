"""Authentication event recording."""

from __future__ import annotations

from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from lib.db.models.login_event import LoginEvent


class LoginOutcome(StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    RATE_LIMITED = "rate_limited"


def record_login_event(
    session: AsyncSession,
    *,
    outcome: LoginOutcome,
    endpoint: str,
    user_id: str | None = None,
    username: str | None = None,
    reason: str | None = None,
    session_id: str | None = None,
    device_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> LoginEvent:
    """Add a bounded, credential-free login event to the caller's transaction."""

    event = LoginEvent(
        user_id=user_id,
        username=username[:80] if username else None,
        outcome=outcome.value,
        reason=reason[:64] if reason else None,
        session_id=session_id[:64] if session_id else None,
        device_id=device_id[:200] if device_id else None,
        ip_address=ip_address[:45] if ip_address else None,
        user_agent=user_agent[:512] if user_agent else None,
        endpoint=endpoint[:128],
    )
    session.add(event)
    return event
