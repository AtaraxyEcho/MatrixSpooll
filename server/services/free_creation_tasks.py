"""Execution and metadata helpers for project-scoped free creation tasks."""

from __future__ import annotations

import asyncio
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from lib.artifact_manifest import ArtifactBasis, ArtifactKey, ArtifactManifest, ProjectArtifactManifestAdapter
from lib.async_thread import run_noninterruptible_sync
from lib.content_digest import prefixed_sha256_file
from lib.formal_write import project_metadata_lock
from lib.generation_queue import DispatchProviderChanged, free_video_capability, get_generation_queue
from lib.json_io import atomic_write_json, load_json_or_none
from lib.path_safety import safe_join
from lib.project_manager import get_project_manager
from lib.resource_paths import resource_relative_path
from lib.thumbnail import extract_video_thumbnail
from lib.version_manager import VersionManager
from server.services.free_creation_index import invalidate_free_creation_index
from server.services.free_creation_planner import plan_video_references
from server.services.free_creation_workspace import extract_reference_text
from server.services.generation_context import (
    AudioLaneRequest,
    ImageLaneRequest,
    VideoLaneRequest,
    resolve_generation_context,
)

FreeOutputType = Literal["image", "video", "edit", "audio"]
_IMAGE_REFERENCE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_TEXT_REFERENCE_SUFFIXES = frozenset({".txt", ".text", ".md", ".markdown", ".rtf", ".doc", ".docx", ".pdf", ".epub"})


def creation_metadata_path(project_path: Path, creation_id: str) -> Path:
    return safe_join(project_path, "creations", f"{creation_id}.json")


def creation_media_path(project_path: Path, creation_id: str, media_type: str) -> Path:
    if media_type == "audio":
        return safe_join(project_path, resource_relative_path("audio", creation_id))
    suffix = ".mp4" if media_type == "video" else ".png"
    return safe_join(project_path, "creations", f"{creation_id}{suffix}")


def write_creation_metadata(project_path: Path, creation_id: str, data: dict[str, Any]) -> None:
    path = creation_metadata_path(project_path, creation_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, data)
    invalidate_free_creation_index(project_path)


def load_creation_metadata(project_path: Path, creation_id: str) -> dict[str, Any] | None:
    data = load_json_or_none(creation_metadata_path(project_path, creation_id))
    return data if isinstance(data, dict) else None


