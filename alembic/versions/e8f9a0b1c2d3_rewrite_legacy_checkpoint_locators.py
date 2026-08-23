"""Rewrite persisted task checkpoint paths after the runtime directory rename."""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e8f9a0b1c2d3"
down_revision: str | Sequence[str] | None = "d3e4f5a6b7c8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    # Keep the rewrite scoped to the checkpoint column.  Other JSON payloads
    # may legitimately mention historical paths and must remain auditable.
    for legacy in (".arcreel", ".arcreel-runtime", ".arcreel-data"):
        bind.execute(
            sa.text(
                "UPDATE tasks SET execution_checkpoint_json = "
                "REPLACE(execution_checkpoint_json, :legacy, '.matrixspooll') "
                "WHERE execution_checkpoint_json LIKE :pattern"
            ),
            {"legacy": legacy, "pattern": f"%{legacy}/tasks/%"},
        )


def downgrade() -> None:
    raise RuntimeError("runtime checkpoint locator migration is irreversible")
