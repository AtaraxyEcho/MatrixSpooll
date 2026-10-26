"""Asset ORM: 全局资产库条目。"""

from __future__ import annotations

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin

#: 可见性档位。``shared`` 表示进入实例级共享池（所有登录用户可读、可复制到自己的项目），
#: ``private`` 表示仅创建者、其来源项目的可访问成员与管理员可见。
ASSET_VISIBILITY_PRIVATE = "private"
ASSET_VISIBILITY_SHARED = "shared"
ASSET_VISIBILITIES = (ASSET_VISIBILITY_PRIVATE, ASSET_VISIBILITY_SHARED)


class Asset(TimestampMixin, Base):
    __tablename__ = "assets"
    __table_args__ = (
        UniqueConstraint("type", "name", name="uq_asset_type_name"),
        Index("ix_asset_type", "type"),
        Index("ix_asset_name", "name"),
        Index("ix_asset_owner_user_id", "owner_user_id"),
        Index("ix_asset_visibility", "visibility"),
        Index("ix_asset_source_project_id", "source_project_id"),
        CheckConstraint(
            "visibility IN ('private', 'shared')",
            name="ck_asset_visibility",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)  # character/scene/prop
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    voice_style: Mapped[str] = mapped_column(Text, default="", nullable=False)
    image_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    audio_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    source_project: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 来源项目的注册表 ID：``source_project`` 只是展示用的名称快照，项目名可重复、不可作为授权键。
    source_project_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("project_registry.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 上传者（users.id）；全局库为公共资源，卡片右下角展示上传者身份
    owner_user_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 可见性：默认共享，与引入该字段前的"全实例可见"行为一致
    visibility: Mapped[str] = mapped_column(
        String(16),
        default=ASSET_VISIBILITY_SHARED,
        server_default=ASSET_VISIBILITY_SHARED,
        nullable=False,
    )
