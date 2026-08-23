"""Enforce a single protected environment administrator."""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f9a0b1c2d3e4"
down_revision: str | Sequence[str] | None = "e8f9a0b1c2d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    superadmin_count = int(bind.execute(sa.text("SELECT COUNT(*) FROM users WHERE is_superadmin = TRUE")).scalar_one())
    if superadmin_count > 1:
        raise RuntimeError(
            "multiple superadmin accounts exist; keep one protected environment administrator before upgrading"
        )

    bind.exec_driver_sql("DROP INDEX IF EXISTS ix_users_is_superadmin")
    predicate = "is_superadmin" if bind.dialect.name == "postgresql" else "is_superadmin = 1"
    bind.exec_driver_sql(f"CREATE UNIQUE INDEX uq_users_single_superadmin ON users (is_superadmin) WHERE {predicate}")


def downgrade() -> None:
    op.drop_index("uq_users_single_superadmin", table_name="users")
    op.create_index("ix_users_is_superadmin", "users", ["is_superadmin"], unique=False)
