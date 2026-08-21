"""add nickname to users and owner to assets

Revision ID: b0a2c4d6e8f0
Revises: a8d1e2f3b4c5
Create Date: 2026-08-21

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b0a2c4d6e8f0"
down_revision: str | Sequence[str] | None = "a8d1e2f3b4c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("nickname", sa.String(length=100), nullable=True))
    with op.batch_alter_table("assets", schema=None) as batch_op:
        batch_op.add_column(sa.Column("owner_user_id", sa.String(length=36), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("assets", schema=None) as batch_op:
        batch_op.drop_column("owner_user_id")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("nickname")
