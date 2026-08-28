"""Rebuildable lightweight index for a free-creation workspace."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from lib.formal_write import project_metadata_lock
from lib.json_io import atomic_write_json, load_json_or_none
from lib.path_safety import safe_join

_INDEX_VERSION = 2
_CREATION_FIELDS = frozenset(
    {
        "creation_id",
        "request_id",
        "status",
        "output_type",
        "media_type",
        "prompt",
        "prompt_mode",
        "reference_claims",
        "aspect_ratio",
        "resolution",
        "size",
        "model",
        "quantity",
        "duration_seconds",
        "effective_mode",
        "parent_creation_id",
        "subtitle_id",
        "subtitle_revision",
        "storyboard_plan_id",
        "storyboard_shot_id",
        "sequence_index",
        "media_path",
        "cover_path",
        "version",
        "task_id",
        "error",
        "error_code",
        "error_params",
        "updated_at",
        "created_at",
    }
)
_REFERENCE_FIELDS = frozenset(
    {"reference_id", "type", "original_filename", "media_type", "path", "size_bytes", "created_at"}
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _index_path(project_path: Path) -> Path:
    return safe_join(project_path, "free_creation", "index.json")


def invalidate_free_creation_index(project_path: Path) -> None:
    _index_path(project_path).unlink(missing_ok=True)


def _project_record(record: dict[str, Any], fields: frozenset[str]) -> dict[str, Any]:
    return {key: record[key] for key in fields if key in record}


def _load_records(root: Path, pattern: str, identity: str, fields: frozenset[str]) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for path in root.glob(pattern):
        payload = load_json_or_none(path)
        if not isinstance(payload, dict) or not isinstance(payload.get(identity), str):
            continue
        if payload.get("deleted_at") or payload.get("detached_at"):
            continue
        records.append(_project_record(payload, fields))
    records.sort(
        key=lambda item: (str(item.get("updated_at") or item.get("created_at") or ""), str(item.get(identity) or "")),
        reverse=True,
    )
    return records


def rebuild_free_creation_index(project_path: Path) -> dict[str, Any]:
    creations = _load_records(
        safe_join(project_path, "creations"),
        "c_*.json",
        "creation_id",
        _CREATION_FIELDS,
    )
    references = _load_records(
        safe_join(project_path, "free_creation", "references"),
        "r_*.json",
        "reference_id",
        _REFERENCE_FIELDS,
    )
    payload = {
        "version": _INDEX_VERSION,
        "creation_total": len(creations),
        "reference_total": len(references),
        "total": len(creations) + len(references),
        "creations": creations,
        "references": references,
        "built_at": _now(),
    }
    path = _index_path(project_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, payload)
    return payload


def load_free_creation_index(project_path: Path) -> dict[str, Any]:
    cached = load_json_or_none(_index_path(project_path))
    if isinstance(cached, dict) and cached.get("version") == _INDEX_VERSION:
        return cached
    with project_metadata_lock(project_path):
        cached = load_json_or_none(_index_path(project_path))
        if isinstance(cached, dict) and cached.get("version") == _INDEX_VERSION:
            return cached
        return rebuild_free_creation_index(project_path)


__all__ = ["invalidate_free_creation_index", "load_free_creation_index", "rebuild_free_creation_index"]
