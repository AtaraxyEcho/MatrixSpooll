"""Administrative audit event model."""

from __future__ import annotations

from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, utc_now


class AuditEvent(Base):
    """Append-only record of a privileged action."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    actor_user_id: Mapped[str | None] = mapped_column(
        String,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    actor_username: Mapped[str | None] = mapped_column(String, nullable=True)
    action: Mapped[str] = mapped_column(String(128), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    project_id: Mapped[str | None] = mapped_column(
        String,
        ForeignKey("project_registry.id", ondelete="SET NULL"),
        nullable=True,
    )
    project_name: Mapped[str | None] = mapped_column(String, nullable=True)
    details: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False, default=dict, server_default=text("'{}'"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=sa.func.now(),
    )

    __table_args__ = (
        Index("idx_audit_events_actor_created", "actor_user_id", "created_at"),
        Index("idx_audit_events_project_created", "project_id", "created_at"),
        Index("idx_audit_events_action_created", "action", "created_at"),
    )
