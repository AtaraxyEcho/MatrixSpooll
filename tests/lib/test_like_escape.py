"""模糊搜索通配符转义与 JSON 快照的单元测试。"""

from __future__ import annotations

import json

import pytest

from lib.db.like import LIKE_ESCAPE_CHAR, contains_pattern, escape_like
from lib.json_io import json_snapshot

pytestmark = pytest.mark.unit


def test_escape_like_escapes_wildcards_and_backslash() -> None:
    assert escape_like("ep_01") == "ep\\_01"
    assert escape_like("100%") == "100\\%"
    assert escape_like("a\\b") == "a\\\\b"


def test_escape_like_keeps_plain_text() -> None:
    assert escape_like("episode-01") == "episode-01"
    assert escape_like("中文名称") == "中文名称"


def test_contains_pattern_wraps_escaped_value() -> None:
    assert contains_pattern("_x") == "%\\_x%"
    assert LIKE_ESCAPE_CHAR == "\\"


def test_json_snapshot_is_deep_copy() -> None:
    source = {"episode": 1, "segments": [{"id": "s1", "assets": {"image": "a.png"}}]}
    snapshot = json_snapshot(source)

    assert snapshot == source
    assert snapshot is not source
    assert snapshot["segments"][0] is not source["segments"][0]

    snapshot["segments"][0]["assets"]["image"] = "changed.png"
    assert source["segments"][0]["assets"]["image"] == "a.png"


def test_json_snapshot_matches_deepcopy_for_json_payload() -> None:
    source = json.loads('{"a": [1, 2.5, null, true, "x"], "b": {"c": []}}')
    assert json_snapshot(source) == source
