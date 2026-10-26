"""Add asset visibility and source project identity.

Revision ID: a7b8c9d0e1f2
Revises: c7d2e4f6a8b0
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: str | Sequence[str] | None = "c7d2e4f6a8b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # batch_alter_table：SQLite 不支持 ALTER 加约束，测试环境的 `upgrade head`
    # 会直接抛 NotImplementedError；batch 在 PG 上仍是普通 ALTER，不额外重建表。
    with op.batch_alter_table("assets") as batch:
        # 默认 shared：升级立刻保持"全实例可见"的既有行为，收紧留给 UI 显式选择。
        batch.add_column(
            sa.Column(
                "visibility",
                sa.String(length=16),
                nullable=False,
                server_default="shared",
                comment="Visible to everyone (shared) or only to the creator and source project members (private).",
            )
        )
        batch.add_column(
            sa.Column(
                "source_project_id",
                sa.String(length=36),
                nullable=True,
                comment="Registry id of the source project; authorization key, unlike the display-name snapshot.",
            )
        )
        batch.create_foreign_key(
            "fk_assets_source_project_id",
            "project_registry",
            ["source_project_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_check_constraint("ck_asset_visibility", "visibility IN ('private', 'shared')")

    op.create_index("ix_asset_visibility", "assets", ["visibility"], unique=False)
    op.create_index("ix_asset_source_project_id", "assets", ["source_project_id"], unique=False)
    op.create_index("ix_asset_owner_user_id", "assets", ["owner_user_id"], unique=False)

    # 回填来源项目身份：只认名字唯一命中的项目。同名项目存在歧义时不猜——
    # 留空会让这些资产退化为"仅创建者可见"，不会把 A 项目的资产挂到 B 项目授权上。
    op.execute(
        sa.text(
            """
            UPDATE assets
               SET source_project_id = (
                   SELECT registry.id
                     FROM project_registry AS registry
                    WHERE registry.name = assets.source_project
                   )
             WHERE assets.source_project IS NOT NULL
               AND (
                   SELECT count(*)
                     FROM project_registry AS registry2
                    WHERE registry2.name = assets.source_project
               ) = 1
            """
        )
    )


def downgrade() -> None:
    op.drop_index("ix_asset_owner_user_id", table_name="assets")
    op.drop_index("ix_asset_source_project_id", table_name="assets")
    op.drop_index("ix_asset_visibility", table_name="assets")
    with op.batch_alter_table("assets") as batch:
        batch.drop_constraint("ck_asset_visibility", type_="check")
        batch.drop_constraint("fk_assets_source_project_id", type_="foreignkey")
        batch.drop_column("source_project_id")
        batch.drop_column("visibility")
