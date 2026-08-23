"""Prevent new records from silently using the retired ``default`` user."""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    ("agent_anthropic_credentials", "user_id", sa.String(length=64)),
    ("agent_session_entries", "user_id", sa.String()),
    ("agent_session_event_log", "user_id", sa.String()),
    ("agent_session_summaries", "user_id", sa.String()),
    ("agent_session_user_message_links", "user_id", sa.String()),
    ("agent_sessions", "user_id", sa.String()),
    ("api_calls", "user_id", sa.String()),
    ("api_keys", "user_id", sa.String()),
    ("tasks", "user_id", sa.String()),
)


def upgrade() -> None:
    for table, column, column_type in _COLUMNS:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column(column, existing_type=column_type, server_default=None)


def downgrade() -> None:
    # Reintroducing a public default identity would make new records ambiguous;
    # restoring it is intentionally unsupported.
    raise RuntimeError("legacy user_id defaults cannot be restored")
