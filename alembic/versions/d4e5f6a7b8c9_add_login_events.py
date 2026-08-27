"""Add append-only login event history.

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: str | Sequence[str] | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "login_events",
        sa.Column("id", sa.String(length=32), nullable=False, comment="登录事件ID。"),
        sa.Column("user_id", sa.String(), nullable=True, comment="已识别的用户ID。"),
        sa.Column("username", sa.String(length=80), nullable=True, comment="登录用户名快照。"),
        sa.Column("outcome", sa.String(length=24), nullable=False, comment="登录结果。"),
        sa.Column("reason", sa.String(length=64), nullable=True, comment="失败或限流原因。"),
        sa.Column("session_id", sa.String(length=64), nullable=True, comment="成功创建的会话ID。"),
        sa.Column("device_id", sa.String(length=200), nullable=True, comment="客户端设备ID。"),
        sa.Column("ip_address", sa.String(length=45), nullable=True, comment="来源IP地址。"),
        sa.Column("user_agent", sa.String(length=512), nullable=True, comment="客户端标识。"),
        sa.Column("endpoint", sa.String(length=128), nullable=False, comment="登录接口路径。"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, comment="事件发生时间。"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        comment="用户登录事件。",
    )
    op.create_index("idx_login_events_created", "login_events", ["created_at"], unique=False)
    op.create_index(
        "idx_login_events_username_created",
        "login_events",
        ["username", "created_at"],
        unique=False,
    )
    op.create_index(
        "idx_login_events_outcome_created",
        "login_events",
        ["outcome", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_login_events_outcome_created", table_name="login_events")
    op.drop_index("idx_login_events_username_created", table_name="login_events")
    op.drop_index("idx_login_events_created", table_name="login_events")
    op.drop_table("login_events")
