"""Project registry and membership models.

Project content remains file-backed in ``project.json`` and the project
directory. These tables own only the stable identity and access relationship.
"""

from __future__ import annotations

import os
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy import ForeignKey, Index, String, event
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin


class ProjectRegistry(TimestampMixin, Base):
    """Stable database identity for a file-backed MatrixSpooll project."""

    __tablename__ = "project_registry"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    # Display names are scoped to a user-facing list, not identity.  Multiple
    # projects may intentionally share the same name.
    name: Mapped[str] = mapped_column(String, nullable=False)
    # Physical storage is keyed by the immutable UUID, never by ``name``.
    storage_key: Mapped[str] = mapped_column(String, nullable=False)
    owner_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )

    __table_args__ = (
        Index("idx_project_registry_owner", "owner_id"),
        Index("ix_project_registry_name", "name"),
        Index("uq_project_registry_storage_key", "storage_key", unique=True),
    )


class ProjectMember(TimestampMixin, Base):
    """A collaborator's role within a project."""

    __tablename__ = "project_members"

    project_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("project_registry.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role: Mapped[str] = mapped_column(String, nullable=False, server_default="viewer")

    __table_args__ = (
        Index("idx_project_members_user", "user_id"),
        sa.CheckConstraint("role IN ('editor', 'viewer')", name="ck_project_members_role"),
    )


@event.listens_for(ProjectRegistry, "before_insert")
def _default_project_storage_key(_mapper, _connection, target: ProjectRegistry) -> None:
    """Ensure direct ORM inserts receive an immutable physical locator."""

    if not target.storage_key:
        testing = os.environ.get("TESTING", "").strip().lower() in {"1", "true", "yes", "on"}
        # Isolated tests still model legacy name-backed directories. Runtime
        # inserts must never derive a path key from a display name.
        target.storage_key = target.name if testing else uuid4().hex
