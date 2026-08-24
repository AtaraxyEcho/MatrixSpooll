"""Persistent workspace state and input records for free creation projects."""

from __future__ import annotations

import hashlib
import json
import re
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
from lib.version_manager import VersionManager
from server.services.free_creation_index import invalidate_free_creation_index

ReferenceType = Literal["upload", "creation"]
ExportScope = Literal["selected", "request", "all"]
StoryboardPlanStatus = Literal["draft", "generating", "partial", "ready", "failed"]

_TEXT_REFERENCE_EXTENSIONS = frozenset({".txt", ".text", ".md", ".markdown", ".rtf", ".doc", ".docx", ".pdf", ".epub"})
_REFERENCE_EXTENSIONS = (
    frozenset({".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".wav", ".mp3"}) | _TEXT_REFERENCE_EXTENSIONS
)
MAX_REFERENCE_BYTES = 100 * 1024 * 1024
MAX_REFERENCE_PREVIEW_CHARS = 120_000
MAX_PLAIN_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
MAX_STORYBOARD_SHOTS = 12


def _now() -> str:
    return datetime.now(UTC).isoformat()


def new_request_id() -> str:
    return f"q_{uuid.uuid4().hex[:20]}"


def new_storyboard_plan_id() -> str:
    return f"sp_{uuid.uuid4().hex[:20]}"


def new_subtitle_id() -> str:
    return f"sub_{uuid.uuid4().hex[:20]}"


def new_reference_id() -> str:
    return f"r_{uuid.uuid4().hex[:20]}"


def _workspace_root(project_path: Path) -> Path:
    return safe_join(project_path, "free_creation")


def _canvas_state_path(project_path: Path) -> Path:
    return safe_join(_workspace_root(project_path), "canvas.json")


def _canvas_viewport_path(project_path: Path, user_id: str) -> Path:
    identity = hashlib.sha256(user_id.encode("utf-8")).hexdigest()
    return safe_join(_workspace_root(project_path), "user_state", f"{identity}.json")


def _request_path(project_path: Path, request_id: str) -> Path:
    return safe_join(_workspace_root(project_path), "requests", f"{request_id}.json")


def _reference_record_path(project_path: Path, reference_id: str) -> Path:
    return safe_join(_workspace_root(project_path), "references", f"{reference_id}.json")


def _storyboard_root(project_path: Path) -> Path:
    return safe_join(_workspace_root(project_path), "storyboards")


def _storyboard_plan_path(project_path: Path, plan_id: str) -> Path:
    return safe_join(_storyboard_root(project_path), f"{plan_id}.json")


def _subtitle_root(project_path: Path) -> Path:
    return safe_join(_workspace_root(project_path), "subtitles")


def _subtitle_path(project_path: Path, subtitle_id: str) -> Path:
    return safe_join(_subtitle_root(project_path), f"{subtitle_id}.json")


def split_storyboard_text(text: str, *, max_shots: int = MAX_STORYBOARD_SHOTS) -> list[str]:
    """Create an editable shot draft without requiring a text-model provider."""

    limit = max(1, min(max_shots, MAX_STORYBOARD_SHOTS))
    normalized = re.sub(r"[\t ]+", " ", text.replace("\r\n", "\n")).strip()
    if not normalized:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", normalized) if part.strip()]
    parts: list[str] = []
    for paragraph in paragraphs:
        sentences = [part.strip() for part in re.split(r"(?<=[.!?。！？])\s*", paragraph) if part.strip()]
        parts.extend(sentences or [paragraph])
    if len(parts) <= limit:
        return parts
    grouped: list[str] = []
    for index in range(limit):
        start = round(index * len(parts) / limit)
        end = round((index + 1) * len(parts) / limit)
        grouped.append(" ".join(parts[start:end]).strip())
    return [part for part in grouped if part]


def create_storyboard_plan(
    project_path: Path,
    *,
    title: str,
    source: dict[str, Any] | None,
    text: str,
    max_shots: int = MAX_STORYBOARD_SHOTS,
) -> dict[str, Any]:
    shots = [
        {
            "shot_id": f"shot_{index + 1:02d}",
            "sequence_index": index,
            "title": f"Shot {index + 1}",
            "prompt": prompt,
            "duration_seconds": 5,
            "image_creation_id": None,
            "video_creation_id": None,
        }
        for index, prompt in enumerate(split_storyboard_text(text, max_shots=max_shots))
    ]
    if not shots:
        raise ValueError("storyboard source is empty")
    plan = {
        "plan_id": new_storyboard_plan_id(),
        "title": title.strip() or "Untitled storyboard",
        "source": source or {"type": "prompt", "text": text},
        "revision": 1,
        "status": "draft",
        "shots": shots,
        "created_at": _now(),
        "updated_at": _now(),
    }
    with project_metadata_lock(project_path):
        path = _storyboard_plan_path(project_path, str(plan["plan_id"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, plan)
    return plan


def derive_storyboard_plan_status(
    project_path: Path,
    plan: dict[str, Any],
    *,
    load_creation: Any,
) -> StoryboardPlanStatus:
    """Compute a storyboard plan's current state from its linked creation artifacts."""

    shots = [shot for shot in plan.get("shots", []) if isinstance(shot, dict)]
    if not shots:
        return "draft"

    # Once video generation starts, it becomes the active stage. Missing output
    # IDs still count as unfinished shots instead of making a partial batch look
    # ready merely because every existing artifact succeeded.
    active_key = (
        "video_creation_id"
        if any(isinstance(shot.get("video_creation_id"), str) for shot in shots)
        else "image_creation_id"
    )
    creation_ids = [shot.get(active_key) for shot in shots]
    if not any(isinstance(creation_id, str) for creation_id in creation_ids):
        return "draft"

    statuses: list[str] = []
    for creation_id in creation_ids:
        if not isinstance(creation_id, str):
            statuses.append("missing")
            continue
        creation = load_creation(project_path, creation_id)
        statuses.append(
            str(creation.get("status") or "queued")
            if isinstance(creation, dict) and not creation.get("deleted_at")
            else "missing"
        )
    if any(status in {"queued", "running", "cancelling"} for status in statuses):
        return "generating"
    if all(status == "succeeded" for status in statuses):
        return "ready"
    if any(status == "succeeded" for status in statuses):
        return "partial"
    return "failed"


def load_storyboard_plan(project_path: Path, plan_id: str) -> dict[str, Any] | None:
    payload = load_json_or_none(_storyboard_plan_path(project_path, plan_id))
    if not isinstance(payload, dict) or payload.get("deleted_at"):
        return None
    return {**payload, "revision": max(1, int(payload.get("revision") or 1))}


def list_storyboard_plans(project_path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    root = _storyboard_root(project_path)
    if not root.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for path in sorted(root.glob("sp_*.json"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
        payload = load_json_or_none(path)
        if not isinstance(payload, dict) or payload.get("deleted_at") or not isinstance(payload.get("plan_id"), str):
            continue
        records.append({**payload, "revision": max(1, int(payload.get("revision") or 1))})
        if limit is not None and len(records) >= limit:
            break
    return records


def save_storyboard_plan(
    project_path: Path,
    plan: dict[str, Any],
    *,
    expected_revision: int | None = None,
) -> dict[str, Any]:
    plan_id = plan.get("plan_id")
    if not isinstance(plan_id, str):
        raise ValueError("storyboard plan id is required")
    with project_metadata_lock(project_path):
        path = _storyboard_plan_path(project_path, plan_id)
        current = load_json_or_none(path)
        if not isinstance(current, dict) or current.get("deleted_at"):
            raise FileNotFoundError(plan_id)
        revision = max(1, int(current.get("revision") or 1))
        if expected_revision is not None and expected_revision != revision:
            raise RuntimeError("free creation storyboard revision conflict")
        updated = {**plan, "revision": revision + 1, "updated_at": _now()}
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, updated)
    return updated


def delete_storyboard_plan(project_path: Path, plan_id: str) -> None:
    with project_metadata_lock(project_path):
        path = _storyboard_plan_path(project_path, plan_id)
        current = load_json_or_none(path)
        if not isinstance(current, dict) or current.get("deleted_at"):
            raise FileNotFoundError(plan_id)
        current["deleted_at"] = _now()
        current["updated_at"] = current["deleted_at"]
        atomic_write_json(path, current)


def create_subtitle_track(
    project_path: Path,
    *,
    creation_id: str,
    text: str,
    duration_seconds: float,
) -> dict[str, Any]:
    normalized = text.strip()
    if not normalized or duration_seconds <= 0:
        raise ValueError("subtitle text and duration are required")
    track = {
        "subtitle_id": new_subtitle_id(),
        "creation_id": creation_id,
        "revision": 1,
        "cues": [{"start_seconds": 0.0, "end_seconds": duration_seconds, "text": normalized}],
        "created_at": _now(),
        "updated_at": _now(),
    }
    with project_metadata_lock(project_path):
        path = _subtitle_path(project_path, str(track["subtitle_id"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, track)
    return track


def list_subtitle_tracks(project_path: Path, creation_id: str | None = None) -> list[dict[str, Any]]:
    root = _subtitle_root(project_path)
    if not root.is_dir():
        return []
    tracks: list[dict[str, Any]] = []
    for path in sorted(root.glob("sub_*.json"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
        track = load_json_or_none(path)
        if not isinstance(track, dict) or track.get("deleted_at"):
            continue
        if creation_id is None or track.get("creation_id") == creation_id:
            tracks.append(track)
    return tracks


def _format_webvtt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{millis:03d}"


def subtitle_track_webvtt(track: dict[str, Any]) -> str:
    """Serialize one free-creation subtitle track for download and editing tools."""

    lines = ["WEBVTT", ""]
    for index, cue in enumerate(track.get("cues", []), start=1):
        if not isinstance(cue, dict):
            continue
        start = cue.get("start_seconds")
        end = cue.get("end_seconds")
        text = cue.get("text")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not isinstance(text, str):
            continue
        lines.extend(
            [
                str(index),
                f"{_format_webvtt_timestamp(float(start))} --> {_format_webvtt_timestamp(float(end))}",
                text.strip(),
                "",
            ]
        )
    return "\n".join(lines)


def load_subtitle_track(project_path: Path, subtitle_id: str) -> dict[str, Any] | None:
    track = load_json_or_none(_subtitle_path(project_path, subtitle_id))
    return track if isinstance(track, dict) and not track.get("deleted_at") else None


def save_subtitle_track(
    project_path: Path,
    track: dict[str, Any],
    *,
    expected_revision: int | None = None,
) -> dict[str, Any]:
    subtitle_id = track.get("subtitle_id")
    if not isinstance(subtitle_id, str):
        raise ValueError("subtitle id is required")
    with project_metadata_lock(project_path):
        path = _subtitle_path(project_path, subtitle_id)
        current = load_json_or_none(path)
        if not isinstance(current, dict) or current.get("deleted_at"):
            raise FileNotFoundError(subtitle_id)
        revision = max(1, int(current.get("revision") or 1))
        if expected_revision is not None and expected_revision != revision:
            raise RuntimeError("free creation subtitle revision conflict")
        updated = {**track, "revision": revision + 1, "updated_at": _now()}
        atomic_write_json(path, updated)
    return updated


def delete_subtitle_track(project_path: Path, subtitle_id: str) -> None:
    with project_metadata_lock(project_path):
        path = _subtitle_path(project_path, subtitle_id)
        track = load_json_or_none(path)
        if not isinstance(track, dict) or track.get("deleted_at"):
            raise FileNotFoundError(subtitle_id)
        track["deleted_at"] = _now()
        track["updated_at"] = track["deleted_at"]
        atomic_write_json(path, track)


def default_canvas_state() -> dict[str, Any]:
    return {
        "revision": 0,
        "viewport": {"x": 0.0, "y": 0.0, "scale": 1.0},
        "positions": {},
        "hidden_creation_ids": [],
        "hidden_reference_ids": [],
        "groups": [],
        "show_relations": True,
        "node_revisions": {},
        "recent_patch_ids": [],
        "last_patch": None,
        "updated_at": None,
    }


def load_canvas_state(project_path: Path) -> dict[str, Any]:
    payload = load_json_or_none(_canvas_state_path(project_path))
    if not isinstance(payload, dict):
        return default_canvas_state()
    return {**default_canvas_state(), **payload}


def load_canvas_viewport(project_path: Path, user_id: str, fallback: dict[str, float]) -> dict[str, float]:
    """Load viewport state that belongs to one collaborator, not the project."""

    payload = load_json_or_none(_canvas_viewport_path(project_path, user_id))
    if not isinstance(payload, dict):
        return fallback
    viewport = payload.get("viewport")
    if not isinstance(viewport, dict):
        return fallback
    try:
        return {
            "x": float(viewport["x"]),
            "y": float(viewport["y"]),
            "scale": float(viewport["scale"]),
        }
    except (KeyError, TypeError, ValueError):
        return fallback


def save_canvas_viewport(project_path: Path, user_id: str, viewport: dict[str, float]) -> dict[str, float]:
    """Persist one collaborator's camera without changing shared canvas revision."""

    path = _canvas_viewport_path(project_path, user_id)
    with project_metadata_lock(project_path):
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, {"viewport": viewport, "updated_at": _now()})
    return viewport


def save_canvas_state(
    project_path: Path,
    *,
    viewport: dict[str, float],
    positions: dict[str, dict[str, float]],
    hidden_creation_ids: list[str],
    hidden_reference_ids: list[str] | None = None,
    groups: list[dict[str, Any]] | None = None,
    show_relations: bool = True,
    expected_revision: int | None,
    persist_viewport: bool = True,
) -> dict[str, Any]:
    with project_metadata_lock(project_path):
        current = load_canvas_state(project_path)
        revision = int(current.get("revision") or 0)
        if expected_revision is not None and expected_revision != revision:
            raise RuntimeError("free creation canvas revision conflict")
        shared_viewport = viewport if persist_viewport else current.get("viewport", default_canvas_state()["viewport"])
        shared_values = {
            "viewport": shared_viewport,
            "positions": positions,
            "hidden_creation_ids": sorted(set(hidden_creation_ids)),
            "hidden_reference_ids": sorted(set(hidden_reference_ids or [])),
            "groups": groups or [],
            "show_relations": show_relations,
        }
        if all(current.get(key) == value for key, value in shared_values.items()):
            return current
        payload = {
            **current,
            "revision": revision + 1,
            **shared_values,
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
    invalidate_free_creation_index(project_path)
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
    if record.get("detached_at") or record.get("deleted_at"):
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
        if (
            isinstance(record, dict)
            and isinstance(record.get("reference_id"), str)
            and not record.get("detached_at")
            and not record.get("deleted_at")
        ):
            records.append(record)
    return records


def load_reference_upload(project_path: Path, reference_id: str) -> dict[str, Any] | None:
    record = load_json_or_none(_reference_record_path(project_path, reference_id))
    if not isinstance(record, dict) or record.get("detached_at") or record.get("deleted_at"):
        return None
    return record


def restore_reference_upload(project_path: Path, reference_id: str) -> dict[str, Any]:
    """Restore a detached or soft-deleted upload for an undo operation."""

    record_path = _reference_record_path(project_path, reference_id)
    record = load_json_or_none(record_path)
    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
        raise FileNotFoundError(reference_id)
    with project_metadata_lock(project_path):
        record.pop("detached_at", None)
        record.pop("deleted_at", None)
        atomic_write_json(record_path, record)
    invalidate_free_creation_index(project_path)
    return record


def delete_reference_upload(project_path: Path, reference_id: str) -> None:
    """Soft-delete an upload without discarding provenance required for undo."""

    record_path = _reference_record_path(project_path, reference_id)
    record = load_json_or_none(record_path)
    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
        raise FileNotFoundError(reference_id)
    with project_metadata_lock(project_path):
        record["deleted_at"] = _now()
        atomic_write_json(record_path, record)
    invalidate_free_creation_index(project_path)


def _creation_version_resource_type(creation: dict[str, Any]) -> str:
    media_type = creation.get("media_type")
    if media_type == "audio" or (
        media_type not in {"image", "video", "audio"} and creation.get("output_type") == "audio"
    ):
        return "audio"
    if media_type == "video" or (media_type not in {"image", "video"} and creation.get("output_type") == "video"):
        return "free_videos"
    return "free_images"


def _resolve_creation_reference_path(
    project_path: Path,
    creation_id: str,
    creation: dict[str, Any],
    requested_version: object,
) -> tuple[str, int]:
    """Resolve a creation reference to its immutable version snapshot when available."""

    current_version = creation.get("version")
    if requested_version is not None and (type(requested_version) is not int or requested_version < 1):
        raise ValueError("invalid creation reference version")
    selected_version = requested_version if type(requested_version) is int else current_version
    resource_type = _creation_version_resource_type(creation)

    if type(selected_version) is int and selected_version > 0:
        history = VersionManager(project_path).get_versions(resource_type, creation_id)
        records = history.get("versions")
        snapshot = (
            next(
                (item for item in records if isinstance(item, dict) and item.get("version") == selected_version),
                None,
            )
            if isinstance(records, list)
            else None
        )
        snapshot_path = snapshot.get("file") if isinstance(snapshot, dict) else None
        if isinstance(snapshot_path, str):
            if not VersionManager.is_managed_snapshot_path(resource_type, snapshot_path):
                raise FileNotFoundError(creation_id)
            path = safe_join(project_path, snapshot_path)
            if not path.is_file():
                raise FileNotFoundError(creation_id)
            return snapshot_path, selected_version
        if requested_version is not None and selected_version != current_version:
            raise FileNotFoundError(creation_id)

    media_path = creation.get("media_path")
    if creation.get("status") != "succeeded" or not isinstance(media_path, str):
        raise FileNotFoundError(creation_id)
    path = safe_join(project_path, media_path)
    if not path.is_file():
        raise FileNotFoundError(creation_id)
    if type(selected_version) is not int or selected_version < 1:
        raise FileNotFoundError(creation_id)
    return media_path, selected_version


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
            if (
                not isinstance(record, dict)
                or not isinstance(record.get("path"), str)
                or record.get("detached_at")
                or record.get("deleted_at")
            ):
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
            if not isinstance(creation, dict) or creation.get("deleted_at"):
                raise FileNotFoundError(creation_id)
            media_path, selected_version = _resolve_creation_reference_path(
                project_path,
                creation_id,
                creation,
                reference.get("version"),
            )
            paths.append(media_path)
            claims.append(
                {
                    "type": "creation",
                    "creation_id": creation_id,
                    "version": selected_version,
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


def list_creation_requests(project_path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    root = safe_join(_workspace_root(project_path), "requests")
    if not root.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for path in sorted(root.glob("q_*.json"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
        record = load_json_or_none(path)
        if isinstance(record, dict) and isinstance(record.get("request_id"), str):
            records.append(record)
            if limit is not None and len(records) >= limit:
                break
    return records


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
                subtitle_files: list[str] = []
                for track in list_subtitle_tracks(project_path, creation_id):
                    subtitle_id = track.get("subtitle_id")
                    if not isinstance(subtitle_id, str):
                        continue
                    subtitle_filename = f"subtitles/{creation_id}-{subtitle_id}.vtt"
                    archive.writestr(subtitle_filename, subtitle_track_webvtt(track))
                    subtitle_files.append(subtitle_filename)
                manifest.append(
                    {
                        "creation_id": creation_id,
                        "request_id": creation.get("request_id"),
                        "media_type": creation.get("media_type"),
                        "prompt": creation.get("prompt"),
                        "file": filename,
                        "subtitles": subtitle_files,
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
    "MAX_STORYBOARD_SHOTS",
    "build_creation_export",
    "create_storyboard_plan",
    "create_subtitle_track",
    "derive_storyboard_plan_status",
    "delete_storyboard_plan",
    "default_canvas_state",
    "delete_reference_upload",
    "restore_reference_upload",
    "extract_reference_text",
    "list_creation_requests",
    "list_reference_uploads",
    "load_reference_upload",
    "list_storyboard_plans",
    "list_subtitle_tracks",
    "load_canvas_state",
    "load_canvas_viewport",
    "load_storyboard_plan",
    "load_subtitle_track",
    "new_request_id",
    "new_storyboard_plan_id",
    "resolve_reference_claims",
    "read_reference_preview",
    "save_canvas_state",
    "save_canvas_viewport",
    "save_reference_upload",
    "save_storyboard_plan",
    "save_subtitle_track",
    "subtitle_track_webvtt",
    "delete_subtitle_track",
    "split_storyboard_text",
    "write_creation_request",
]
