"""add user contact and login metadata

Revision ID: b2c3d4e5f6a7
Revises: a4b5c6d7e8f9
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: str | Sequence[str] | None = "a4b5c6d7e8f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("email", sa.String(length=254), nullable=True, comment="用户邮箱地址。"))
        batch_op.add_column(
            sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True, comment="最近登录时间。")
        )
        batch_op.add_column(sa.Column("last_login_ip", sa.String(length=45), nullable=True, comment="最近登录IP地址。"))


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("last_login_ip")
        batch_op.drop_column("last_login_at")
        batch_op.drop_column("email")
