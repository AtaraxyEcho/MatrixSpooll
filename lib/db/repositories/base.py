"""Repository base class with query scoping support."""

from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from lib.db.base import Base
from lib.db.models.user import User


class BaseRepository:
    """Repository base class. Provides _scope_query override point."""

    def __init__(self, session: AsyncSession):
        self.session = session

    def _scope_query(self, stmt: Select, model: type[Base]) -> Select:
        """Query scope limiter. Subclasses can override to inject additional filters."""
        return stmt

    async def _actor_username(self, user_id: str) -> str | None:
        """Resolve the immutable username snapshot for a new history row."""

        return await self.session.scalar(select(User.username).where(User.id == user_id))


def rowcount(result: Any) -> int:
    """SQLAlchemy AsyncResult.rowcount 在当前 stub 中是 Any，统一在此 narrow。"""
    return result.rowcount or 0
