"""Scope active task uniqueness and admission indexes by stable project ID."""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d3e4f5a6b7c8"
down_revision: str | Sequence[str] | None = "c2d3e4f5a6b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _backfill_task_project_ids(bind: sa.Connection) -> None:
    if bind.dialect.name == "postgresql":
        bind.execute(
            sa.text(
                """
                UPDATE tasks AS tasks
                SET project_id = projects.id
                FROM project_registry AS projects
                WHERE tasks.project_id IS NULL
                  AND projects.name = tasks.project_name
                  AND (
                      SELECT COUNT(*) FROM project_registry AS matches
                      WHERE matches.name = tasks.project_name
                  ) = 1
                """
            )
        )
    else:
        bind.execute(
            sa.text(
                """
                UPDATE tasks
                SET project_id = (
                    SELECT projects.id FROM project_registry AS projects
                    WHERE projects.name = tasks.project_name
                )
                WHERE project_id IS NULL
                  AND (
                      SELECT COUNT(*) FROM project_registry AS matches
                      WHERE matches.name = tasks.project_name
                  ) = 1
                """
            )
        )

    unresolved_active = int(
        bind.execute(
            sa.text(
                "SELECT COUNT(*) FROM tasks WHERE project_id IS NULL AND status IN ('queued', 'running', 'cancelling')"
            )
        ).scalar_one()
    )
    if unresolved_active:
        raise RuntimeError(
            f"cannot scope {unresolved_active} active task(s) to a project_id; "
            "resolve project_registry names before upgrading"
        )


def upgrade() -> None:
    bind = op.get_bind()
    _backfill_task_project_ids(bind)

    bind.exec_driver_sql("DROP INDEX IF EXISTS idx_tasks_dedupe_active")
    bind.exec_driver_sql("DROP INDEX IF EXISTS idx_tasks_project_updated_at")
    bind.exec_driver_sql(
        """
        CREATE UNIQUE INDEX idx_tasks_dedupe_active
        ON tasks (
            COALESCE(project_id, project_name),
            task_type,
            resource_id,
            COALESCE(script_file, ''),
            COALESCE(resource_type, '')
        )
        WHERE status IN ('queued', 'running', 'cancelling')
        """
    )
    bind.exec_driver_sql("CREATE INDEX idx_tasks_project_updated_at ON tasks (project_id, updated_at)")


def downgrade() -> None:
    raise RuntimeError("task dedupe identity migration is irreversible; restore a database backup instead")
