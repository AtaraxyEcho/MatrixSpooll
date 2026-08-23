"""add stable project identity to scoped records

Revision ID: d2c4e6f8a0b2
Revises: c1b3d5e7f9a1
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from lib.db.migration_helpers import preserve_sqlite_indexes

revision: str = "d2c4e6f8a0b2"
down_revision: str | Sequence[str] | None = "c1b3d5e7f9a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _add_project_id(
    table_name: str,
    index_name: str,
    foreign_key_name: str,
    *,
    ondelete: str = "SET NULL",
) -> None:
    with preserve_sqlite_indexes(table_name):
        with op.batch_alter_table(table_name, schema=None) as batch_op:
            batch_op.add_column(sa.Column("project_id", sa.String(), nullable=True))
            batch_op.create_foreign_key(
                foreign_key_name,
                "project_registry",
                ["project_id"],
                ["id"],
                ondelete=ondelete,
            )
            batch_op.create_index(index_name, ["project_id"], unique=False)


def _drop_project_id(table_name: str, index_name: str, foreign_key_name: str) -> None:
    op.drop_index(index_name, table_name=table_name)
    with preserve_sqlite_indexes(table_name):
        with op.batch_alter_table(table_name, schema=None) as batch_op:
            batch_op.drop_constraint(foreign_key_name, type_="foreignkey")
            batch_op.drop_column("project_id")


def upgrade() -> None:
    _add_project_id("tasks", "idx_tasks_project_id", "fk_tasks_project_id_registry")
    _add_project_id(
        "agent_sessions",
        "idx_agent_sessions_project_id",
        "fk_agent_sessions_project_id_registry",
        ondelete="CASCADE",
    )
    _add_project_id("api_calls", "idx_api_calls_project_id", "fk_api_calls_project_id_registry")

    for table_name in ("tasks", "agent_sessions", "api_calls"):
        op.execute(
            sa.text(
                f"UPDATE {table_name} SET project_id = "
                f"(SELECT id FROM project_registry WHERE project_registry.name = {table_name}.project_name) "
                "WHERE project_id IS NULL"
            )
        )

    bind = op.get_bind()
    unresolved = {
        table_name: int(
            bind.execute(sa.text(f"SELECT COUNT(*) FROM {table_name} WHERE project_id IS NULL")).scalar_one()
        )
        for table_name in ("tasks", "agent_sessions", "api_calls")
    }
    unresolved = {table_name: count for table_name, count in unresolved.items() if count}
    if unresolved:
        detail = ", ".join(f"{table_name}={count}" for table_name, count in unresolved.items())
        message = f"project identity migration found unregistered scoped records ({detail})"
        raise RuntimeError(f"{message}; repair project registration before upgrading")

    if "agent_sessions" not in unresolved:
        with op.batch_alter_table("agent_sessions", schema=None) as batch_op:
            batch_op.alter_column("project_id", existing_type=sa.String(), nullable=False)


def downgrade() -> None:
    _drop_project_id("api_calls", "idx_api_calls_project_id", "fk_api_calls_project_id_registry")
    _drop_project_id(
        "agent_sessions",
        "idx_agent_sessions_project_id",
        "fk_agent_sessions_project_id_registry",
    )
    _drop_project_id("tasks", "idx_tasks_project_id", "fk_tasks_project_id_registry")
