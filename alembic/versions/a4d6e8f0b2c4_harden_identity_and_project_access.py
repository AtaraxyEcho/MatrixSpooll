"""harden identity and project access

Revision ID: a4d6e8f0b2c4
Revises: f8a0b2c4d6e8
Create Date: 2026-08-22 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from lib.db.migration_helpers import preserve_sqlite_indexes

revision: str = "a4d6e8f0b2c4"
down_revision: str | Sequence[str] | None = "f8a0b2c4d6e8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_HISTORICAL_USER_TABLES = (
    "tasks",
    "api_calls",
    "agent_sessions",
    "agent_session_entries",
    "agent_session_summaries",
    "agent_session_event_log",
    "agent_session_user_message_links",
)


def _user_fk(table_name: str) -> dict[str, object]:
    for foreign_key in sa.inspect(op.get_bind()).get_foreign_keys(table_name):
        if foreign_key.get("constrained_columns") == ["user_id"] and foreign_key.get("referred_table") == "users":
            return foreign_key
    raise RuntimeError(f"missing users foreign key on {table_name}.user_id")


def _replace_user_fk(table_name: str, *, ondelete: str, nullable: bool) -> None:
    bind = op.get_bind()
    foreign_key = _user_fk(table_name)
    existing_name = foreign_key.get("name")
    target_name = f"fk_{table_name}_user_id_users"

    if bind.dialect.name == "postgresql":
        if not isinstance(existing_name, str) or not existing_name:
            raise RuntimeError(f"unnamed PostgreSQL foreign key on {table_name}.user_id")
        op.drop_constraint(existing_name, table_name, type_="foreignkey")
        op.alter_column(table_name, "user_id", existing_type=sa.String(), nullable=nullable)
        op.create_foreign_key(target_name, table_name, "users", ["user_id"], ["id"], ondelete=ondelete)
        return

    reflected_name = existing_name if isinstance(existing_name, str) and existing_name else target_name
    naming_convention = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}
    with preserve_sqlite_indexes(table_name):
        with op.batch_alter_table(
            table_name,
            recreate="always",
            naming_convention=naming_convention,
        ) as batch_op:
            batch_op.drop_constraint(reflected_name, type_="foreignkey")
            batch_op.alter_column("user_id", existing_type=sa.String(), nullable=nullable)
            batch_op.create_foreign_key(target_name, "users", ["user_id"], ["id"], ondelete=ondelete)


def _backfill_actor_username(table_name: str) -> None:
    op.execute(
        sa.text(
            f"UPDATE {table_name} SET actor_username = "
            f"(SELECT username FROM users WHERE users.id = {table_name}.user_id) "
            "WHERE actor_username IS NULL"
        )
    )


def _ensure_task_dedup_index() -> None:
    duplicates = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT project_name, task_type, resource_id, "
                "COALESCE(script_file, ''), COALESCE(resource_type, ''), COUNT(*) "
                "FROM tasks WHERE status IN ('queued', 'running', 'cancelling') "
                "GROUP BY project_name, task_type, resource_id, "
                "COALESCE(script_file, ''), COALESCE(resource_type, '') HAVING COUNT(*) > 1 LIMIT 5"
            )
        )
        .fetchall()
    )
    if duplicates:
        raise RuntimeError(f"duplicate active tasks prevent dedup index repair: {duplicates!r}")
    op.execute(
        sa.text(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe_active "
            "ON tasks(project_name, task_type, resource_id, COALESCE(script_file, ''), "
            "COALESCE(resource_type, '')) WHERE status IN ('queued', 'running', 'cancelling')"
        )
    )


def _add_check_constraints() -> None:
    op.execute(sa.text("UPDATE users SET role = 'member' WHERE role = 'user'"))
    invalid_roles = (
        op.get_bind()
        .execute(sa.text("SELECT id, role FROM users WHERE role NOT IN ('admin', 'member') LIMIT 5"))
        .fetchall()
    )
    if invalid_roles:
        raise RuntimeError(f"invalid user roles prevent role constraint: {invalid_roles!r}")
    with op.batch_alter_table("users") as batch_op:
        batch_op.create_check_constraint("ck_users_role", "role IN ('admin', 'member')")

    mismatches = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT pm.project_id, pm.user_id, pr.owner_id "
                "FROM project_members pm JOIN project_registry pr ON pr.id = pm.project_id "
                "WHERE pm.role = 'owner' AND pm.user_id <> pr.owner_id"
            )
        )
        .fetchmany(5)
    )
    if mismatches:
        raise RuntimeError(f"project owner rows disagree with project_registry: {mismatches!r}")

    op.execute(
        sa.text(
            "DELETE FROM project_members WHERE EXISTS ("
            "SELECT 1 FROM project_registry pr "
            "WHERE pr.id = project_members.project_id AND pr.owner_id = project_members.user_id)"
        )
    )
    with op.batch_alter_table("project_members") as batch_op:
        batch_op.drop_constraint("ck_project_members_role", type_="check")
        batch_op.create_check_constraint("ck_project_members_role", "role IN ('editor', 'viewer')")


def _add_agent_credential_fk() -> None:
    orphaned = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT user_id FROM agent_anthropic_credentials "
                "WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = agent_anthropic_credentials.user_id) LIMIT 5"
            )
        )
        .fetchall()
    )
    if orphaned:
        raise RuntimeError(f"agent credentials reference missing users: {orphaned!r}")
    with op.batch_alter_table("agent_anthropic_credentials") as batch_op:
        batch_op.create_foreign_key(
            "fk_agent_anthropic_credentials_user_id_users",
            "users",
            ["user_id"],
            ["id"],
            ondelete="CASCADE",
        )


def upgrade() -> None:
    """Upgrade schema."""

    _ensure_task_dedup_index()

    with op.batch_alter_table("api_keys") as batch_op:
        batch_op.add_column(sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True))

    for table_name in ("tasks", "api_calls", "agent_sessions"):
        with preserve_sqlite_indexes(table_name):
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.add_column(sa.Column("actor_username", sa.String(), nullable=True))
        _backfill_actor_username(table_name)

    _add_check_constraints()
    _add_agent_credential_fk()

    for table_name in _HISTORICAL_USER_TABLES:
        _replace_user_fk(table_name, ondelete="SET NULL", nullable=True)

    op.create_table(
        "audit_events",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), autoincrement=True, nullable=False),
        sa.Column("actor_user_id", sa.String(), nullable=True),
        sa.Column("actor_username", sa.String(), nullable=True),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("resource_type", sa.String(length=64), nullable=False),
        sa.Column("resource_id", sa.String(length=128), nullable=True),
        sa.Column("project_id", sa.String(), nullable=True),
        sa.Column("project_name", sa.String(), nullable=True),
        sa.Column("details", sa.JSON(), server_default=sa.text("'{}'"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["project_id"], ["project_registry.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_audit_events_actor_created", "audit_events", ["actor_user_id", "created_at"])
    op.create_index("idx_audit_events_project_created", "audit_events", ["project_id", "created_at"])
    op.create_index("idx_audit_events_action_created", "audit_events", ["action", "created_at"])


def downgrade() -> None:
    """Downgrade schema."""

    op.drop_table("audit_events")

    for table_name in reversed(_HISTORICAL_USER_TABLES):
        op.execute(sa.text(f"UPDATE {table_name} SET user_id = 'default' WHERE user_id IS NULL"))
        _replace_user_fk(table_name, ondelete="CASCADE", nullable=False)

    with op.batch_alter_table("agent_anthropic_credentials") as batch_op:
        batch_op.drop_constraint("fk_agent_anthropic_credentials_user_id_users", type_="foreignkey")

    with op.batch_alter_table("project_members") as batch_op:
        batch_op.drop_constraint("ck_project_members_role", type_="check")
        batch_op.create_check_constraint(
            "ck_project_members_role",
            "role IN ('owner', 'editor', 'viewer')",
        )
    op.execute(
        sa.text(
            "INSERT INTO project_members (project_id, user_id, role, created_at, updated_at) "
            "SELECT id, owner_id, 'owner', created_at, updated_at FROM project_registry"
        )
    )

    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_constraint("ck_users_role", type_="check")

    for table_name in ("agent_sessions", "api_calls", "tasks"):
        with preserve_sqlite_indexes(table_name):
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.drop_column("actor_username")

    with op.batch_alter_table("api_keys") as batch_op:
        batch_op.drop_column("revoked_at")
