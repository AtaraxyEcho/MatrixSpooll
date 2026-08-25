"""Agent Anthropic 凭证 ORM。

每个 user 至多一条 is_active=True，由 partial unique index 保证 (与
ProviderCredential 同模式)。
"""

from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin
from lib.db.encrypted_type import EncryptedText


class AgentAnthropicCredential(TimestampMixin, Base):
    """用户保存的多套 Anthropic 凭证；可在 UI 上一键切换 active。"""

    __tablename__ = "agent_anthropic_credentials"
    __table_args__ = (
        Index("ix_agent_credential_user", "user_id"),
        # 每个 user 至多一条 is_active=True
        Index(
            "uq_agent_credential_one_active_per_user",
            "user_id",
            unique=True,
            sqlite_where=text("is_active = 1"),
            postgresql_where=text("is_active"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    preset_id: Mapped[str] = mapped_column(String(64), nullable=False)  # "deepseek" | "__custom__" | ...
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    base_url: Mapped[str] = mapped_column(Text, nullable=False)
    api_key: Mapped[str] = mapped_column(EncryptedText(), nullable=False)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    haiku_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sonnet_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    opus_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    subagent_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
