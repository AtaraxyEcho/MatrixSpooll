"""Constrain global asset ownership to database users.

Revision ID: f8a0b2c4d6e8
Revises: e7f9a1c3d5b7
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f8a0b2c4d6e8"
down_revision: str | Sequence[str] | None = "e7f9a1c3d5b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONSTRAINT_NAME = "fk_assets_owner_user_id_users"


def upgrade() -> None:
    connection = op.get_bind()
    assets = sa.table("assets", sa.column("owner_user_id", sa.String()))
    users = sa.table("users", sa.column("id", sa.String()))
    orphan_owner_ids = sa.select(assets.c.owner_user_id).where(
        assets.c.owner_user_id.is_not(None),
        ~sa.exists(sa.select(users.c.id).where(users.c.id == assets.c.owner_user_id)),
    )
    connection.execute(assets.update().where(assets.c.owner_user_id.in_(orphan_owner_ids)).values(owner_user_id=None))
    with op.batch_alter_table("assets", schema=None) as batch_op:
        batch_op.create_foreign_key(
            _CONSTRAINT_NAME,
            "users",
            ["owner_user_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("assets", schema=None) as batch_op:
        batch_op.drop_constraint(_CONSTRAINT_NAME, type_="foreignkey")
