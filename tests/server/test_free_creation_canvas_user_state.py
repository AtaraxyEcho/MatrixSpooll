from pathlib import Path

import pytest

from server.services.free_creation_workspace import (
    load_canvas_state,
    load_canvas_viewport,
    save_canvas_state,
    save_canvas_viewport,
)

pytestmark = pytest.mark.unit


def test_canvas_viewports_are_per_user_without_changing_shared_revision(tmp_path: Path) -> None:
    shared = save_canvas_state(
        tmp_path,
        viewport={"x": 0.0, "y": 0.0, "scale": 1.0},
        positions={"c_1234567890abcdef1234": {"x": 100.0, "y": 120.0}},
        hidden_creation_ids=[],
        expected_revision=0,
        persist_viewport=False,
    )
    assert shared["revision"] == 1

    first = {"x": 30.0, "y": 40.0, "scale": 1.2}
    second = {"x": -80.0, "y": 15.0, "scale": 0.8}
    save_canvas_viewport(tmp_path, "user-a", first)
    save_canvas_viewport(tmp_path, "user-b", second)

    fallback = load_canvas_state(tmp_path)["viewport"]
    assert load_canvas_viewport(tmp_path, "user-a", fallback) == first
    assert load_canvas_viewport(tmp_path, "user-b", fallback) == second

    unchanged = save_canvas_state(
        tmp_path,
        viewport={"x": 999.0, "y": 999.0, "scale": 2.0},
        positions=shared["positions"],
        hidden_creation_ids=[],
        expected_revision=1,
        persist_viewport=False,
    )
    assert unchanged["revision"] == 1
    assert load_canvas_state(tmp_path)["viewport"] == fallback
