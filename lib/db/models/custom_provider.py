"""Custom provider ORM models."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin
from lib.db.encrypted_type import EncryptedText


class CustomProvider(TimestampMixin, Base):
    """用户自定义的 AI 供应商。"""

    __tablename__ = "custom_provider"
    # 与加列迁移保持同步：三条并发上限列在 DB 层强制 ≥1，repo 直写或手工 SQL 都无法写入
    # 0 或负值；NULL=未设置回退默认。0 不是合法用户输入，仅作 CapacityTable 内部「不支持该
    # lane」哨兵（由 lane 投影在内存里产生，绝不写回这些列）。
    __table_args__ = (
        CheckConstraint(
            "image_max_workers IS NULL OR image_max_workers >= 1",
            name="ck_custom_provider_image_max_workers_positive",
        ),
        CheckConstraint(
            "video_max_workers IS NULL OR video_max_workers >= 1",
            name="ck_custom_provider_video_max_workers_positive",
        ),
        CheckConstraint(
            "audio_max_workers IS NULL OR audio_max_workers >= 1",
            name="ck_custom_provider_audio_max_workers_positive",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    discovery_format: Mapped[str] = mapped_column(String(32), nullable=False)  # "openai" | "google"
    base_url: Mapped[str] = mapped_column(Text, nullable=False)
    api_key: Mapped[str] = mapped_column(EncryptedText(), nullable=False)
    # 按 lane 命名的并发上限定型列；NULL = 未设置 → 容量装载回退全局默认。自定义供应商不在
    # 内置注册表，故无声明默认层，回退为两层（用户列值 → 全局默认）。
    image_max_workers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    video_max_workers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    audio_max_workers: Mapped[int | None] = mapped_column(Integer, nullable=True)

    @property
    def provider_id(self) -> str:
        from lib.custom_provider import make_provider_id

        return make_provider_id(self.id)


class CustomProviderModel(TimestampMixin, Base):
    """自定义供应商下的模型配置。"""

    __tablename__ = "custom_provider_model"
    __table_args__ = (
        UniqueConstraint("provider_id", "model_id", name="uq_custom_provider_model"),
        Index("ix_custom_provider_model_provider_id", "provider_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    provider_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("custom_provider.id", ondelete="CASCADE"), nullable=False
    )
    model_id: Mapped[str] = mapped_column(String(128), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(32), nullable=False)  # ENDPOINT_REGISTRY key
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    price_unit: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )  # "token" | "image" | "second" | "character"
    price_input: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_output: Mapped[float | None] = mapped_column(Float, nullable=True)  # only for text
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)  # "USD" | "CNY"
    supported_durations: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list[int]
    resolution: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )  # standard token ("1080p"/"2K") or native "WxH"
    # 供应商文档拉取的能力声明。JSON 形态：{"capabilities": {稀疏能力字段}, "source_urls":
    # [...], "parser_version": int, "etag": str}。与 capability_overrides 分列：本列只由同步
    # 管线写入（用户不可改），合并时位于用户覆盖之下、端点判定之上；NULL = 从未拉取或不适用。
    vendor_capabilities: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    vendor_capabilities_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 模型级能力覆盖，稀疏字典，键名对齐 VideoCapabilities 字段名。NULL 或字典缺该键 =
    # 跟随系统判定；写死的能力维度列表不进 schema，向新维度开放无需迁移。合成语义由
    # lib.custom_provider.capabilities 唯一承载。
    capability_overrides: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)

    @property
    def vendor_declared_capabilities(self) -> dict[str, object] | None:
        """文档声明的稀疏能力（剥掉 source_urls/parser_version/etag 元数据包装）。

        手工改库可能写入任意 JSON 形态，非字典包装或空声明一律按「无声明」处理，不让脏数据
        炸掉合成链。
        """
        raw = self.vendor_capabilities
        if not isinstance(raw, dict):
            return None
        capabilities = raw.get("capabilities")
        if not isinstance(capabilities, dict) or not capabilities:
            return None
        return capabilities

    @property
    def merged_capability_overrides(self) -> dict[str, object] | None:
        """合成/执行层消费的稀疏覆盖：文档声明在下、用户覆盖在上（同键时用户胜）。

        两层合成一个稀疏字典后，下游（synthesize / filter_valid_overrides / tier 合并）按既有
        单字典语义工作，无需感知来源分层；来源分层只体现在 DB 两列与展示层。
        """
        vendor = self.vendor_declared_capabilities or {}
        user = self.capability_overrides if isinstance(self.capability_overrides, dict) else None
        merged = {**vendor, **(user or {})}
        return merged or None
