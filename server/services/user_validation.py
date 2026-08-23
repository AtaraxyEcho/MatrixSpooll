"""用户资料字段的共享校验（创建用户 / 更新个人资料共用）。

- 用户名校验见 ``server.routers.admin._validate_username``（管理端创建入口专属，
  用户侧不可改名，无需外提）。
- 昵称校验在此统一：管理端创建用户（``admin.py``）与个人资料更新（``auth.py``）
  必须走同一套长度 / 字符 / 敏感词规则，避免两侧口径漂移。
"""

from __future__ import annotations

import re
from collections.abc import Callable

from fastapi import HTTPException

NICKNAME_MIN_LENGTH = 2
NICKNAME_MAX_LENGTH = 20

# 允许字符：中英文、数字、下划线、连字符、中点；禁止任何空格（首尾空格在规范化时已移除）。
NICKNAME_ALLOWED_RE = re.compile(r"^[\u4e00-\u9fa5A-Za-z0-9_\-·]+$")

# 敏感词过滤：内置通用冒犯词表，按子串匹配（大小写不敏感）。
# 中文场景的违规词表由运营按需扩充维护，此处不预置具体条目。
NICKNAME_BANNED_WORDS: frozenset[str] = frozenset({"shit", "fuck", "bitch", "asshole", "bastard", "slut"})


def validate_nickname(value: str | None, translate: Callable[..., str]) -> str | None:
    """校验并规范化昵称。

    - ``None`` 或去空白后为空 → 视为未填，返回 ``None``（UI 回退显示 username）。
    - 长度、字符集、连续空格、敏感词任一不合法 → 抛 422。
    """
    if value is None:
        return None
    nickname = value.strip()
    if not nickname:
        return None
    if not NICKNAME_MIN_LENGTH <= len(nickname) <= NICKNAME_MAX_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=translate(
                "admin_nickname_length",
                min=NICKNAME_MIN_LENGTH,
                max=NICKNAME_MAX_LENGTH,
            ),
        )
    if NICKNAME_ALLOWED_RE.fullmatch(nickname) is None:
        raise HTTPException(status_code=422, detail=translate("admin_nickname_characters"))
    lowered = nickname.lower()
    if any(word in lowered for word in NICKNAME_BANNED_WORDS):
        raise HTTPException(status_code=422, detail=translate("admin_nickname_banned"))
    return nickname
