"""Harden user/project identity without breaking existing records.

The migration is deliberately additive: display names are no longer unique,
project storage gets an immutable key, and the legacy ``default`` account is
renamed to a generated UUID while all known foreign-key columns are updated in
the same transaction.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision: str = "c6f0a1b2c3d4"
down_revision: str | Sequence[str] | None = "b5e7f9a1c3d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEGACY_USER_ID = "default"


def _has_column(table: str, column: str) -> bool:
    return any(item["name"] == column for item in sa.inspect(op.get_bind()).get_columns(table))


def _drop_project_name_constraint() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for constraint in inspector.get_unique_constraints("project_registry"):
        if constraint.get("column_names") == ["name"] and constraint.get("name"):
            if bind.dialect.name == "sqlite":
                with op.batch_alter_table("project_registry") as batch_op:
                    batch_op.drop_constraint(constraint["name"], type_="unique")
            else:
                op.drop_constraint(constraint["name"], "project_registry", type_="unique")


def _migrate_legacy_superadmin() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "users" not in inspector.get_table_names():
        return

    legacy = bind.execute(
        sa.text("SELECT id FROM users WHERE id = :legacy"),
        {"legacy": _LEGACY_USER_ID},
    ).scalar_one_or_none()
    if legacy is None:
        # A fresh database may already have a UUID superadmin, or no users yet.
        return

    new_id = uuid4().hex
    constraints: list[tuple[str, str, dict[str, object]]] = []
    for table in inspector.get_table_names():
        for foreign_key in sa.inspect(bind).get_foreign_keys(table):
            if foreign_key.get("referred_table") != "users":
                continue
            columns = foreign_key.get("constrained_columns") or []
            referred = foreign_key.get("referred_columns") or []
            if referred == ["id"]:
                constraints.append((table, str(foreign_key.get("name") or ""), foreign_key))

    # PostgreSQL enforces the FK while changing a primary key. Drop only the
    # affected constraints, update every matching column, then recreate them.
    if bind.dialect.name == "postgresql":
        for table, name, _ in constraints:
            if name:
                op.drop_constraint(name, table, type_="foreignkey")
    elif bind.dialect.name == "sqlite":
        bind.exec_driver_sql("PRAGMA foreign_keys=OFF")

    # Use the reflected FK columns rather than a hand-maintained list.  The
    # asset library, for example, uses ``owner_user_id`` while audit records
    # use ``actor_user_id``; both must follow the user primary-key rewrite.
    for table, _name, foreign_key in constraints:
        columns = foreign_key.get("constrained_columns") or []
        if len(columns) != 1:
            continue
        column = str(columns[0])
        bind.execute(
            sa.text(f"UPDATE {table} SET {column} = :new_id WHERE {column} = :legacy"),
            {"new_id": new_id, "legacy": _LEGACY_USER_ID},
        )
    bind.execute(
        sa.text("UPDATE users SET id = :new_id, is_superadmin = TRUE WHERE id = :legacy"),
        {"new_id": new_id, "legacy": _LEGACY_USER_ID},
    )

    if bind.dialect.name == "postgresql":
        for table, name, foreign_key in constraints:
            columns = foreign_key.get("constrained_columns") or []
            referred_columns = foreign_key.get("referred_columns") or []
            if not columns or not referred_columns:
                continue
            op.create_foreign_key(
                name or None,
                table,
                "users",
                columns,
                referred_columns,
                ondelete=foreign_key.get("options", {}).get("ondelete"),
                onupdate=foreign_key.get("options", {}).get("onupdate"),
            )
    elif bind.dialect.name == "sqlite":
        bind.exec_driver_sql("PRAGMA foreign_keys=ON")


def _promote_existing_admin() -> None:
    """Preserve an already configured administrator when no legacy row exists."""

    bind = op.get_bind()
    if bind.execute(sa.text("SELECT 1 FROM users WHERE is_superadmin = TRUE LIMIT 1")).scalar_one_or_none():
        return
    preferred_username = os.environ.get("AUTH_USERNAME", "").strip()
    candidate = None
    if preferred_username:
        candidate = bind.execute(
            sa.text("SELECT id FROM users WHERE username = :username AND role = 'admin' LIMIT 1"),
            {"username": preferred_username},
        ).scalar_one_or_none()
    if candidate is None:
        candidate = bind.execute(
            sa.text("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1")
        ).scalar_one_or_none()
    if candidate is not None:
        bind.execute(sa.text("UPDATE users SET is_superadmin = TRUE WHERE id = :id"), {"id": candidate})


def upgrade() -> None:
    bind = op.get_bind()

    if bind.dialect.name == "sqlite":
        bind.exec_driver_sql("PRAGMA foreign_keys=OFF")

    if not _has_column("users", "is_superadmin"):
        op.add_column(
            "users",
            sa.Column("is_superadmin", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    bind.execute(
        sa.text("UPDATE users SET is_superadmin = TRUE WHERE role = 'admin' AND id = :legacy"),
        {"legacy": _LEGACY_USER_ID},
    )

    if not _has_column("project_registry", "storage_key"):
        op.add_column("project_registry", sa.Column("storage_key", sa.String(), nullable=True))
        bind.execute(sa.text("UPDATE project_registry SET storage_key = name WHERE storage_key IS NULL"))
        with op.batch_alter_table("project_registry") as batch_op:
            batch_op.alter_column("storage_key", existing_type=sa.String(), nullable=False)

    if bind.dialect.name == "postgresql":
        op.execute(sa.text("COMMENT ON COLUMN users.is_superadmin IS '是否为环境配置的超级管理员。'"))
        op.execute(sa.text("COMMENT ON COLUMN project_registry.storage_key IS '项目文件存储键。'"))

    _drop_project_name_constraint()
    if bind.dialect.name == "postgresql":
        op.create_index("uq_project_registry_storage_key", "project_registry", ["storage_key"], unique=True)
    else:
        op.create_index("uq_project_registry_storage_key", "project_registry", ["storage_key"], unique=True)

    _migrate_legacy_superadmin()
    _promote_existing_admin()

    if bind.dialect.name == "sqlite":
        bind.exec_driver_sql("PRAGMA foreign_keys=ON")


def downgrade() -> None:
    # Downgrade cannot safely restore the removed display-name uniqueness or
    # convert a UUID superadmin back to the public ``default`` identifier.
    raise RuntimeError("identity hardening migration is irreversible; restore from a database backup instead")
