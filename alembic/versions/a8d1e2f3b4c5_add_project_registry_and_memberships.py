"""add project registry and membership access control

Revision ID: a8d1e2f3b4c5
Revises: f7c1e9d2a4b6
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a8d1e2f3b4c5"
down_revision: str | Sequence[str] | None = "f7c1e9d2a4b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_registry",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("owner_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index("idx_project_registry_owner", "project_registry", ["owner_id"], unique=False)

    op.create_table(
        "project_members",
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(), server_default="viewer", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("role IN ('owner', 'editor', 'viewer')", name="ck_project_members_role"),
        sa.ForeignKeyConstraint(["project_id"], ["project_registry.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id", "user_id"),
    )
    op.create_index("idx_project_members_user", "project_members", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_project_members_user", table_name="project_members")
    op.drop_table("project_members")
    op.drop_index("idx_project_registry_owner", table_name="project_registry")
    op.drop_table("project_registry")
