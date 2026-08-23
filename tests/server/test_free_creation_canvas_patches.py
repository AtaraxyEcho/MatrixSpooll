from pathlib import Path

import pytest

from server.services.free_creation_canvas import CanvasPatchConflict, apply_canvas_patch
from server.services.free_creation_workspace import load_canvas_state

pytestmark = pytest.mark.unit


def _move_patch(
    *,
    patch_id: str,
    base_revision: int,
    node_id: str,
    x: float,
    expected_node_revision: int = 0,
) -> dict:
    return {
        "patch_id": patch_id,
        "base_revision": base_revision,
        "target_revisions": {node_id: expected_node_revision},
        "position_updates": {node_id: {"x": x, "y": 120.0}},
    }


def test_canvas_patch_merges_disjoint_stale_base_changes(tmp_path: Path) -> None:
    first_id = "c_11111111111111111111"
    second_id = "c_22222222222222222222"

    first = apply_canvas_patch(
        tmp_path,
        _move_patch(
            patch_id="11111111-1111-4111-8111-111111111111",
            base_revision=0,
            node_id=first_id,
            x=100.0,
        ),
        actor_id="user-a",
    )
    second = apply_canvas_patch(
        tmp_path,
        _move_patch(
            patch_id="22222222-2222-4222-8222-222222222222",
            base_revision=0,
            node_id=second_id,
            x=420.0,
        ),
        actor_id="user-b",
    )

    assert first["revision"] == 1
    assert second["revision"] == 2
    assert second["positions"] == {
        first_id: {"x": 100.0, "y": 120.0},
        second_id: {"x": 420.0, "y": 120.0},
    }
    assert second["node_revisions"] == {first_id: 1, second_id: 2}


def test_canvas_patch_rejects_a_stale_change_to_the_same_node(tmp_path: Path) -> None:
    node_id = "c_11111111111111111111"
    apply_canvas_patch(
        tmp_path,
        _move_patch(
            patch_id="11111111-1111-4111-8111-111111111111",
            base_revision=0,
            node_id=node_id,
            x=100.0,
        ),
        actor_id="user-a",
    )

    with pytest.raises(CanvasPatchConflict) as caught:
        apply_canvas_patch(
            tmp_path,
            _move_patch(
                patch_id="22222222-2222-4222-8222-222222222222",
                base_revision=0,
                node_id=node_id,
                x=420.0,
            ),
            actor_id="user-b",
        )

    assert caught.value.conflict_ids == (node_id,)
    assert caught.value.canvas["positions"][node_id] == {"x": 100.0, "y": 120.0}


def test_canvas_patch_is_idempotent_by_patch_id(tmp_path: Path) -> None:
    patch = _move_patch(
        patch_id="11111111-1111-4111-8111-111111111111",
        base_revision=0,
        node_id="c_11111111111111111111",
        x=100.0,
    )

    first = apply_canvas_patch(tmp_path, patch, actor_id="user-a")
    duplicate = apply_canvas_patch(tmp_path, patch, actor_id="user-a")

    assert duplicate["revision"] == first["revision"] == 1
    assert duplicate["_duplicate_patch"] is True
    assert load_canvas_state(tmp_path)["revision"] == 1
    assert duplicate["last_patch"]["patch_id"] == patch["patch_id"]


def test_old_duplicate_patch_does_not_impersonate_the_latest_patch(tmp_path: Path) -> None:
    first_patch = _move_patch(
        patch_id="11111111-1111-4111-8111-111111111111",
        base_revision=0,
        node_id="c_11111111111111111111",
        x=100.0,
    )
    second_patch = _move_patch(
        patch_id="22222222-2222-4222-8222-222222222222",
        base_revision=1,
        node_id="c_22222222222222222222",
        x=420.0,
    )
    apply_canvas_patch(tmp_path, first_patch, actor_id="user-a")
    latest = apply_canvas_patch(tmp_path, second_patch, actor_id="user-b")

    duplicate = apply_canvas_patch(tmp_path, first_patch, actor_id="user-a")

    assert duplicate["_duplicate_patch"] is True
    assert duplicate["revision"] == latest["revision"] == 2
    assert duplicate["last_patch"]["patch_id"] == second_patch["patch_id"]


def test_canvas_patch_updates_shared_visibility_and_groups_atomically(tmp_path: Path) -> None:
    creation_id = "c_11111111111111111111"
    reference_id = "r_22222222222222222222"
    group_id = "g_33333333333333333333"

    canvas = apply_canvas_patch(
        tmp_path,
        {
            "patch_id": "11111111-1111-4111-8111-111111111111",
            "base_revision": 0,
            "target_revisions": {creation_id: 0, reference_id: 0, group_id: 0},
            "hidden_creation_updates": {creation_id: True},
            "hidden_reference_updates": {reference_id: True},
            "group_upserts": [{"group_id": group_id, "member_ids": [creation_id, reference_id]}],
        },
        actor_id="user-a",
    )

    assert canvas["hidden_creation_ids"] == [creation_id]
    assert canvas["hidden_reference_ids"] == [reference_id]
    assert canvas["groups"] == [{"group_id": group_id, "member_ids": [creation_id, reference_id]}]
    assert all(canvas["node_revisions"][item] == 1 for item in (creation_id, reference_id, group_id))
