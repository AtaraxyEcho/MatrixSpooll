"""add vendor_capabilities to custom provider model

Revision ID: c7d2e4f6a8b0
Revises: e5f6a7b8c9d0
Create Date: 2026-09-15 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7d2e4f6a8b0"
down_revision: str | Sequence[str] | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """加供应商文档能力声明两列（同步管线写入；NULL = 从未拉取或不适用）。"""
    with op.batch_alter_table("custom_provider_model", schema=None) as batch_op:
        batch_op.add_column(sa.Column("vendor_capabilities", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("vendor_capabilities_synced_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("custom_provider_model", schema=None) as batch_op:
        batch_op.drop_column("vendor_capabilities_synced_at")
        batch_op.drop_column("vendor_capabilities")
