"""Concurrent patch application for the shared free-creation canvas."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from lib.formal_write import project_metadata_lock
from lib.json_io import atomic_write_json
from lib.path_safety import safe_join
from server.services.free_creation_workspace import load_canvas_state

_RELATIONS_TARGET = "canvas:relations"
_RECENT_PATCH_LIMIT = 200


class CanvasPatchConflict(RuntimeError):
    """A patch targeted entities changed since the caller last read them."""

    def __init__(self, canvas: dict[str, Any], conflict_ids: list[str]) -> None:
        super().__init__("free creation canvas patch conflict")
        self.canvas = canvas
        self.conflict_ids = tuple(sorted(conflict_ids))


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _canvas_state_path(project_path: Path) -> Path:
    return safe_join(project_path, "free_creation", "canvas.json")


def _patch_targets(patch: dict[str, Any]) -> set[str]:
    targets = set(patch.get("position_updates") or {})
    targets.update(patch.get("hidden_creation_updates") or {})
    targets.update(patch.get("hidden_reference_updates") or {})
    targets.update(
        group["group_id"] for group in patch.get("group_upserts") or [] if isinstance(group.get("group_id"), str)
    )
    targets.update(item for item in patch.get("group_deletes") or [] if isinstance(item, str))
    if patch.get("show_relations") is not None:
        targets.add(_RELATIONS_TARGET)
    return targets


def _apply_groups(
    current_groups: list[dict[str, Any]],
    upserts: list[dict[str, Any]],
    deletes: set[str],
) -> list[dict[str, Any]]:
    groups = {
        str(group["group_id"]): {
            "group_id": str(group["group_id"]),
            "member_ids": list(dict.fromkeys(group.get("member_ids") or [])),
        }
        for group in current_groups
        if isinstance(group.get("group_id"), str)
    }
    for group_id in deletes:
        groups.pop(group_id, None)
    for group in upserts:
        group_id = str(group["group_id"])
        groups[group_id] = {
            "group_id": group_id,
            "member_ids": list(dict.fromkeys(group.get("member_ids") or [])),
        }

    members: set[str] = set()
    result: list[dict[str, Any]] = []
    for group_id in sorted(groups):
        group = groups[group_id]
        member_ids = [item for item in group["member_ids"] if isinstance(item, str)]
        if len(member_ids) < 2 or members.intersection(member_ids):
            raise ValueError("canvas groups must contain unique members")
        members.update(member_ids)
        result.append({"group_id": group_id, "member_ids": member_ids})
    return result


def apply_canvas_patch(
    project_path: Path,
    patch: dict[str, Any],
    *,
    actor_id: str,
) -> dict[str, Any]:
    """Atomically merge a node-level patch into the shared canvas state.

    A stale global revision is accepted when every targeted entity still has
    the revision observed by the caller. Reusing ``patch_id`` is idempotent.
    """

    patch_id = str(patch.get("patch_id") or "")
    if not patch_id:
        raise ValueError("canvas patch id is required")

    with project_metadata_lock(project_path):
        current = load_canvas_state(project_path)
        recent_patch_ids = [item for item in current.get("recent_patch_ids", []) if isinstance(item, str)]
        if patch_id in recent_patch_ids:
            return {**current, "_duplicate_patch": True}

        revision = int(current.get("revision") or 0)
        base_revision = int(patch.get("base_revision") or 0)
        if base_revision > revision:
            raise CanvasPatchConflict(current, ["canvas:revision"])

        targets = _patch_targets(patch)
        expected_revisions = {str(key): int(value) for key, value in (patch.get("target_revisions") or {}).items()}
        if targets != set(expected_revisions):
            raise ValueError("canvas patch target revisions must exactly match its operations")
        node_revisions = {str(key): int(value) for key, value in (current.get("node_revisions") or {}).items()}
        conflict_ids = [target for target in targets if node_revisions.get(target, 0) != expected_revisions[target]]
        if conflict_ids:
            raise CanvasPatchConflict(current, conflict_ids)

        positions = {
            str(key): {"x": float(value["x"]), "y": float(value["y"])}
            for key, value in (current.get("positions") or {}).items()
            if isinstance(value, dict) and "x" in value and "y" in value
        }
        positions.update(
            {
                str(key): {"x": float(value["x"]), "y": float(value["y"])}
                for key, value in (patch.get("position_updates") or {}).items()
            }
        )

        hidden_creation_ids = set(current.get("hidden_creation_ids") or [])
        for creation_id, hidden in (patch.get("hidden_creation_updates") or {}).items():
            (hidden_creation_ids.add if hidden else hidden_creation_ids.discard)(creation_id)
        hidden_reference_ids = set(current.get("hidden_reference_ids") or [])
        for reference_id, hidden in (patch.get("hidden_reference_updates") or {}).items():
            (hidden_reference_ids.add if hidden else hidden_reference_ids.discard)(reference_id)

        groups = _apply_groups(
            [group for group in current.get("groups", []) if isinstance(group, dict)],
            [group for group in patch.get("group_upserts", []) if isinstance(group, dict)],
            set(patch.get("group_deletes") or []),
        )
        next_revision = revision + 1
        for target in targets:
            node_revisions[target] = next_revision

        changes = {
            key: patch[key]
            for key in (
                "position_updates",
                "hidden_creation_updates",
                "hidden_reference_updates",
                "group_upserts",
                "group_deletes",
                "show_relations",
            )
            if patch.get(key) not in (None, {}, [])
        }
        last_patch = {
            "patch_id": patch_id,
            "actor_id": actor_id,
            "base_revision": base_revision,
            "revision": next_revision,
            "changes": changes,
        }
        payload = {
            **current,
            "revision": next_revision,
            "positions": positions,
            "hidden_creation_ids": sorted(hidden_creation_ids),
            "hidden_reference_ids": sorted(hidden_reference_ids),
            "groups": groups,
            "show_relations": (
                bool(patch["show_relations"])
                if patch.get("show_relations") is not None
                else bool(current.get("show_relations", True))
            ),
            "node_revisions": node_revisions,
            "recent_patch_ids": [*recent_patch_ids, patch_id][-_RECENT_PATCH_LIMIT:],
            "last_patch": last_patch,
            "updated_at": _now(),
        }
        path = _canvas_state_path(project_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, payload)
        return payload


__all__ = ["CanvasPatchConflict", "apply_canvas_patch"]
