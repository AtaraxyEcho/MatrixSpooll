"""Execution and metadata helpers for project-scoped free creation tasks."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from lib.generation_queue import DispatchProviderChanged, free_video_capability
from lib.json_io import atomic_write_json, load_json_or_none
from lib.path_safety import safe_join
from lib.project_manager import get_project_manager
from server.services.generation_context import ImageLaneRequest, VideoLaneRequest, resolve_generation_context

FreeOutputType = Literal["image", "video", "edit"]
_IMAGE_REFERENCE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_AUDIO_REFERENCE_SUFFIXES = frozenset({".wav", ".mp3"})


def creation_metadata_path(project_path: Path, creation_id: str) -> Path:
    return safe_join(project_path, "creations", f"{creation_id}.json")


def creation_media_path(project_path: Path, creation_id: str, output_type: str) -> Path:
    suffix = ".mp4" if output_type == "video" else ".png"
    return safe_join(project_path, "creations", f"{creation_id}{suffix}")


def write_creation_metadata(project_path: Path, creation_id: str, data: dict[str, Any]) -> None:
    path = creation_metadata_path(project_path, creation_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, data)


def load_creation_metadata(project_path: Path, creation_id: str) -> dict[str, Any] | None:
    data = load_json_or_none(creation_metadata_path(project_path, creation_id))
    return data if isinstance(data, dict) else None


def list_creation_metadata(project_path: Path) -> list[dict[str, Any]]:
    root = safe_join(project_path, "creations")
    if not root.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.json"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
        data = load_json_or_none(path)
        if isinstance(data, dict) and isinstance(data.get("creation_id"), str):
            result.append(data)
    return result


def _now() -> str:
    return datetime.now(UTC).isoformat()


def new_creation_id() -> str:
    return f"c_{uuid.uuid4().hex[:20]}"


def _reference_paths(project_path: Path, payload: dict[str, Any]) -> list[Path]:
    raw = payload.get("references") or []
    if not isinstance(raw, list):
        raise ValueError("references must be an array")
    paths: list[Path] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise ValueError("reference paths must be non-empty strings")
        path = safe_join(project_path, item)
        if not path.is_file():
            raise ValueError(f"reference file does not exist: {item}")
        paths.append(path)
    return paths


async def execute_free_image_task(
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str,
    task_id: str | None = None,
    script_file: str | None = None,
    claimed_provider_id: str | None = None,
) -> dict[str, Any]:
    pm = get_project_manager()
    project = await asyncio.to_thread(pm.load_project, project_name)
    project_path = pm.get_project_path(project_name)
    if project.get("content_mode") != "free":
        raise ValueError("free creation tasks require a free content mode project")
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    references = await asyncio.to_thread(_reference_paths, project_path, payload)
    ctx = await resolve_generation_context(
        project_name,
        payload,
        project=project,
        project_path=project_path,
        user_id=user_id,
        image=ImageLaneRequest(capability="i2i" if references else "t2i"),
    )
    output_path, version = await ctx.generator.generate_image_async(
        prompt=prompt,
        resource_type="free_images",
        resource_id=resource_id,
        reference_images=references,
        aspect_ratio=str(payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16"),
        image_size=payload.get("resolution") or ctx.image.resolution,
        task_id=task_id,
        source="free_creation",
        prompt_mode="original",
    )
    metadata = {
        "creation_id": resource_id,
        "status": "succeeded",
        "output_type": "image",
        "prompt": prompt,
        "prompt_mode": "original",
        "references": payload.get("references") or [],
        "aspect_ratio": payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16",
        "media_path": output_path.relative_to(project_path).as_posix(),
        "version": version,
        "task_id": task_id,
        "updated_at": _now(),
    }
    await asyncio.to_thread(write_creation_metadata, project_path, resource_id, metadata)
    return metadata


async def execute_free_video_task(
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str,
    task_id: str | None = None,
    script_file: str | None = None,
    claimed_provider_id: str | None = None,
) -> dict[str, Any]:
    pm = get_project_manager()
    project = await asyncio.to_thread(pm.load_project, project_name)
    project_path = pm.get_project_path(project_name)
    if project.get("content_mode") != "free":
        raise ValueError("free creation tasks require a free content mode project")
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    references = await asyncio.to_thread(_reference_paths, project_path, payload)
    reference_images = [path for path in references if path.suffix.lower() in _IMAGE_REFERENCE_SUFFIXES]
    reference_audio = [path for path in references if path.suffix.lower() in _AUDIO_REFERENCE_SUFFIXES]
    ctx = await resolve_generation_context(
        project_name,
        payload,
        project=project,
        project_path=project_path,
        user_id=user_id,
        # A prompt-only request must be allowed to resolve a native text-to-video
        # model; reference inputs opt into the reference-video capability bucket.
        video=VideoLaneRequest(capability=free_video_capability(payload)),
    )
    if claimed_provider_id is not None and ctx.video.provider_model.provider_id != claimed_provider_id:
        raise DispatchProviderChanged(
            claimed_provider_id=claimed_provider_id,
            actual_provider_id=ctx.video.provider_model.provider_id,
        )
    output_path, version, _video_ref, _video_uri = await ctx.generator.generate_video_async(
        prompt=prompt,
        resource_type="free_videos",
        resource_id=resource_id,
        reference_images=reference_images or None,
        reference_audio_files=reference_audio or None,
        aspect_ratio=str(payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16"),
        duration_seconds=int(payload.get("duration_seconds") or 4),
        resolution=payload.get("resolution") or ctx.video.resolution,
        task_id=task_id,
        source="free_creation",
        prompt_mode="original",
    )
    metadata = {
        "creation_id": resource_id,
        "status": "succeeded",
        "output_type": "video",
        "prompt": prompt,
        "prompt_mode": "original",
        "references": payload.get("references") or [],
        "aspect_ratio": payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16",
        "duration_seconds": int(payload.get("duration_seconds") or 4),
        "media_path": output_path.relative_to(project_path).as_posix(),
        "version": version,
        "task_id": task_id,
        "updated_at": _now(),
    }
    await asyncio.to_thread(write_creation_metadata, project_path, resource_id, metadata)
    return metadata


async def execute_free_edit_task(
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str,
    task_id: str | None = None,
    script_file: str | None = None,
    claimed_provider_id: str | None = None,
) -> dict[str, Any]:
    parent_id = payload.get("parent_creation_id")
    if not isinstance(parent_id, str) or not parent_id:
        raise ValueError("parent_creation_id is required for free_edit")
    pm = get_project_manager()
    project = await asyncio.to_thread(pm.load_project, project_name)
    project_path = pm.get_project_path(project_name)
    parent = await asyncio.to_thread(load_creation_metadata, project_path, parent_id)
    if not parent or parent.get("output_type") not in {"image", "edit"}:
        raise ValueError("free_edit currently requires an existing image creation")
    parent_path = parent.get("media_path")
    if not isinstance(parent_path, str):
        raise ValueError("parent creation has no media path")
    additional_references = payload.get("references") or []
    payload = {**payload, "references": [parent_path, *additional_references]}
    result = await execute_free_image_task(
        project_name,
        resource_id,
        payload,
        user_id=user_id,
        task_id=task_id,
        script_file=script_file,
        claimed_provider_id=claimed_provider_id,
    )
    result["output_type"] = "edit"
    result["parent_creation_id"] = parent_id
    await asyncio.to_thread(write_creation_metadata, project_path, resource_id, result)
    return result


async def execute_free_creation_task(
    task_type: str,
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str,
    task_id: str | None = None,
    script_file: str | None = None,
    claimed_provider_id: str | None = None,
) -> dict[str, Any]:
    if task_type == "free_image":
        return await execute_free_image_task(
            project_name,
            resource_id,
            payload,
            user_id=user_id,
            task_id=task_id,
            script_file=script_file,
            claimed_provider_id=claimed_provider_id,
        )
    if task_type == "free_video":
        return await execute_free_video_task(
            project_name,
            resource_id,
            payload,
            user_id=user_id,
            task_id=task_id,
            script_file=script_file,
            claimed_provider_id=claimed_provider_id,
        )
    if task_type == "free_edit":
        return await execute_free_edit_task(
            project_name,
            resource_id,
            payload,
            user_id=user_id,
            task_id=task_id,
            script_file=script_file,
            claimed_provider_id=claimed_provider_id,
        )
    raise ValueError(f"unsupported free creation task type: {task_type}")


__all__ = [
    "creation_media_path",
    "creation_metadata_path",
    "execute_free_creation_task",
    "list_creation_metadata",
    "load_creation_metadata",
    "new_creation_id",
    "write_creation_metadata",
]
