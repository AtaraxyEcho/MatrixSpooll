"""Add lookup indexes used by the UUID identity and admin checks."""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _index_names(table: str) -> set[str]:
    return {str(item["name"]) for item in sa.inspect(op.get_bind()).get_indexes(table) if item.get("name")}


def upgrade() -> None:
    existing = _index_names("project_registry")
    if "ix_project_registry_name" not in existing:
        op.create_index("ix_project_registry_name", "project_registry", ["name"], unique=False)
    existing = _index_names("users")
    if "ix_users_is_superadmin" not in existing:
        op.create_index("ix_users_is_superadmin", "users", ["is_superadmin"], unique=False)


def downgrade() -> None:
    for table, index in (("users", "ix_users_is_superadmin"), ("project_registry", "ix_project_registry_name")):
        if index in _index_names(table):
            op.drop_index(index, table_name=table)
