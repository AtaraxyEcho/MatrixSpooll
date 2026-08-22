"""Add stable project identity to Agent transcript records.

Revision ID: e7f9a1c3d5b7
Revises: d2c4e6f8a0b2

The SDK transcript tables retain ``project_key`` as an external SDK key, but
project ownership is resolved through the stable ``project_id`` on the
registered Agent session.  Existing rows are backfilled by ``session_id``.
Rows that cannot be mapped are reported; production upgrades fail closed so
an operator must repair the orphan before enabling the new schema.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e7f9a1c3d5b7"
down_revision: str | Sequence[str] | None = "d2c4e6f8a0b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger(__name__)

_TABLES = (
    "agent_session_event_log",
    "agent_session_user_message_links",
    "agent_session_entries",
    "agent_session_summaries",
)


def _add_project_id(table_name: str, index_name: str, foreign_key_name: str) -> None:
    with op.batch_alter_table(table_name, schema=None) as batch_op:
        batch_op.add_column(sa.Column("project_id", sa.String(), nullable=True))
        batch_op.create_foreign_key(
            foreign_key_name,
            "project_registry",
            ["project_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch_op.create_index(index_name, ["project_id"], unique=False)


def _drop_project_id(table_name: str, index_name: str, foreign_key_name: str) -> None:
    with op.batch_alter_table(table_name, schema=None) as batch_op:
        batch_op.drop_index(index_name)
        batch_op.drop_constraint(foreign_key_name, type_="foreignkey")
        batch_op.drop_column("project_id")


def _backfill(table_name: str) -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            f"UPDATE {table_name} SET project_id = "
            f"(SELECT project_id FROM agent_sessions "
            f"WHERE agent_sessions.id = {table_name}.session_id) "
            "WHERE project_id IS NULL"
        )
    )


def _unresolved_counts() -> dict[str, int]:
    bind = op.get_bind()
    return {
        table_name: int(
            bind.execute(sa.text(f"SELECT COUNT(*) FROM {table_name} WHERE project_id IS NULL")).scalar_one()
        )
        for table_name in _TABLES
    }


def _preflight_unresolved_counts() -> dict[str, int]:
    """Count rows whose session cannot provide a registered project identity."""

    bind = op.get_bind()
    return {
        table_name: int(
            bind.execute(
                sa.text(
                    f"SELECT COUNT(*) FROM {table_name} "
                    "LEFT JOIN agent_sessions ON agent_sessions.id = "
                    f"{table_name}.session_id "
                    "WHERE agent_sessions.id IS NULL OR agent_sessions.project_id IS NULL"
                )
            ).scalar_one()
        )
        for table_name in _TABLES
    }


def _report_unresolved(unresolved: dict[str, int], *, phase: str) -> None:
    if not unresolved:
        return
    detail = ", ".join(f"{table}={count}" for table, count in unresolved.items())
    message = (
        "project identity migration found Agent records without a registered "
        f"session during {phase} ({detail}); repair these rows before production startup"
    )
    if os.environ.get("TESTING", "").strip().lower() in {"1", "true", "yes", "on"}:
        logger.warning(message)
    else:
        raise RuntimeError(message)


def _enforce_project_identity() -> None:
    """Make project identity mandatory after a clean backfill."""

    for table_name in _TABLES:
        with op.batch_alter_table(table_name, schema=None) as batch_op:
            batch_op.alter_column(
                "project_id",
                existing_type=sa.String(),
                nullable=False,
            )


def upgrade() -> None:
    _report_unresolved(
        {table: count for table, count in _preflight_unresolved_counts().items() if count},
        phase="preflight",
    )

    _add_project_id(
        "agent_session_event_log",
        "idx_agent_event_log_project_id",
        "fk_agent_event_log_project_id_registry",
    )
    _add_project_id(
        "agent_session_user_message_links",
        "idx_agent_message_links_project_id",
        "fk_agent_message_links_project_id_registry",
    )
    _add_project_id(
        "agent_session_entries",
        "idx_agent_entries_project_id",
        "fk_agent_entries_project_id_registry",
    )
    _add_project_id(
        "agent_session_summaries",
        "idx_agent_summaries_project_id",
        "fk_agent_summaries_project_id_registry",
    )

    for table_name in _TABLES:
        _backfill(table_name)

    unresolved = {table: count for table, count in _unresolved_counts().items() if count}
    _report_unresolved(unresolved, phase="backfill")
    if not unresolved:
        _enforce_project_identity()


def downgrade() -> None:
    _drop_project_id(
        "agent_session_summaries",
        "idx_agent_summaries_project_id",
        "fk_agent_summaries_project_id_registry",
    )
    _drop_project_id(
        "agent_session_entries",
        "idx_agent_entries_project_id",
        "fk_agent_entries_project_id_registry",
    )
    _drop_project_id(
        "agent_session_user_message_links",
        "idx_agent_message_links_project_id",
        "fk_agent_message_links_project_id_registry",
    )
    _drop_project_id(
        "agent_session_event_log",
        "idx_agent_event_log_project_id",
        "fk_agent_event_log_project_id_registry",
    )
