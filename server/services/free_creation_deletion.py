"""Coordinated deletion for selected free-creation canvas items."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from lib.formal_write import formal_write_transaction, project_metadata_lock
from lib.json_io import atomic_write_json, load_json_or_none
from lib.path_safety import safe_join
from server.services.free_creation_index import invalidate_free_creation_index
from server.services.free_creation_tasks import creation_metadata_path


class FreeCreationDeletionNotReadyError(RuntimeError):
    """Raised when at least one selected creation still has an active task."""


def _reference_record_path(project_path: Path, reference_id: str) -> Path:
    return safe_join(project_path, "free_creation", "references", f"{reference_id}.json")


def _unique_ids(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(values))


def delete_free_creation_items(
    project_path: Path,
    *,
    creation_ids: Sequence[str],
    reference_ids: Sequence[str],
) -> dict[str, list[str]]:
    """Soft-delete one canvas selection as an all-or-nothing metadata write."""

    unique_creation_ids = _unique_ids(creation_ids)
    unique_reference_ids = _unique_ids(reference_ids)
    creation_paths = [creation_metadata_path(project_path, creation_id) for creation_id in unique_creation_ids]
    reference_paths = [_reference_record_path(project_path, reference_id) for reference_id in unique_reference_ids]
    all_paths = [*creation_paths, *reference_paths]
    deleted_at = datetime.now(UTC).isoformat()

    with project_metadata_lock(project_path):
        creation_records: list[tuple[Path, dict[str, Any]]] = []
        for creation_id, path in zip(unique_creation_ids, creation_paths, strict=True):
            record = load_json_or_none(path)
            if not isinstance(record, dict) or record.get("creation_id") != creation_id:
                raise FileNotFoundError(creation_id)
            if record.get("status") in {"queued", "running", "cancelling"}:
                raise FreeCreationDeletionNotReadyError("active free creation cannot be deleted")
            creation_records.append((path, record))

        reference_records: list[tuple[Path, dict[str, Any]]] = []
        for reference_id, path in zip(unique_reference_ids, reference_paths, strict=True):
            record = load_json_or_none(path)
            if not isinstance(record, dict) or record.get("reference_id") != reference_id:
                raise FileNotFoundError(reference_id)
            reference_records.append((path, record))

        with formal_write_transaction(*all_paths):
            for path, record in creation_records:
                atomic_write_json(path, {**record, "deleted_at": record.get("deleted_at") or deleted_at})
            for path, record in reference_records:
                atomic_write_json(path, {**record, "deleted_at": record.get("deleted_at") or deleted_at})
        invalidate_free_creation_index(project_path)

    return {
        "creation_ids": unique_creation_ids,
        "reference_ids": unique_reference_ids,
    }


__all__ = ["FreeCreationDeletionNotReadyError", "delete_free_creation_items"]
