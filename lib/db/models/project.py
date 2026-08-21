"""Project registry and membership models.

Project content remains file-backed in ``project.json`` and the project
directory. These tables own only the stable identity and access relationship.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin


class ProjectRegistry(TimestampMixin, Base):
    """Stable database identity for a file-backed ArcReel project."""

    __tablename__ = "project_registry"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    owner_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )

    __table_args__ = (Index("idx_project_registry_owner", "owner_id"),)


class ProjectMember(TimestampMixin, Base):
    """A user's role within a project."""

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
        sa.CheckConstraint("role IN ('owner', 'editor', 'viewer')", name="ck_project_members_role"),
    )
