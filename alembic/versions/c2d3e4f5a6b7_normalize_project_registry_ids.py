"""Normalize historical project registry primary keys to UUID values.

Display names and file-backed storage keys are separate fields.  This
migration only changes the database identity value and rewrites every foreign
key that points at ``project_registry.id`` in the same transaction.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID, uuid4

import sqlalchemy as sa

from alembic import op

revision: str = "c2d3e4f5a6b7"
down_revision: str | Sequence[str] | None = "b1c2d3e4f5a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    references: list[tuple[str, str, dict[str, object]]] = []
    for table in inspector.get_table_names():
        for foreign_key in inspector.get_foreign_keys(table):
            if foreign_key.get("referred_table") != "project_registry":
                continue
            if foreign_key.get("referred_columns") != ["id"]:
                continue
            columns = foreign_key.get("constrained_columns") or []
            if len(columns) != 1:
                continue
            references.append((table, str(foreign_key.get("name") or ""), foreign_key))

    rows = bind.execute(sa.text("SELECT id FROM project_registry")).scalars().all()
    mapping: dict[str, str] = {}
    for raw_id in rows:
        old_id = str(raw_id)
        if _is_uuid(old_id):
            mapping[old_id] = old_id
        else:
            mapping[old_id] = uuid4().hex

    changed = {old: new for old, new in mapping.items() if old != new}
    if not changed:
        return

    if bind.dialect.name == "postgresql":
        for table, constraint_name, _foreign_key in references:
            if not constraint_name:
                raise RuntimeError(f"project identity migration found unnamed foreign key on {table}")
            op.drop_constraint(constraint_name, table, type_="foreignkey")
    elif bind.dialect.name == "sqlite":
        bind.exec_driver_sql("PRAGMA foreign_keys=OFF")

    for table, _constraint_name, foreign_key in references:
        column = str((foreign_key.get("constrained_columns") or [""])[0])
        for old_id, new_id in changed.items():
            bind.execute(
                sa.text(f"UPDATE {table} SET {column} = :new_id WHERE {column} = :old_id"),
                {"new_id": new_id, "old_id": old_id},
            )

    for old_id, new_id in changed.items():
        bind.execute(
            sa.text("UPDATE project_registry SET id = :new_id WHERE id = :old_id"),
            {"new_id": new_id, "old_id": old_id},
        )

    if bind.dialect.name == "postgresql":
        for table, constraint_name, foreign_key in references:
            columns = foreign_key.get("constrained_columns") or []
            referred_columns = foreign_key.get("referred_columns") or []
            options = foreign_key.get("options") or {}
            op.create_foreign_key(
                constraint_name or None,
                table,
                "project_registry",
                columns,
                referred_columns,
                ondelete=options.get("ondelete"),
                onupdate=options.get("onupdate"),
            )
    elif bind.dialect.name == "sqlite":
        bind.exec_driver_sql("PRAGMA foreign_keys=ON")


def downgrade() -> None:
    raise RuntimeError("project UUID identity migration is irreversible; restore from a database backup instead")
