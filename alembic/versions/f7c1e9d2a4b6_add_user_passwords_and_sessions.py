"""add database user passwords and revocable login sessions

Revision ID: f7c1e9d2a4b6
Revises: d4e6b8a1c305
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f7c1e9d2a4b6"
down_revision: str | Sequence[str] | None = "d4e6b8a1c305"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("password_hash", sa.String(), nullable=True))
        batch_op.alter_column("role", server_default="member", existing_type=sa.String(), existing_nullable=False)

    op.create_table(
        "user_sessions",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("device_id", sa.String(), nullable=False),
        sa.Column("token_id", sa.String(), nullable=False),
        sa.Column("ip_address", sa.String(), nullable=True),
        sa.Column("user_agent", sa.String(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_id"),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"], unique=False)
    op.create_index("idx_user_sessions_device", "user_sessions", ["user_id", "device_id"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_user_sessions_device", table_name="user_sessions")
    op.drop_index("ix_user_sessions_user_id", table_name="user_sessions")
    op.drop_table("user_sessions")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("password_hash")
        batch_op.alter_column("role", server_default="user", existing_type=sa.String(), existing_nullable=False)
