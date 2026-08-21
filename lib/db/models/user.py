"""User model for multi-user infrastructure."""

import sqlalchemy as sa
from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    username: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    role: Mapped[str] = mapped_column(String, nullable=False, server_default="member")
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=sa.true())
    # 展示用昵称；为空时 UI 回退显示 username
    nickname: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # 头像相对路径（_avatars/{user_id}.{ext}）；为空时 UI 用昵称/账号首字母占位
    avatar_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
