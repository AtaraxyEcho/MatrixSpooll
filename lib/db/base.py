"""SQLAlchemy declarative base."""

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# ``default`` was the identifier used by the original single-user runtime.
# It is retained only as a migration/test compatibility marker; no production
# row or ORM default may use it as an actor identity.
LEGACY_DEFAULT_USER_ID = "default"
# Import compatibility for older service signatures.  An omitted actor is an
# empty sentinel, never a database identifier.  Persistence boundaries resolve
# it to the bootstrapped UUID superadmin (or reject it outside TESTING).
DEFAULT_USER_ID = ""


class Base(DeclarativeBase):
    pass


def utc_now() -> datetime:
    return datetime.now(UTC)


def dt_to_iso(val: datetime | None) -> str | None:
    """Convert datetime to ISO string for JSON serialization."""
    return val.isoformat() if val else None


class TimestampMixin:
    """Unified created/updated timestamps."""

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class UserOwnedMixin:
    """Historical actor marker retained after account deletion."""

    user_id: Mapped[str | None] = mapped_column(
        String,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
