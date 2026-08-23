"""Link Agent transcript records to their owning session.

Project identity on transcript rows prevents cross-project reads, while this
foreign-key layer prevents orphaned rows after a session is deleted.  Existing
data is checked before constraints are installed so production upgrades fail
closed instead of silently dropping history.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | Sequence[str] | None = "c6f0a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger(__name__)

_TABLES = (
    ("agent_session_event_log", "fk_agent_event_log_session", "idx_agent_event_log_session_id"),
    ("agent_session_user_message_links", "fk_agent_message_links_session", "idx_agent_message_links_session_id"),
    ("agent_session_entries", "fk_agent_entries_session", "idx_agent_entries_session_id"),
    ("agent_session_summaries", "fk_agent_summaries_session", "idx_agent_summaries_session_id"),
)


def _orphan_counts() -> dict[str, int]:
    bind = op.get_bind()
    return {
        table: int(
            bind.execute(
                sa.text(
                    f"SELECT COUNT(*) FROM {table} records "
                    "LEFT JOIN agent_sessions sessions ON sessions.id = records.session_id "
                    "WHERE sessions.id IS NULL"
                )
            ).scalar_one()
        )
        for table, _constraint, _index in _TABLES
    }


def _report_orphans(counts: dict[str, int]) -> None:
    unresolved = {table: count for table, count in counts.items() if count}
    if not unresolved:
        return
    message = "Agent transcript rows have no matching session: " + ", ".join(
        f"{table}={count}" for table, count in unresolved.items()
    )
    raise RuntimeError(message + "; repair the rows before applying the migration")


def upgrade() -> None:
    _report_orphans(_orphan_counts())
    for table, constraint, index in _TABLES:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.create_foreign_key(
                constraint,
                "agent_sessions",
                ["session_id"],
                ["id"],
                ondelete="CASCADE",
            )
            batch_op.create_index(index, ["session_id"], unique=False)


def downgrade() -> None:
    for table, constraint, index in reversed(_TABLES):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_index(index)
            batch_op.drop_constraint(constraint, type_="foreignkey")
