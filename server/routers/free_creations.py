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
from lib.config.resolver import VideoBucketCapabilityError
from lib.generation_queue import free_video_capability, get_generation_queue
from lib.generation_queue_client import TaskSpec
from lib.image_backends.base import ImageCapabilityError
from lib.path_safety import PathTraversalError, safe_join
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
self_auth_router = APIRouter()
logger = logging.getLogger(__name__)

FreeOutputType = Literal["image", "video", "edit"]
PromptMode = Literal["original"]
CreationId = Annotated[str, PathParam(pattern=r"^c_[a-f0-9]{20}$")]
_IMAGE_REFERENCE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_AUDIO_REFERENCE_SUFFIXES = frozenset({".wav", ".mp3"})


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
        if self.output_type != "video" and self.duration_seconds is not None:
            raise ValueError("duration_seconds is only supported for video")
        if self.output_type == "video" and self.size is not None:
            raise ValueError("size is only supported for image or edit")
        if self.output_type == "edit" and self.quantity != 1:
            raise ValueError("quantity is only supported for image or video")
        return self


def _load_free_project(project_name: str) -> tuple[dict, Path]:
    pm = get_project_manager()
    if not pm.project_exists(project_name):
        raise NotFoundError("project_not_found", name=project_name)
    project = pm.load_project(project_name)
    if project.get("content_mode") != "free":
        raise ConflictError("free_creation_project_required")
    return project, pm.get_project_path(project_name)


def _validate_references(project_path: Path, references: list[str], output_type: FreeOutputType) -> None:
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
            _IMAGE_REFERENCE_SUFFIXES | _AUDIO_REFERENCE_SUFFIXES
            if output_type == "video"
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


def _free_request_payload(req: FreeCreationRequest) -> dict[str, Any]:
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
        payload["video_provider" if req.output_type == "video" else "image_provider"] = provider
        payload["video_model" if req.output_type == "video" else "image_model"] = model
        payload["model"] = req.model
    return payload


async def _preflight_free_creation(
    project_name: str,
    project: dict,
    project_path: Path,
    req: FreeCreationRequest,
    *,
    user_id: str,
) -> dict[str, Any]:
    """Resolve the selected lane and reject known capability failures before enqueue."""

    payload = _free_request_payload(req)
    try:
        if req.output_type == "video":
            ctx = await resolve_generation_context(
                project_name,
                payload,
                project=project,
                project_path=project_path,
                user_id=user_id,
                video=VideoLaneRequest(capability=free_video_capability(payload)),
            )
            duration = req.duration_seconds or 4
            supported = ctx.video.supported_durations
            if supported and duration not in supported:
                raise VideoCapabilityError(
                    "video_duration_not_supported",
                    duration=duration,
                    supported=", ".join(str(item) for item in supported),
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
            payload["model"] = f"{ctx.image.provider_model.provider_id}/{ctx.image.backend_model}"
    except (ImageCapabilityError, VideoCapabilityError, VideoBucketCapabilityError) as exc:
        raise BadRequestError(exc.code, **exc.params) from exc
    except ValueError as exc:
        raise BadRequestError("request_invalid") from exc
    return payload


@router.post("/projects/{project_name}/creations")
async def create_free_creation(project_name: str, req: FreeCreationRequest, user: CurrentUser):
    project, project_path = await asyncio.to_thread(_load_free_project, project_name)
    await asyncio.to_thread(_validate_references, project_path, req.references, req.output_type)

    if req.parent_creation_id:
        parent = await asyncio.to_thread(load_creation_metadata, project_path, req.parent_creation_id)
        if not parent or parent.get("output_type") not in {"image", "edit"}:
            raise NotFoundError("free_creation_parent_not_found", id=req.parent_creation_id)
        parent_media = parent.get("media_path")
        try:
            parent_path = safe_join(project_path, parent_media) if isinstance(parent_media, str) else None
        except PathTraversalError as exc:
            raise NotFoundError("free_creation_parent_not_found", id=req.parent_creation_id) from exc
        if parent_path is None or not parent_path.is_file():
            raise NotFoundError("free_creation_parent_not_found", id=req.parent_creation_id)

    request_payload = await _preflight_free_creation(
        project_name,
        project,
        project_path,
        req,
        user_id=user.id,
    )
    task_type = {"image": "free_image", "video": "free_video", "edit": "free_edit"}[req.output_type]
    enqueued: list[dict[str, Any]] = []
    try:
        for _ in range(req.quantity):
            creation_id = new_creation_id()
            spec = TaskSpec.from_request(
                task_type=task_type,
                media_type="video" if req.output_type == "video" else "image",
                resource_id=creation_id,
                prompt=req.prompt.strip(),
                source="webui",
                extra_payload={
                    "output_type": req.output_type,
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
            metadata = {
                "creation_id": creation_id,
                "output_type": req.output_type,
                "prompt": req.prompt.strip(),
                "prompt_mode": req.prompt_mode,
                "references": req.references,
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
    media_type = "video/mp4" if creation.get("output_type") == "video" else "image/png"
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
    await asyncio.to_thread(_validate_references, project_path, references, output_type)
    if output_type == "edit":
        parent_id = creation.get("parent_creation_id")
        if not isinstance(parent_id, str):
            raise BadRequestError("request_invalid")
        parent = await asyncio.to_thread(load_creation_metadata, project_path, parent_id)
        if not parent or parent.get("output_type") not in {"image", "edit"}:
            raise NotFoundError("free_creation_parent_not_found", id=parent_id)
        parent_media = parent.get("media_path")
        try:
            parent_path = safe_join(project_path, parent_media) if isinstance(parent_media, str) else None
        except PathTraversalError as exc:
            raise NotFoundError("free_creation_parent_not_found", id=parent_id) from exc
        if parent_path is None or not parent_path.is_file():
            raise NotFoundError("free_creation_parent_not_found", id=parent_id)
    retry_request = FreeCreationRequest(
        output_type=output_type,
        prompt=prompt,
        references=references,
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
        user_id=user.id,
    )
    task_type = {"image": "free_image", "video": "free_video", "edit": "free_edit"}[output_type]
    spec = TaskSpec.from_request(
        task_type=task_type,
        media_type="video" if output_type == "video" else "image",
        resource_id=creation_id,
        prompt=prompt,
        source="webui",
        extra_payload={
            "output_type": output_type,
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


__all__ = ["router", "self_auth_router"]