def list_creation_metadata(project_path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    root = safe_join(project_path, "creations")
    if not root.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.json"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
        data = load_json_or_none(path)
        if isinstance(data, dict) and isinstance(data.get("creation_id"), str) and not data.get("deleted_at"):
            result.append(data)
            if limit is not None and len(result) >= limit:
                break
    return result


def delete_creation_metadata(project_path: Path, creation_id: str) -> dict[str, Any]:
    """Soft-delete a terminal creation so the workspace operation remains undoable."""

    path = creation_metadata_path(project_path, creation_id)
    with project_metadata_lock(project_path):
        data = load_json_or_none(path)
        if not isinstance(data, dict) or not isinstance(data.get("creation_id"), str):
            raise FileNotFoundError(creation_id)
        if data.get("status") in {"queued", "running", "cancelling"}:
            raise RuntimeError("active free creation cannot be deleted")
        if not data.get("deleted_at"):
            data["deleted_at"] = _now()
            atomic_write_json(path, data)
            invalidate_free_creation_index(project_path)
    return data


def restore_creation_metadata(project_path: Path, creation_id: str) -> dict[str, Any]:
    """Restore a soft-deleted creation for an undo operation."""

    path = creation_metadata_path(project_path, creation_id)
    with project_metadata_lock(project_path):
        data = load_json_or_none(path)
        if not isinstance(data, dict) or not isinstance(data.get("creation_id"), str):
            raise FileNotFoundError(creation_id)
        if data.pop("deleted_at", None) is not None:
            atomic_write_json(path, data)
            invalidate_free_creation_index(project_path)
    return data


def build_free_creation_basis(project_path: Path, metadata: dict[str, Any]) -> ArtifactBasis:
    """Freeze the request inputs that directly determine a free artifact."""

    references = metadata.get("references", [])
    claims = metadata.get("reference_claims", [])
    reference_offset = int(metadata.get("reference_role_offset") or 0)
    reference_digests: list[dict[str, Any]] = []
    if isinstance(references, list):
        for index, reference in enumerate(references):
            if isinstance(reference, str):
                reference_path = safe_join(project_path, reference)
                claim_index = index - reference_offset
                claim = (
                    claims[claim_index]
                    if isinstance(claims, list)
                    and 0 <= claim_index < len(claims)
                    and isinstance(claims[claim_index], dict)
                    else {}
                )
                reference_digests.append(
                    {
                        "digest": prefixed_sha256_file(reference_path),
                        "resource_order": index,
                        **{
                            key: claim[key]
                            for key in ("type", "reference_id", "creation_id", "version", "role")
                            if claim.get(key) is not None
                        },
                    }
                )
    return ArtifactBasis.build(
        "free-creation/request",
        kind_version=2,
        inputs={
            "request_id": metadata.get("request_id"),
            "prompt": metadata.get("prompt", ""),
            "prompt_mode": metadata.get("prompt_mode", "original"),
            "output_type": metadata.get("output_type"),
            "media_type": metadata.get("media_type"),
            "model": metadata.get("model"),
            "effective_mode": metadata.get("effective_mode"),
            "references": reference_digests,
            "aspect_ratio": metadata.get("aspect_ratio"),
            "resolution": metadata.get("resolution"),
            "size": metadata.get("size"),
            "duration_seconds": metadata.get("duration_seconds"),
            "quantity": metadata.get("quantity", 1),
            "storyboard_plan_id": metadata.get("storyboard_plan_id"),
            "storyboard_shot_id": metadata.get("storyboard_shot_id"),
            "sequence_index": metadata.get("sequence_index"),
        },
    )


def register_free_creation_artifact(project_path: Path, metadata: dict[str, Any]) -> None:
    """Register a generated media file in the shared project artifact manifest."""

    creation_id = metadata.get("creation_id")
    media_path = metadata.get("media_path")
    if not isinstance(creation_id, str) or not isinstance(media_path, str):
        raise ValueError("free creation metadata is missing its artifact identity")
    ArtifactManifest(ProjectArtifactManifestAdapter(project_path)).register(
        ArtifactKey.free_creation(creation_id),
        artifact_path=media_path,
        basis=build_free_creation_basis(project_path, metadata),
    )


def forget_free_creation_artifact(project_path: Path, creation_id: str) -> None:
    ArtifactManifest(ProjectArtifactManifestAdapter(project_path)).forget_entry_transactionally(
        ArtifactKey.free_creation(creation_id)
    )


def commit_free_creation_state(project_path: Path, metadata: dict[str, Any]) -> None:
    """Commit metadata and its formal claim with rollback across both sidecars."""

    creation_id = metadata.get("creation_id")
    if not isinstance(creation_id, str):
        raise ValueError("free creation metadata is missing its creation id")
    key = ArtifactKey.free_creation(creation_id)
    adapter = ProjectArtifactManifestAdapter(project_path)
    with project_metadata_lock(project_path):
        before = adapter.get_entry(key)
        try:
            register_free_creation_artifact(project_path, metadata)
            write_creation_metadata(project_path, creation_id, metadata)
        except BaseException as failure:
            after = adapter.get_entry(key)
            if after != before:
                try:
                    restored = adapter.replace_entries_if_matches_atomically(
                        expected={key: after},
                        replacements={key: before},
                    )
                    if not restored and adapter.get_entry(key) != before:
                        raise RuntimeError("free creation artifact rollback lost a concurrent update")
                except BaseException as rollback_failure:
                    rollback_failure.__cause__ = failure
                    raise RuntimeError("free creation metadata commit rollback was incomplete") from rollback_failure
            raise


def discard_free_creation_result(project_path: Path, metadata: dict[str, Any]) -> bool:
    """Reject a generated free result and remove its formal claim when cancellation wins."""

    creation_id = metadata.get("creation_id")
    output_type = metadata.get("output_type")
    media_type = metadata.get("media_type")
    version = metadata.get("version")
    media_path = metadata.get("media_path")
    if (
        not isinstance(creation_id, str)
        or output_type not in {"image", "video", "edit", "audio"}
        or type(version) is not int
        or version < 1
        or not isinstance(media_path, str)
    ):
        return False
    effective_media_type = (
        media_type if media_type in {"image", "video", "audio"} else ("video" if output_type == "video" else "image")
    )
    expected_media = creation_media_path(project_path, creation_id, effective_media_type)
    if media_path != expected_media.relative_to(project_path).as_posix():
        return False
    resource_type = {
        "video": "free_videos",
        "image": "free_images",
        "audio": "audio",
    }[effective_media_type]
    adapter = ProjectArtifactManifestAdapter(project_path)

    def _forget_claim() -> None:
        ArtifactManifest(adapter).forget_entry_transactionally(ArtifactKey.free_creation(creation_id))

    with project_metadata_lock(project_path):
        return VersionManager(project_path).reject_current_version(
            resource_type,
            creation_id,
            rejected_version=version,
            current_file=expected_media,
            on_reject=_forget_claim,
        )


async def _commit_generated_free_creation(
    project_path: Path,
    metadata: dict[str, Any],
    task_id: str | None,
) -> None:
    """Commit a result, then compensate its version if cancellation wins the final gate."""

    try:
        await _raise_if_cancel_requested(project_path, str(metadata["creation_id"]), task_id)
        await run_noninterruptible_sync(commit_free_creation_state, project_path, metadata)
        await _raise_if_cancel_requested(project_path, str(metadata["creation_id"]), task_id)
    except BaseException as failure:
        try:
            rejected = await run_noninterruptible_sync(discard_free_creation_result, project_path, metadata)
            if not rejected:
                failure.add_note("free creation result was not the current version during compensation")
        except BaseException as compensation_failure:
            compensation_failure.__cause__ = failure
            raise RuntimeError("free creation result compensation failed") from compensation_failure
        raise


def _now() -> str:
    return datetime.now(UTC).isoformat()


def new_creation_id() -> str:
    return f"c_{uuid.uuid4().hex[:20]}"


async def _raise_if_cancel_requested(
    project_path: Path,
    creation_id: str,
    task_id: str | None,
) -> None:
    metadata = load_creation_metadata(project_path, creation_id)
    if metadata and metadata.get("status") in {"cancelling", "cancelled"}:
        raise asyncio.CancelledError
    if task_id:
        task = await get_generation_queue().get_task(task_id)
        if task and task.get("status") in {"cancelling", "cancelled"}:
            raise asyncio.CancelledError


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


def _prompt_with_reference_context(prompt: str, references: list[Path]) -> str:
    context_blocks: list[str] = []
    remaining = 48_000
    for path in references:
        if path.suffix.lower() not in _TEXT_REFERENCE_SUFFIXES or remaining <= 0:
            continue
        text = extract_reference_text(path)
        if not text or not text.strip():
            continue
        bounded = text.strip()[:remaining]
        context_blocks.append(f"[{path.name}]\n{bounded}")
        remaining -= len(bounded)
    if not context_blocks:
        return prompt
    return f"{prompt}\n\nProject reference context:\n\n{chr(10).join(context_blocks)}"


async def execute_free_image_task(
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str,
    task_id: str | None = None,
    script_file: str | None = None,
    claimed_provider_id: str | None = None,
    commit_result: bool = True,
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
    generation_prompt = await asyncio.to_thread(_prompt_with_reference_context, prompt, references)
    image_references = [path for path in references if path.suffix.lower() in _IMAGE_REFERENCE_SUFFIXES]
    ctx = await resolve_generation_context(
        project_name,
        payload,
        project=project,
        project_path=project_path,
        user_id=user_id,
        image=ImageLaneRequest(capability="i2i" if image_references else "t2i"),
    )
    output_path, version = await ctx.generator.generate_image_async(
        prompt=generation_prompt,
        resource_type="free_images",
        resource_id=resource_id,
        reference_images=image_references,
        aspect_ratio=str(payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16"),
        image_size=payload.get("size") or payload.get("resolution") or ctx.image.resolution,
        task_id=task_id,
        source="free_creation",
        prompt_mode="original",
    )
    metadata = {
        "creation_id": resource_id,
        "request_id": payload.get("request_id"),
        "status": "succeeded",
        "output_type": "image",
        "media_type": "image",
        "prompt": prompt,
        "prompt_mode": "original",
        "model": f"{ctx.image.provider_model.provider_id}/{ctx.image.backend_model}",
        "references": payload.get("references") or [],
        "reference_claims": payload.get("reference_claims") or [],
        "effective_mode": payload.get("effective_mode"),
        "aspect_ratio": payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16",
        "resolution": payload.get("resolution"),
        "size": payload.get("size"),
        "quantity": int(payload.get("quantity") or 1),
        "storyboard_plan_id": payload.get("storyboard_plan_id"),
        "storyboard_shot_id": payload.get("storyboard_shot_id"),
        "sequence_index": payload.get("sequence_index"),
        "media_path": output_path.relative_to(project_path).as_posix(),
        "version": version,
        "task_id": task_id,
        "updated_at": _now(),
    }
    if commit_result:
        await _commit_generated_free_creation(project_path, metadata, task_id)
    return metadata


async def execute_free_audio_task(
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str,
    task_id: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    """Generate a voice asset as a versioned, project-scoped free creation."""

    pm = get_project_manager()
    project = await asyncio.to_thread(pm.load_project, project_name)
    project_path = pm.get_project_path(project_name)
    if project.get("content_mode") != "free":
        raise ValueError("free creation tasks require a free content mode project")
    text = str(payload.get("text") or payload.get("prompt") or "").strip()
    if not text:
        raise ValueError("voice text is required")
    ctx = await resolve_generation_context(
        project_name,
        payload,
        project=project,
        project_path=project_path,
        user_id=user_id,
        audio=AudioLaneRequest(),
    )
    requested_voice = str(payload.get("voice") or "").strip()
    voice = requested_voice or ctx.audio.narration_voice
    if requested_voice and requested_voice not in {item.id for item in ctx.audio.voices}:
        raise ValueError("voice is not supported by the selected audio backend")
    speed = ctx.audio.narration_speed
    output_path, version = await ctx.generator.generate_audio_async(
        text=text,
        resource_id=resource_id,
        voice=voice,
        speed=speed,
        task_id=task_id,
        source="free_creation",
    )
    metadata = {
        "creation_id": resource_id,
        "request_id": payload.get("request_id"),
        "status": "succeeded",
        "output_type": "audio",
        "media_type": "audio",
        "prompt": text,
        "prompt_mode": "original",
        "model": f"{ctx.audio.provider_model.provider_id}/{ctx.audio.backend_model}",
        "references": [],
        "reference_claims": [],
        "effective_mode": "text_to_speech",
        "voice": voice,
        "text": text,
        "quantity": 1,
        "media_path": output_path.relative_to(project_path).as_posix(),
        "version": version,
        "task_id": task_id,
        "updated_at": _now(),
    }
    await _commit_generated_free_creation(project_path, metadata, task_id)
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
    output_type: Literal["video", "edit"] = "video",
    parent_creation_id: str | None = None,
    commit_result: bool = True,
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
    reference_plan = plan_video_references(references, payload.get("reference_claims"))
    generation_prompt = await asyncio.to_thread(_prompt_with_reference_context, prompt, references)
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
        prompt=generation_prompt,
        resource_type="free_videos",
        resource_id=resource_id,
        start_image=reference_plan.start_image,
        end_image=reference_plan.end_image,
        reference_images=list(reference_plan.reference_images) or None,
        reference_videos=list(reference_plan.reference_videos) or None,
        reference_audio_files=list(reference_plan.reference_audio) or None,
        aspect_ratio=str(payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16"),
        duration_seconds=int(payload.get("duration_seconds") or 4),
        resolution=payload.get("resolution") or ctx.video.resolution,
        task_id=task_id,
        source="free_creation",
        prompt_mode="original",
    )
    cover_path = project_path / "free_creation" / "covers" / f"{resource_id}.jpg"
    extracted_cover = await extract_video_thumbnail(output_path, cover_path)
    metadata = {
        "creation_id": resource_id,
        "request_id": payload.get("request_id"),
        "status": "succeeded",
        "output_type": output_type,
        "media_type": "video",
        "prompt": prompt,
        "prompt_mode": "original",
        "model": f"{ctx.video.provider_model.provider_id}/{ctx.video.backend_model}",
        "references": payload.get("references") or [],
        "reference_claims": payload.get("reference_claims") or [],
        "effective_mode": payload.get("effective_mode"),
        "aspect_ratio": payload.get("aspect_ratio") or project.get("aspect_ratio") or "9:16",
        "resolution": payload.get("resolution"),
        "size": payload.get("size"),
        "quantity": int(payload.get("quantity") or 1),
        "duration_seconds": int(payload.get("duration_seconds") or 4),
        "parent_creation_id": parent_creation_id,
        "storyboard_plan_id": payload.get("storyboard_plan_id"),
        "storyboard_shot_id": payload.get("storyboard_shot_id"),
        "sequence_index": payload.get("sequence_index"),
        "media_path": output_path.relative_to(project_path).as_posix(),
        "cover_path": extracted_cover.relative_to(project_path).as_posix() if extracted_cover else None,
        "version": version,
        "task_id": task_id,
        "updated_at": _now(),
    }
    if commit_result:
        try:
            await _commit_generated_free_creation(project_path, metadata, task_id)
        except BaseException:
            if extracted_cover is not None:
                extracted_cover.unlink(missing_ok=True)
            raise
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
    project_path = pm.get_project_path(project_name)
    parent = await asyncio.to_thread(load_creation_metadata, project_path, parent_id)
    if not parent or parent.get("output_type") not in {"image", "video", "edit"}:
        raise ValueError("free_edit requires an existing free creation")
    parent_media_type = parent.get("media_type")
    if parent_media_type not in {"image", "video"}:
        parent_media_type = "video" if parent.get("output_type") == "video" else "image"
    if parent_media_type == "video":
        from lib.video_backends.base import VideoCapabilityError

        raise VideoCapabilityError("free_creation_video_edit_unsupported")
    parent_path = parent.get("media_path")
    if not isinstance(parent_path, str):
        raise ValueError("parent creation has no media path")
    additional_references = payload.get("references") or []
    if not isinstance(additional_references, list):
        additional_references = []
    claims = payload.get("reference_claims")
    parent_version = parent.get("version")
    parent_claim = {
        "type": "creation",
        "creation_id": parent_id,
        **({"version": parent_version} if type(parent_version) is int and parent_version > 0 else {}),
        "role": "reference_image",
    }
    has_parent_claim = (
        isinstance(claims, list)
        and bool(claims)
        and isinstance(claims[0], dict)
        and claims[0].get("creation_id") == parent_id
    )
    if has_parent_claim:
        references = additional_references
        normalized_claims = claims
    else:
        references = [parent_path, *additional_references]
        normalized_claims = [parent_claim, *claims] if isinstance(claims, list) else None
    payload = {**payload, "references": references, "reference_claims": normalized_claims}
    result = await execute_free_image_task(
        project_name,
        resource_id,
        payload,
        user_id=user_id,
        task_id=task_id,
        script_file=script_file,
        claimed_provider_id=claimed_provider_id,
        commit_result=False,
    )
    result["output_type"] = "edit"
    result["media_type"] = "image"
    result["parent_creation_id"] = parent_id
    await _commit_generated_free_creation(project_path, result, task_id)
    return result


async def execute_free_video_merge_task(
    project_name: str,
    resource_id: str,
    payload: dict[str, Any],
    *,
    user_id: str,
    task_id: str | None = None,
) -> dict[str, Any]:
    """Merge selected videos as a durable, project-scoped derived creation."""
    del user_id
    from server.services.free_creation_merge import merge_video_creations, resolve_merge_video_paths
    from server.services.free_creation_workspace import list_reference_uploads

    pm = get_project_manager()
    project_path = pm.get_project_path(project_name)
    item_ids = payload.get("item_ids")
    if not isinstance(item_ids, list) or not all(isinstance(item, str) for item in item_ids):
        raise ValueError("merge item_ids are required")
    creations = await asyncio.to_thread(list_creation_metadata, project_path, None)
    uploads = await asyncio.to_thread(list_reference_uploads, project_path)
    paths = await asyncio.to_thread(resolve_merge_video_paths, project_path, item_ids, creations, uploads)
    output, temporary_directory = await merge_video_creations(project_path, item_ids, creations, uploads)
    cover_path = project_path / "free_creation" / "covers" / f"{resource_id}.jpg"
    committed = False
    try:
        extracted_cover = await extract_video_thumbnail(output, cover_path)
        output_path = creation_media_path(project_path, resource_id, "video")
        claims: list[dict[str, Any]] = []
        creations_by_id = {
            item.get("creation_id"): item for item in creations if isinstance(item.get("creation_id"), str)
        }
        for item_id in item_ids:
            if item_id.startswith("c_"):
                source = creations_by_id.get(item_id) or {}
                claims.append(
                    {
                        "type": "creation",
                        "creation_id": item_id,
                        "version": source.get("version"),
                        "role": "reference_video",
                    }
                )
            else:
                claims.append({"type": "reference", "reference_id": item_id, "role": "reference_video"})
        metadata = {
            "creation_id": resource_id,
            "task_id": task_id,
            "status": "succeeded",
            "output_type": "video",
            "media_type": "video",
            "prompt": "",
            "prompt_mode": "original",
            "model": "local/ffmpeg",
            "references": [path.relative_to(project_path).as_posix() for path in paths],
            "reference_claims": claims,
            "effective_mode": "video_merge",
            "quantity": 1,
            "media_path": output_path.relative_to(project_path).as_posix(),
            "cover_path": extracted_cover.relative_to(project_path).as_posix() if extracted_cover else None,
            "version": 1,
            "updated_at": _now(),
        }
        VersionManager(project_path).commit_staged_version(
            "free_videos",
            resource_id,
            "",
            staged_file=output,
            current_file=output_path,
            on_commit=lambda: commit_free_creation_state(project_path, metadata),
            source="free_creation_video_merge",
        )
        committed = True
        return metadata
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        if not committed:
            cover_path.unlink(missing_ok=True)


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
    if task_type == "free_audio":
        return await execute_free_audio_task(
            project_name,
            resource_id,
            payload,
            user_id=user_id,
            task_id=task_id,
        )
    if task_type == "free_video_merge":
        return await execute_free_video_merge_task(
            project_name,
            resource_id,
            payload,
            user_id=user_id,
            task_id=task_id,
        )
    raise ValueError(f"unsupported free creation task type: {task_type}")


__all__ = [
    "creation_media_path",
    "creation_metadata_path",
    "commit_free_creation_state",
    "delete_creation_metadata",
    "discard_free_creation_result",
    "execute_free_creation_task",
    "execute_free_video_merge_task",
    "list_creation_metadata",
    "load_creation_metadata",
    "new_creation_id",
    "restore_creation_metadata",
    "write_creation_metadata",
]
