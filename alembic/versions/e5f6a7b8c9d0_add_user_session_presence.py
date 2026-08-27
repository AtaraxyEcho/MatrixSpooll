"""Track recent activity for online session management.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: str | Sequence[str] | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_sessions",
        sa.Column(
            "last_seen_at", sa.DateTime(timezone=True), nullable=True, comment="Most recent authenticated activity."
        ),
    )
    op.create_index("idx_user_sessions_last_seen", "user_sessions", ["last_seen_at"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_user_sessions_last_seen", table_name="user_sessions")
    op.drop_column("user_sessions", "last_seen_at")
