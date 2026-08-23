"""Use stable UUID strings for externally addressed API keys."""

from collections.abc import Sequence
from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _replace_existing_ids() -> None:
    bind = op.get_bind()
    old_ids = [row[0] for row in bind.execute(sa.text("SELECT id FROM api_keys")).fetchall()]
    for old_id in old_ids:
        bind.execute(
            sa.text("UPDATE api_keys SET id = :new_id WHERE id = :old_id"),
            {"old_id": old_id, "new_id": uuid4().hex},
        )


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.alter_column("api_keys", "id", server_default=None, existing_type=sa.Integer(), existing_nullable=False)
        op.execute("ALTER TABLE api_keys ALTER COLUMN id TYPE VARCHAR USING id::text")
        _replace_existing_ids()
        return

    with op.batch_alter_table("api_keys", recreate="always") as batch_op:
        batch_op.alter_column(
            "id",
            existing_type=sa.Integer(),
            type_=sa.String(),
            existing_nullable=False,
            existing_autoincrement=True,
        )
    _replace_existing_ids()


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE api_keys ALTER COLUMN id TYPE INTEGER USING id::integer")
        return

    with op.batch_alter_table("api_keys", recreate="always") as batch_op:
        batch_op.alter_column(
            "id",
            existing_type=sa.String(),
            type_=sa.Integer(),
            existing_nullable=False,
            existing_autoincrement=False,
        )
