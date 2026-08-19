"""Project-scoped API for direct free creation requests."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from lib.api_errors import BadRequestError, ConflictError, NotFoundError
from lib.aspect_size import is_valid_aspect_ratio
from lib.config.registry import model_info_for
from lib.config.resolver import VideoBucketCapabilityError
from lib.db import async_session_factory
from lib.generation_queue import free_video_capability, get_generation_queue
from lib.generation_queue_client import TaskSpec
from lib.image_backends.base import ImageCapabilityError
from lib.path_safety import PathTraversalError, safe_join
from lib.project_change_hints import project_change_source
from lib.project_manager import get_project_manager
from lib.video_backends.base import VideoCapabilityError
from server.auth import CurrentUser, CurrentUserFlexible
from server.services.free_creation_tasks import (
    list_creation_metadata,
    load_creation_metadata,
    new_creation_id,
    write_creation_metadata,
)
from server.services.generation_context import ImageLaneRequest, VideoLaneRequest, resolve_generation_context

router = APIRouter()
entry_router = APIRouter()
self_auth_router = APIRouter()
logger = logging.getLogger(__name__)

FreeOutputType = Literal["image", "video", "edit"]
PromptMode = Literal["original"]
CreationId = Annotated[str, PathParam(pattern=r"^c_[a-f0-9]{20}$")]
_IMAGE_REFERENCE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_AUDIO_REFERENCE_SUFFIXES = frozenset({".wav", ".mp3"})
_VIDEO_REFERENCE_SUFFIXES = frozenset({".mp4", ".mov"})


class FreeCreationRequest(BaseModel):
    output_type: FreeOutputType
    prompt: str = Field(min_length=1, max_length=10000)
    references: list[str] = Field(default_factory=list, max_length=8)
    aspect_ratio: str | None = Field(default=None, min_length=3, max_length=32)
    resolution: str | None = Field(default=None, max_length=32)
    size: str | None = Field(default=None, max_length=32)
    model: str | None = Field(default=None, max_length=200)
    quantity: int = Field(default=1, ge=1, le=4)
    duration_seconds: int | None = Field(default=None, gt=0, le=30)
    parent_creation_id: str | None = Field(default=None, pattern=r"^c_[a-f0-9]{20}$")
    prompt_mode: PromptMode = "original"

    @field_validator("prompt")
    @classmethod
    def normalize_prompt(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("prompt must not be blank")
        return value

    @field_validator("aspect_ratio")
    @classmethod
    def validate_aspect_ratio(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not is_valid_aspect_ratio(value):
            raise ValueError("aspect_ratio must be a positive width:height ratio")
        return value.strip().replace("：", ":")

    @model_validator(mode="after")
    def validate_output_options(self) -> FreeCreationRequest:
        if self.output_type == "edit" and not self.parent_creation_id:
            raise ValueError("parent_creation_id is required for edit")
        if self.output_type != "edit" and self.parent_creation_id is not None:
            raise ValueError("parent_creation_id is only supported for edit")
        if self.output_type == "image" and self.duration_seconds is not None:
            raise ValueError("duration_seconds is only supported for video")
        if self.output_type == "video" and self.size is not None:
            raise ValueError("size is only supported for image or edit")
        if self.output_type == "edit" and self.quantity != 1:
            raise ValueError("quantity is only supported for image or video")
        return self


class CreateFreeProjectRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    creation: FreeCreationRequest

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("title must not be blank")
        return value


def _load_free_project(project_name: str) -> tuple[dict, Path]:
    pm = get_project_manager()
    if not pm.project_exists(project_name):
        raise NotFoundError("project_not_found", name=project_name)
    project = pm.load_project(project_name)
    if project.get("content_mode") != "free":
        raise ConflictError("free_creation_project_required")
    return project, pm.get_project_path(project_name)


def _validate_references(project_path: Path, references: list[str], media_type: Literal["image", "video"]) -> None:
    for reference in references:
        if not reference.strip():
            raise BadRequestError("free_creation_reference_invalid")
        try:
            path = safe_join(project_path, reference)
        except PathTraversalError as exc:
            raise BadRequestError("free_creation_reference_invalid") from exc
        if not path.is_file():
            raise NotFoundError("file_not_found", path=reference)
        allowed_suffixes = (
            _IMAGE_REFERENCE_SUFFIXES | _AUDIO_REFERENCE_SUFFIXES | _VIDEO_REFERENCE_SUFFIXES
            if media_type == "video"
            else _IMAGE_REFERENCE_SUFFIXES
        )
        if path.suffix.lower() not in allowed_suffixes:
            raise BadRequestError("free_creation_reference_type_unsupported", type=path.suffix.lower() or "unknown")


def _merge_metadata(project_path: Path, creation_id: str, patch: dict) -> dict:
    current = load_creation_metadata(project_path, creation_id) or {}
    current.update(patch)
    write_creation_metadata(project_path, creation_id, current)
    return current


def _record_enqueued_metadata(
    project_path: Path,
    creation_id: str,
    task_id: str,
    request_metadata: dict,
) -> dict[str, Any]:
    current = load_creation_metadata(project_path, creation_id) or {}
    if current.get("task_id") == task_id:
        if current.get("status") in {"succeeded", "failed", "cancelled"}:
            return current
        if current.get("status") == "running":
            for key, value in request_metadata.items():
                current.setdefault(key, value)
            write_creation_metadata(project_path, creation_id, current)
            return current
    current.update(request_metadata)
    current.update({"status": "queued", "task_id": task_id})
    current.pop("error", None)
    write_creation_metadata(project_path, creation_id, current)
    return current


def _record_batch_compensation(
    project_path: Path,
    creation_id: str,
    task_id: str,
    request_metadata: dict[str, Any],
    status: Literal["cancelling", "cancelled"],
) -> None:
    current = load_creation_metadata(project_path, creation_id) or {}
    current_task_id = current.get("task_id")
    if current_task_id is not None and current_task_id != task_id:
        return
    if current.get("status") in {"succeeded", "failed", "cancelled"}:
        return
    write_creation_metadata(
        project_path,
        creation_id,
        {
            **request_metadata,
            **current,
            "creation_id": creation_id,
            "task_id": task_id,
            "status": status,
        },
    )


async def _compensate_partial_batch(project_path: Path, enqueued: list[dict[str, Any]]) -> None:
    queue = get_generation_queue()
    for item in enqueued:
        task_id = item["task_id"]
        creation_id = item["creation_id"]
        try:
            result = await queue.cancel_task(task_id)
            if result.get("cancelled") or result.get("cancelling"):
                status = "cancelled" if result.get("cancelled") else "cancelling"
                await asyncio.to_thread(
                    _record_batch_compensation,
                    project_path,
                    creation_id,
                    task_id,
                    item["metadata"],
                    status,
                )
        except Exception:
            logger.exception("free creation batch compensation failed task_id=%s", task_id)


def _free_request_payload(req: FreeCreationRequest, media_type: Literal["image", "video"]) -> dict[str, Any]:
    payload = {
        "output_type": req.output_type,
        "references": req.references,
        "aspect_ratio": req.aspect_ratio,
        "resolution": req.resolution,
        "size": req.size,
        "duration_seconds": req.duration_seconds,
        "parent_creation_id": req.parent_creation_id,
        "prompt_mode": req.prompt_mode,
    }
    if req.model:
        provider, separator, model = req.model.partition("/")
        if not separator or not provider or not model:
            raise BadRequestError("request_invalid")
        payload["video_provider" if media_type == "video" else "image_provider"] = provider
        payload["video_model" if media_type == "video" else "image_model"] = model
        payload["model"] = req.model
    return payload


def _validate_declared_resolution(provider_id: str, model_id: str, requested: str | None) -> None:
    """Reject a resolution only when the selected built-in model declares a whitelist."""

    if not requested:
        return
    model_info = model_info_for(provider_id, model_id)
    supported = tuple(model_info.resolutions) if model_info is not None else ()
    if supported and requested.casefold() not in {item.casefold() for item in supported}:
        raise BadRequestError(
            "free_creation_resolution_not_supported",
            model=f"{provider_id}/{model_id}",
            resolution=requested,
            supported=", ".join(supported),
        )


async def _preflight_free_creation(
    project_name: str,
    project: dict,
    project_path: Path,
    req: FreeCreationRequest,
    *,
    media_type: Literal["image", "video"],
    parent_media_path: str | None = None,
    user_id: str,
) -> dict[str, Any]:
    """Resolve the selected lane and reject known capability failures before enqueue."""

    payload = _free_request_payload(req, media_type)
    capability_payload = {
        **payload,
        "references": ([parent_media_path] if parent_media_path else []) + list(req.references),
    }
    try:
        if media_type == "video":
            ctx = await resolve_generation_context(
                project_name,
                payload,
                project=project,
                project_path=project_path,
                user_id=user_id,
                video=VideoLaneRequest(capability=free_video_capability(capability_payload)),
            )
            reference_names = capability_payload["references"]
            image_count = sum(Path(item).suffix.lower() in _IMAGE_REFERENCE_SUFFIXES for item in reference_names)
            video_count = sum(Path(item).suffix.lower() in _VIDEO_REFERENCE_SUFFIXES for item in reference_names)
            duration = req.duration_seconds or 4
            supported = (
                ctx.video.supported_durations_with_reference_video
                if video_count and ctx.video.supported_durations_with_reference_video
                else ctx.video.supported_durations
            )
            if supported and duration not in supported:
                raise VideoCapabilityError(
                    "video_duration_not_supported",
                    duration=duration,
                    supported=", ".join(str(item) for item in supported),
                )
            if not ctx.video.supported_aspect_ratios:
                raise VideoCapabilityError(
                    "free_creation_aspect_ratio_capabilities_missing",
                    model=f"{ctx.video.provider_model.provider_id}/{ctx.video.backend_model}",
                )
            effective_ratio = req.aspect_ratio or project.get("aspect_ratio") or "9:16"
            if effective_ratio not in ctx.video.supported_aspect_ratios:
                raise VideoCapabilityError(
                    "free_creation_aspect_ratio_not_supported",
                    ratio=effective_ratio,
                    model=f"{ctx.video.provider_model.provider_id}/{ctx.video.backend_model}",
                    supported=", ".join(ctx.video.supported_aspect_ratios),
                )
            if ctx.video.max_reference_images is not None and image_count:
                if ctx.video.max_reference_images <= 0:
                    raise VideoCapabilityError(
                        "video_reference_images_unsupported",
                        provider=ctx.video.provider_model.provider_id,
                        model=ctx.video.backend_model,
                    )
                if image_count > ctx.video.max_reference_images:
                    raise VideoCapabilityError(
                        "video_reference_images_exceeded",
                        model=ctx.video.backend_model,
                        limit=ctx.video.max_reference_images,
                        count=image_count,
                    )
            if ctx.video.max_reference_videos is not None and video_count:
                if ctx.video.max_reference_videos <= 0:
                    raise VideoCapabilityError(
                        "video_reference_videos_unsupported",
                        provider=ctx.video.provider_model.provider_id,
                        model=ctx.video.backend_model,
                    )
                if video_count > ctx.video.max_reference_videos:
                    raise VideoCapabilityError(
                        "video_reference_videos_exceeded",
                        model=ctx.video.backend_model,
                        limit=ctx.video.max_reference_videos,
                        count=video_count,
                    )
            if (
                ctx.video.max_reference_media_count is not None
                and image_count + video_count > ctx.video.max_reference_media_count
            ):
                raise VideoCapabilityError(
                    "video_reference_media_exceeded",
                    model=ctx.video.backend_model,
                    limit=ctx.video.max_reference_media_count,
                    count=image_count + video_count,
                )
            _validate_declared_resolution(
                ctx.video.provider_model.provider_id,
                ctx.video.backend_model,
                req.resolution,
            )
            payload["model"] = f"{ctx.video.provider_model.provider_id}/{ctx.video.backend_model}"
        else:
            ctx = await resolve_generation_context(
                project_name,
                payload,
                project=project,
                project_path=project_path,
                user_id=user_id,
                image=ImageLaneRequest(capability="i2i" if req.output_type == "edit" else "t2i"),
            )
            _validate_declared_resolution(
                ctx.image.provider_model.provider_id,
                ctx.image.backend_model,
                req.resolution,
            )
            payload["model"] = f"{ctx.image.provider_model.provider_id}/{ctx.image.backend_model}"
    except (ImageCapabilityError, VideoCapabilityError, VideoBucketCapabilityError) as exc:
        raise BadRequestError(exc.code, **exc.params) from exc
    except ValueError as exc:
        raise BadRequestError("request_invalid") from exc
    return payload


@entry_router.get("/free-creation-capabilities")
async def get_free_creation_capabilities(
    output_type: Literal["image", "video"] = Query(default="video"),
    model: str | None = Query(default=None, max_length=200),
    reference_kind: Literal["none", "image", "video"] = Query(default="none"),
):
    """Return the effective model capabilities used by the free composer."""

    from lib.config.resolver import ConfigResolver

    payload: dict[str, Any] = {}
    if model:
        provider, separator, model_id = model.partition("/")
        if not separator or not provider or not model_id:
            raise BadRequestError("request_invalid")
        payload["video_provider" if output_type == "video" else "image_provider"] = provider
        payload["video_model" if output_type == "video" else "image_model"] = model_id
    resolver = ConfigResolver(async_session_factory)
    project = {"content_mode": "free", "generation_mode": None}
    try:
        if output_type == "video":
            capability = "r2v" if reference_kind in {"image", "video"} else None
            resolved = await resolver.resolve_video_backend(project, payload, capability=capability)
            caps = await resolver.video_capabilities_for_model(resolved.provider_id, resolved.model_id, project)
            info = model_info_for(resolved.provider_id, resolved.model_id)
            ratios = list(caps.get("supported_aspect_ratios") or [])
            if not ratios:
                raise VideoCapabilityError(
                    "free_creation_aspect_ratio_capabilities_missing",
                    model=f"{resolved.provider_id}/{resolved.model_id}",
                )
            resolutions = list(info.resolutions) if info is not None else []
            if not resolutions:
                default_resolution = await resolver.resolve_resolution(project, resolved.provider_id, resolved.model_id)
                if default_resolution:
                    resolutions = [default_resolution]
            return {
                "output_type": "video",
                "model": f"{resolved.provider_id}/{resolved.model_id}",
                "ratios": ratios,
                "resolutions": resolutions,
                "durations": list(
                    (caps.get("supported_durations_with_reference_video") if reference_kind == "video" else None)
                    or caps.get("supported_durations")
                    or []
                ),
                "max_reference_images": caps.get("max_reference_images"),
                "max_reference_videos": caps.get("max_reference_videos"),
                "max_reference_media_count": caps.get("max_reference_media_count"),
            }
        resolved = await resolver.resolve_image_backend(project, payload, capability="t2i")
        info = model_info_for(resolved.provider_id, resolved.model_id)
        return {
            "output_type": "image",
            "model": f"{resolved.provider_id}/{resolved.model_id}",
            "ratios": [],
            "resolutions": list(info.resolutions) if info is not None else [],
            "durations": [],
            "max_reference_images": None,
            "max_reference_videos": None,
            "max_reference_media_count": None,
        }
    except (ValueError, ImageCapabilityError, VideoCapabilityError, VideoBucketCapabilityError) as exc:
        code = getattr(exc, "code", "free_creation_capabilities_unavailable")
        params = getattr(exc, "params", {})
        raise BadRequestError(code, **params) from exc


@router.post("/projects/{project_name}/creations")
async def create_free_creation(project_name: str, req: FreeCreationRequest, user: CurrentUser):
    project, project_path = await asyncio.to_thread(_load_free_project, project_name)
    parent: dict[str, Any] | None = None
    parent_media_path: str | None = None
    media_type: Literal["image", "video"] = "video" if req.output_type == "video" else "image"
    if req.parent_creation_id:
        parent = await asyncio.to_thread(load_creation_metadata, project_path, req.parent_creation_id)
        if not parent or parent.get("output_type") not in {"image", "video", "edit"}:
            raise NotFoundError("free_creation_parent_not_found", id=req.parent_creation_id)
        raw_media_type = parent.get("media_type")
        media_type = (
            raw_media_type
            if raw_media_type in {"image", "video"}
            else ("video" if parent.get("output_type") == "video" else "image")
        )
        parent_media = parent.get("media_path")
        parent_media_path = parent_media if isinstance(parent_media, str) else None
        try:
            parent_path = safe_join(project_path, parent_media) if isinstance(parent_media, str) else None
        except PathTraversalError as exc:
            raise NotFoundError("free_creation_parent_not_found", id=req.parent_creation_id) from exc
        if parent_path is None or not parent_path.is_file():
            raise NotFoundError("free_creation_parent_not_found", id=req.parent_creation_id)

    await asyncio.to_thread(_validate_references, project_path, req.references, media_type)
    if media_type == "image" and req.duration_seconds is not None:
        raise BadRequestError("request_invalid")
    if media_type == "video" and req.size is not None:
        raise BadRequestError("request_invalid")

    request_payload = await _preflight_free_creation(
        project_name,
        project,
        project_path,
        req,
        media_type=media_type,
        parent_media_path=parent_media_path,
        user_id=user.id,
    )
    task_type = {"image": "free_image", "video": "free_video", "edit": "free_edit"}[req.output_type]
    enqueued: list[dict[str, Any]] = []
    task_payload = {
        **request_payload,
        "media_type": media_type,
        "references": ([parent_media_path] if parent_media_path else []) + list(req.references),
    }
    try:
        for _ in range(req.quantity):
            creation_id = new_creation_id()
            spec = TaskSpec.from_request(
                task_type=task_type,
                media_type=media_type,
                resource_id=creation_id,
                prompt=req.prompt.strip(),
                source="webui",
                extra_payload={
                    "output_type": req.output_type,
                    **task_payload,
                },
            )
            queue_result = await get_generation_queue().enqueue_task(
                project_name=project_name,
                task_type=spec.task_type,
                media_type=spec.media_type,
                resource_id=spec.resource_id,
                payload=spec.payload,
                source=spec.source,
                user_id=user.id,
            )
            task_id = str(queue_result["task_id"])
            metadata = {
                "creation_id": creation_id,
                "output_type": req.output_type,
                "media_type": media_type,
                "prompt": req.prompt.strip(),
                "prompt_mode": req.prompt_mode,
                "references": task_payload["references"],
                "aspect_ratio": req.aspect_ratio or project.get("aspect_ratio") or "9:16",
                "resolution": req.resolution,
                "size": req.size,
                "model": request_payload.get("model"),
                "duration_seconds": req.duration_seconds,
                "parent_creation_id": req.parent_creation_id,
            }
            enqueued.append({"creation_id": creation_id, "task_id": task_id, "metadata": metadata})
            await asyncio.to_thread(
                _record_enqueued_metadata,
                project_path,
                creation_id,
                task_id,
                metadata,
            )
    except asyncio.CancelledError:
        await _compensate_partial_batch(project_path, enqueued)
        raise
    except Exception:
        await _compensate_partial_batch(project_path, enqueued)
        raise
    created = [{"creation_id": item["creation_id"], "task_id": item["task_id"]} for item in enqueued]
    return {
        "success": True,
        "creation_id": created[0]["creation_id"],
        "task_id": created[0]["task_id"],
        "creations": created,
    }


@entry_router.post("/free-projects")
async def create_free_project(req: CreateFreeProjectRequest, user: CurrentUser):
    """Create a free project and enqueue its first creation as one application operation."""

    manager = get_project_manager()
    title = req.title.strip()
    project_name = manager.generate_project_name(title)
    try:

        def _create() -> dict[str, Any]:
            manager.create_project(project_name, content_mode="free")
            try:
                extras: dict[str, Any] = {"generation_mode": None, "grid_storyboard": False}
                if req.creation.model:
                    backend_key = "video_backend" if req.creation.output_type == "video" else "default_image_backend"
                    extras[backend_key] = req.creation.model
                with project_change_source("webui"):
                    return manager.create_project_metadata(
                        project_name,
                        title,
                        "",
                        "free",
                        aspect_ratio=req.creation.aspect_ratio or "9:16",
                        extras=extras,
                    )
            except BaseException:
                manager.delete_project_directory(project_name)
                raise

        project = await asyncio.to_thread(_create)
        try:
            result = await create_free_creation(project_name, req.creation, user)
        except BaseException:
            await asyncio.to_thread(manager.delete_project_directory, project_name)
            raise
    except FileExistsError as exc:
        raise ConflictError("project_exists", name=project_name) from exc
    return {**result, "name": project_name, "project": project}


@router.get("/projects/{project_name}/creations")
async def list_free_creations(project_name: str, limit: int = Query(default=40, ge=1, le=100)):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    return {"creations": await asyncio.to_thread(list_creation_metadata, project_path, limit)}


@router.get("/projects/{project_name}/creations/{creation_id}")
async def get_free_creation(project_name: str, creation_id: CreationId):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    creation = await asyncio.to_thread(load_creation_metadata, project_path, creation_id)
    if creation is None:
        raise NotFoundError("free_creation_not_found", id=creation_id)
    return {"creation": creation}


@self_auth_router.get("/projects/{project_name}/creations/{creation_id}/media")
async def get_free_creation_media(project_name: str, creation_id: CreationId, _user: CurrentUserFlexible):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    creation = await asyncio.to_thread(load_creation_metadata, project_path, creation_id)
    if creation is None:
        raise NotFoundError("free_creation_not_found", id=creation_id)
    media_path = creation.get("media_path")
    if not isinstance(media_path, str):
        raise NotFoundError("free_creation_media_not_found", id=creation_id)
    try:
        path = safe_join(project_path, media_path)
    except PathTraversalError as exc:
        raise NotFoundError("free_creation_media_not_found", id=creation_id) from exc
    if not path.is_file():
        raise NotFoundError("free_creation_media_not_found", id=creation_id)
    media_type = (
        "video/mp4" if creation.get("media_type") == "video" or creation.get("output_type") == "video" else "image/png"
    )
    return FileResponse(path, media_type=media_type)


@router.post("/projects/{project_name}/creations/{creation_id}/cancel")
async def cancel_free_creation(project_name: str, creation_id: CreationId):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    creation = await asyncio.to_thread(load_creation_metadata, project_path, creation_id)
    if creation is None:
        raise NotFoundError("free_creation_not_found", id=creation_id)
    status = creation.get("status")
    if status == "cancelled":
        return {"success": True, "creation": creation}
    if status not in {"queued", "running"}:
        raise ConflictError("free_creation_cancel_not_ready")
    task_id = creation.get("task_id")
    cancel_result: dict[str, bool] = {"cancelled": True}
    if isinstance(task_id, str) and task_id:
        cancel_result = await get_generation_queue().cancel_task(task_id)
        if not cancel_result.get("cancelled") and not cancel_result.get("cancelling"):
            refreshed = await asyncio.to_thread(load_creation_metadata, project_path, creation_id)
            if refreshed and refreshed.get("status") == "cancelled":
                return {"success": True, "creation": refreshed}
            raise ConflictError("free_creation_cancel_not_ready")
    requested_status = "cancelled" if cancel_result.get("cancelled") else "cancelling"
    updated = await asyncio.to_thread(
        _merge_metadata,
        project_path,
        creation_id,
        {"status": requested_status},
    )
    return {"success": True, "creation": updated}


@router.post("/projects/{project_name}/creations/{creation_id}/retry")
async def retry_free_creation(project_name: str, creation_id: CreationId, user: CurrentUser):
    project, project_path = await asyncio.to_thread(_load_free_project, project_name)
    creation = await asyncio.to_thread(load_creation_metadata, project_path, creation_id)
    if creation is None:
        raise NotFoundError("free_creation_not_found", id=creation_id)
    if creation.get("status") not in {"failed", "cancelled"}:
        raise ConflictError("free_creation_retry_not_ready")
    output_type = creation.get("output_type")
    prompt = creation.get("prompt")
    if output_type not in {"image", "video", "edit"} or not isinstance(prompt, str) or not prompt.strip():
        raise BadRequestError("request_invalid")
    references = creation.get("references") or []
    if not isinstance(references, list) or not all(isinstance(item, str) for item in references):
        raise BadRequestError("free_creation_reference_invalid")
    raw_media_type = creation.get("media_type")
    media_type: Literal["image", "video"] = (
        raw_media_type if raw_media_type in {"image", "video"} else ("video" if output_type == "video" else "image")
    )
    parent_media_path: str | None = None
    if output_type == "edit":
        parent_id = creation.get("parent_creation_id")
        if not isinstance(parent_id, str):
            raise BadRequestError("request_invalid")
        parent = await asyncio.to_thread(load_creation_metadata, project_path, parent_id)
        if not parent or parent.get("output_type") not in {"image", "video", "edit"}:
            raise NotFoundError("free_creation_parent_not_found", id=parent_id)
        parent_type = parent.get("media_type")
        media_type = (
            parent_type
            if parent_type in {"image", "video"}
            else ("video" if parent.get("output_type") == "video" else "image")
        )
        parent_media = parent.get("media_path")
        try:
            parent_path = safe_join(project_path, parent_media) if isinstance(parent_media, str) else None
        except PathTraversalError as exc:
            raise NotFoundError("free_creation_parent_not_found", id=parent_id) from exc
        if parent_path is None or not parent_path.is_file():
            raise NotFoundError("free_creation_parent_not_found", id=parent_id)
        parent_media_path = parent_media
    request_references = [item for item in references if item != parent_media_path]
    await asyncio.to_thread(_validate_references, project_path, request_references, media_type)
    retry_request = FreeCreationRequest(
        output_type=output_type,
        prompt=prompt,
        references=request_references,
        aspect_ratio=creation.get("aspect_ratio") or project.get("aspect_ratio"),
        resolution=creation.get("resolution"),
        size=creation.get("size"),
        model=creation.get("model"),
        duration_seconds=creation.get("duration_seconds"),
        parent_creation_id=creation.get("parent_creation_id"),
    )
    request_payload = await _preflight_free_creation(
        project_name,
        project,
        project_path,
        retry_request,
        media_type=media_type,
        parent_media_path=parent_media_path,
        user_id=user.id,
    )
    task_type = {"image": "free_image", "video": "free_video", "edit": "free_edit"}[output_type]
    spec = TaskSpec.from_request(
        task_type=task_type,
        media_type=media_type,
        resource_id=creation_id,
        prompt=prompt,
        source="webui",
        extra_payload={
            "output_type": output_type,
            "media_type": media_type,
            "references": ([parent_media_path] if parent_media_path else []) + request_references,
            **request_payload,
        },
    )
    queue_result = await get_generation_queue().enqueue_task(
        project_name=project_name,
        task_type=spec.task_type,
        media_type=spec.media_type,
        resource_id=spec.resource_id,
        payload=spec.payload,
        source=spec.source,
        user_id=user.id,
    )
    task_id = str(queue_result["task_id"])
    await asyncio.to_thread(_record_enqueued_metadata, project_path, creation_id, task_id, {})
    return {"success": True, "creation_id": creation_id, "task_id": task_id}


__all__ = ["entry_router", "router", "self_auth_router"]
