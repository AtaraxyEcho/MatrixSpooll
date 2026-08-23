"""User model for multi-user infrastructure."""

import sqlalchemy as sa
from sqlalchemy import Boolean, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from lib.db.base import Base, TimestampMixin


class User(TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        sa.CheckConstraint("role IN ('admin', 'member')", name="ck_users_role"),
        Index(
            "uq_users_single_superadmin",
            "is_superadmin",
            unique=True,
            postgresql_where=sa.text("is_superadmin"),
            sqlite_where=sa.text("is_superadmin = 1"),
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    username: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    role: Mapped[str] = mapped_column(String, nullable=False, server_default="member")
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=sa.true())
    # Exactly one bootstrap account is marked by this flag.  The flag is the
    # authority for administrative protection; an id value is never special.
    is_superadmin: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa.false())
    # 展示用昵称；为空时 UI 回退显示 username
    nickname: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # 头像相对路径（_avatars/{user_id}.{ext}）；为空时 UI 用昵称/账号首字母占位
    avatar_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
