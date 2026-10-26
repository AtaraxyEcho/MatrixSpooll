"""SQL ``LIKE`` 通配符转义。

用户输入直接拼进 ``ilike(f"%{q}%")`` / ``Column.contains(q)`` 时，``%`` 与 ``_`` 会被
当成通配符：搜 ``ep_01`` 匹配到 ``epX01``，搜 ``%`` 直接命中全表。统一走
:func:`escape_like` 转义，并在比较处传 ``escape=LIKE_ESCAPE_CHAR``，让这三个字符只按
字面量匹配。
"""

from __future__ import annotations

#: 与 ``escape_like`` 配套的 ``escape`` 参数值。
LIKE_ESCAPE_CHAR = "\\"


def escape_like(value: str) -> str:
    """转义 ``\\`` / ``%`` / ``_``，供 ``Column.ilike(..., escape=LIKE_ESCAPE_CHAR)`` 使用。

    反斜杠必须最先替换，否则后续插入的转义符会被二次转义。
    """
    return (
        value.replace(LIKE_ESCAPE_CHAR, LIKE_ESCAPE_CHAR * 2)
        .replace("%", f"{LIKE_ESCAPE_CHAR}%")
        .replace("_", f"{LIKE_ESCAPE_CHAR}_")
    )


def contains_pattern(value: str) -> str:
    """``%value%`` 形式的包含匹配模式（已转义）。"""
    return f"%{escape_like(value)}%"
