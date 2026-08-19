"""Persistent workspace state and input records for free creation projects."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from lib.artifact_manifest import ArtifactKey, ProjectArtifactManifestAdapter
from lib.formal_write import project_metadata_lock
from lib.json_io import atomic_write_bytes, atomic_write_json, load_json_or_none
from lib.path_safety import safe_join

ReferenceType = Literal["upload", "creation"]
ExportScope = Literal["selected", "request", "all"]

_TEXT_REFERENCE_EXTENSIONS = frozenset({".txt", ".text", ".md", ".markdown", ".rtf", ".doc", ".docx", ".pdf", ".epub"})
_REFERENCE_EXTENSIONS = (
    frozenset({".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".wav", ".mp3"}) | _TEXT_REFERENCE_EXTENSIONS
)
MAX_REFERENCE_BYTES = 100 * 1024 * 1024
MAX_REFERENCE_PREVIEW_CHARS = 120_000
MAX_PLAIN_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024


def _now() -> str:
    return datetime.now(UTC).isoformat()


def new_request_id() -> str:
    return f"q_{uuid.uuid4().hex[:20]}"


def new_reference_id() -> str:
    return f"r_{uuid.uuid4().hex[:20]}"


def _workspace_root(project_path: Path) -> Path:
    return safe_join(project_path, "free_creation")


def _canvas_state_path(project_path: Path) -> Path:
    return safe_join(_workspace_root(project_path), "canvas.json")


def _request_path(project_path: Path, request_id: str) -> Path:
    return safe_join(_workspace_root(project_path), "requests", f"{request_id}.json")


def _reference_record_path(project_path: Path, reference_id: str) -> Path:
    return safe_join(_workspace_root(project_path), "references", f"{reference_id}.json")


def default_canvas_state() -> dict[str, Any]:
    return {
        "revision": 0,
        "viewport": {"x": 0.0, "y": 0.0, "scale": 1.0},
        "positions": {},
        "hidden_creation_ids": [],
        "hidden_reference_ids": [],
        "updated_at": None,
    }


def load_canvas_state(project_path: Path) -> dict[str, Any]:
    payload = load_json_or_none(_canvas_state_path(project_path))
    if not isinstance(payload, dict):
        return default_canvas_state()
    return {**default_canvas_state(), **payload}


def save_canvas_state(
    project_path: Path,
    *,
    viewport: dict[str, float],
    positions: dict[str, dict[str, float]],
    hidden_creation_ids: list[str],
    hidden_reference_ids: list[str] | None = None,
    expected_revision: int | None,
) -> dict[str, Any]:
    with project_metadata_lock(project_path):
        current = load_canvas_state(project_path)
        revision = int(current.get("revision") or 0)
        if expected_revision is not None and expected_revision != revision:
            raise RuntimeError("free creation canvas revision conflict")
        payload = {
            "revision": revision + 1,
            "viewport": viewport,
            "positions": positions,
            "hidden_creation_ids": sorted(set(hidden_creation_ids)),
            "hidden_reference_ids": sorted(set(hidden_reference_ids or [])),
            "updated_at": _now(),
        }
        path = _canvas_state_path(project_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, payload)
        return payload


def save_reference_upload(project_path: Path, *, original_filename: str, content: bytes) -> dict[str, Any]:
    extension = Path(original_filename).suffix.lower()
    if extension not in _REFERENCE_EXTENSIONS:
        raise ValueError("unsupported reference type")
    if not content or len(content) > MAX_REFERENCE_BYTES:
        raise OverflowError("reference upload size is invalid")

    reference_id = new_reference_id()
    relative_path = f"uploads/free_creation/{reference_id}{extension}"
    media_path = safe_join(project_path, relative_path)
    record = {
        "reference_id": reference_id,
        "type": "upload",
        "original_filename": Path(original_filename).name,
        "media_type": "video"
        if extension in {".mp4", ".mov"}
        else "audio"
        if extension in {".wav", ".mp3"}
        else "text"
        if extension in _TEXT_REFERENCE_EXTENSIONS
        else "image",
        "path": relative_path,
        "size_bytes": len(content),
        "created_at": _now(),
    }
    record_path = _reference_record_path(project_path, reference_id)
    with project_metadata_lock(project_path):
        media_path.parent.mkdir(parents=True, exist_ok=True)
        record_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(media_path, content)
        try:
            atomic_write_json(record_path, record)
        except BaseException:
            media_path.unlink(missing_ok=True)
            raise
    return record


def extract_reference_text(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix not in _TEXT_REFERENCE_EXTENSIONS:
        return None
    if suffix == ".docx":
        try:
            from lib.source_loader.docx import DocxExtractor

            return DocxExtractor().extract(path).text
        except Exception:  # noqa: BLE001
            return None
    if suffix in {".pdf", ".epub"}:
        try:
            if suffix == ".pdf":
                from lib.source_loader.pdf import PdfOxideExtractor

                return PdfOxideExtractor().extract(path).text
            from lib.source_loader.epub import EpubExtractor

            return EpubExtractor().extract(path).text
        except Exception:  # noqa: BLE001
            return None
    if suffix == ".doc":
        antiword = shutil.which("antiword")
        if not antiword:
            return None
        try:
            result = subprocess.run(
                [antiword, str(path)],
                capture_output=True,
                check=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout
    try:
        with path.open("rb") as handle:
            content = handle.read(MAX_PLAIN_TEXT_PREVIEW_BYTES + 1)
    except OSError:
        return None
    return content.decode("utf-8-sig", errors="replace")


def read_reference_preview(project_path: Path, reference_id: str) -> dict[str, Any]:
    """Return a bounded text preview for an uploaded script/context file."""

    record_path = _reference_record_path(project_path, reference_id)
    record = load_json_or_none(record_path)
    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
        raise FileNotFoundError(reference_id)
    if record.get("detached_at"):
        raise FileNotFoundError(reference_id)
    path = safe_join(project_path, str(record["path"]))
    if not path.is_file():
        raise FileNotFoundError(reference_id)
    text = extract_reference_text(path)
    if text is None:
        return {
            "reference_id": reference_id,
            "original_filename": record.get("original_filename", path.name),
            "media_type": record.get("media_type", "text"),
            "supported": False,
        }
    truncated = len(text) > MAX_REFERENCE_PREVIEW_CHARS
    return {
        "reference_id": reference_id,
        "original_filename": record.get("original_filename", path.name),
        "media_type": record.get("media_type", "text"),
        "supported": True,
        "text": text[:MAX_REFERENCE_PREVIEW_CHARS],
        "truncated": truncated,
    }


def list_reference_uploads(project_path: Path) -> list[dict[str, Any]]:
    root = safe_join(_workspace_root(project_path), "references")
    if not root.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for path in sorted(root.glob("r_*.json"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
        record = load_json_or_none(path)
        if isinstance(record, dict) and isinstance(record.get("reference_id"), str) and not record.get("detached_at"):
            records.append(record)
    return records


def detach_reference_upload(project_path: Path, reference_id: str) -> None:
    """Remove an upload from the active workspace without breaking provenance."""

    record_path = _reference_record_path(project_path, reference_id)
    record = load_json_or_none(record_path)
    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
        raise FileNotFoundError(reference_id)
    with project_metadata_lock(project_path):
        record["detached_at"] = _now()
        atomic_write_json(record_path, record)


def delete_reference_upload(project_path: Path, reference_id: str) -> None:
    """Delete an upload only when no persisted creation request still cites it."""

    record_path = _reference_record_path(project_path, reference_id)
    record = load_json_or_none(record_path)
    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
        raise FileNotFoundError(reference_id)
    workspace_root = _workspace_root(project_path)
    for metadata_path in workspace_root.rglob("*.json"):
        if metadata_path in {record_path, _canvas_state_path(project_path)}:
            continue
        try:
            text = metadata_path.read_text(encoding="utf-8")
        except OSError:
            continue
        if reference_id in text:
            raise RuntimeError("free creation reference is in use")
    with project_metadata_lock(project_path):
        media_path = safe_join(project_path, str(record["path"]))
        media_path.unlink(missing_ok=True)
        record_path.unlink(missing_ok=True)


def resolve_reference_claims(
    project_path: Path,
    references: list[str | dict[str, Any]],
    *,
    load_creation: Any,
) -> tuple[list[str], list[dict[str, Any]]]:
    """Resolve public reference identities to project-relative execution paths."""

    paths: list[str] = []
    claims: list[dict[str, Any]] = []
    for reference in references:
        if isinstance(reference, str):
            paths.append(reference)
            continue
        reference_type = reference.get("type")
        if reference_type == "upload":
            reference_id = reference.get("reference_id")
            if not isinstance(reference_id, str):
                raise ValueError("invalid upload reference")
            record = load_json_or_none(_reference_record_path(project_path, reference_id))
            if not isinstance(record, dict) or not isinstance(record.get("path"), str):
                raise FileNotFoundError(reference_id)
            paths.append(record["path"])
            claims.append(
                {
                    "type": "upload",
                    "reference_id": reference_id,
                    **({"role": reference.get("role")} if reference.get("role") else {}),
                }
            )
            continue
        if reference_type == "creation":
            creation_id = reference.get("creation_id")
            if not isinstance(creation_id, str):
                raise ValueError("invalid creation reference")
            creation = load_creation(project_path, creation_id)
            if not isinstance(creation, dict) or creation.get("status") != "succeeded":
                raise FileNotFoundError(creation_id)
            media_path = creation.get("media_path")
            current_version = creation.get("version")
            requested_version = reference.get("version")
            if not isinstance(media_path, str) or (
                requested_version is not None and requested_version != current_version
            ):
                raise FileNotFoundError(creation_id)
            paths.append(media_path)
            claims.append(
                {
                    "type": "creation",
                    "creation_id": creation_id,
                    "version": current_version,
                    **({"role": reference.get("role")} if reference.get("role") else {}),
                }
            )
            continue
        raise ValueError("invalid reference type")
    return paths, claims


def write_creation_request(project_path: Path, request_id: str, payload: dict[str, Any]) -> None:
    path = _request_path(project_path, request_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, {"request_id": request_id, **payload, "created_at": _now()})


def build_creation_export(
    project_path: Path,
    *,
    scope: ExportScope,
    creation_ids: list[str],
    request_id: str | None,
    creations: list[dict[str, Any]],
) -> Path:
    if scope == "selected":
        wanted = set(creation_ids)
        selected = [item for item in creations if item.get("creation_id") in wanted]
        if len(selected) != len(wanted):
            raise FileNotFoundError("one or more selected creations do not exist")
    elif scope == "request":
        if not request_id:
            raise ValueError("request_id is required")
        selected = [item for item in creations if item.get("request_id") == request_id]
    else:
        selected = creations

    adapter = ProjectArtifactManifestAdapter(project_path)
    exportable: list[tuple[dict[str, Any], Path]] = []
    for creation in selected:
        creation_id = creation.get("creation_id")
        media_path = creation.get("media_path")
        if creation.get("status") != "succeeded" or not isinstance(creation_id, str) or not isinstance(media_path, str):
            continue
        entry = adapter.get_entry(ArtifactKey.free_creation(creation_id))
        path = safe_join(project_path, media_path)
        if entry is None or entry.artifact_path != media_path or not path.is_file():
            continue
        exportable.append((creation, path))
    if not exportable:
        raise FileNotFoundError("no exportable creations")

    handle = tempfile.NamedTemporaryFile(prefix="matrixspooll-free-export-", suffix=".zip", delete=False)
    archive_path = Path(handle.name)
    handle.close()
    manifest: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for creation, path in exportable:
                creation_id = str(creation["creation_id"])
                filename = f"media/{creation_id}{path.suffix.lower()}"
                archive.write(path, filename)
                manifest.append(
                    {
                        "creation_id": creation_id,
                        "request_id": creation.get("request_id"),
                        "media_type": creation.get("media_type"),
                        "prompt": creation.get("prompt"),
                        "file": filename,
                    }
                )
            archive.writestr(
                "manifest.json",
                json.dumps({"scope": scope, "created_at": _now(), "creations": manifest}, ensure_ascii=False, indent=2),
            )
    except BaseException:
        archive_path.unlink(missing_ok=True)
        raise
    return archive_path


__all__ = [
    "MAX_REFERENCE_BYTES",
    "MAX_REFERENCE_PREVIEW_CHARS",
    "build_creation_export",
    "default_canvas_state",
    "delete_reference_upload",
    "detach_reference_upload",
    "extract_reference_text",
    "list_reference_uploads",
    "load_canvas_state",
    "new_request_id",
    "resolve_reference_claims",
    "read_reference_preview",
    "save_canvas_state",
    "save_reference_upload",
    "write_creation_request",
]
