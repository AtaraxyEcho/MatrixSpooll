"""Resolve legacy actor markers to a real database user identity."""

from __future__ import annotations

import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from lib.db.base import LEGACY_DEFAULT_USER_ID
from lib.db.models.user import User


def _testing_mode_enabled() -> bool:
    return os.environ.get("TESTING", "").strip().lower() in {"1", "true", "yes", "on"}


async def resolve_actor_user_id(session: AsyncSession, user_id: str | None) -> str:
    """Return a persisted actor UUID, translating only the legacy test marker.

    Older SDK and repository call sites still pass ``default``.  Production
    must never persist that value after the identity migration, so it resolves
    to the configured superadmin UUID.  The marker remains accepted only for
    explicitly isolated tests that do not bootstrap users.
    """

    candidate = user_id or LEGACY_DEFAULT_USER_ID
    if candidate != LEGACY_DEFAULT_USER_ID:
        return candidate

    superadmin_id = await session.scalar(select(User.id).where(User.is_superadmin.is_(True)).limit(1))
    if superadmin_id:
        return superadmin_id

    if _testing_mode_enabled():
        return LEGACY_DEFAULT_USER_ID

    raise RuntimeError("actor user UUID is required; database superadmin bootstrap is incomplete")


__all__ = ["resolve_actor_user_id"]
