"""Align Agent transcript foreign keys with the SDK-facing session ID.

``AgentSession.id`` is the internal UUID primary key.  Agent Runtime APIs and
the transcript protocol use ``sdk_session_id`` instead, so the mirror tables
must reference that unique column rather than the private UUID.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a3b4c5d6e7f8"
down_revision: str | Sequence[str] | None = "a2b3c4d5e6f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = (
    ("agent_session_event_log", "fk_agent_event_log_session"),
    ("agent_session_user_message_links", "fk_agent_message_links_session"),
    ("agent_session_entries", "fk_agent_entries_session"),
    ("agent_session_summaries", "fk_agent_summaries_session"),
)


def _has_constraint(table: str, name: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return any(item.get("name") == name for item in inspector.get_foreign_keys(table))


def _rewrite_legacy_internal_ids() -> None:
    """Convert rows written with the old private UUID locator when present."""

    bind = op.get_bind()
    for table, _constraint in _TABLES:
        bind.execute(
            sa.text(
                f"UPDATE {table} records SET session_id = sessions.sdk_session_id "
                f"FROM agent_sessions sessions WHERE records.session_id = sessions.id"
            )
            if bind.dialect.name == "postgresql"
            else sa.text(
                f"UPDATE {table} SET session_id = (SELECT sdk_session_id FROM agent_sessions "
                f"WHERE agent_sessions.id = {table}.session_id) "
                f"WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE agent_sessions.id = {table}.session_id)"
            )
        )


def _rewrite_to_internal_ids() -> None:
    bind = op.get_bind()
    for table, _constraint in _TABLES:
        bind.execute(
            sa.text(
                f"UPDATE {table} records SET session_id = sessions.id "
                f"FROM agent_sessions sessions WHERE records.session_id = sessions.sdk_session_id"
            )
            if bind.dialect.name == "postgresql"
            else sa.text(
                f"UPDATE {table} SET session_id = (SELECT id FROM agent_sessions "
                f"WHERE agent_sessions.sdk_session_id = {table}.session_id) "
                f"WHERE EXISTS (SELECT 1 FROM agent_sessions "
                f"WHERE agent_sessions.sdk_session_id = {table}.session_id)"
            )
        )


def upgrade() -> None:
    for table, constraint in _TABLES:
        if _has_constraint(table, constraint):
            with op.batch_alter_table(table, schema=None) as batch_op:
                batch_op.drop_constraint(constraint, type_="foreignkey")
    _rewrite_legacy_internal_ids()
    for table, constraint in _TABLES:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.create_foreign_key(
                constraint,
                "agent_sessions",
                ["session_id"],
                ["sdk_session_id"],
                ondelete="CASCADE",
            )


def downgrade() -> None:
    for table, constraint in _TABLES:
        if _has_constraint(table, constraint):
            with op.batch_alter_table(table, schema=None) as batch_op:
                batch_op.drop_constraint(constraint, type_="foreignkey")
    _rewrite_to_internal_ids()
    for table, constraint in reversed(_TABLES):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.create_foreign_key(
                constraint,
                "agent_sessions",
                ["session_id"],
                ["id"],
                ondelete="CASCADE",
            )
