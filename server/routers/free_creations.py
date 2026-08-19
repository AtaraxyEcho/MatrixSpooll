"""Project-scoped API for direct free creation requests."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Query, UploadFile
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.background import BackgroundTask

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
from server.services.free_creation_workspace import (
    MAX_REFERENCE_BYTES,
    MAX_STORYBOARD_SHOTS,
    build_creation_export,
    create_storyboard_plan,
    create_subtitle_track,
    delete_reference_upload,
    delete_storyboard_plan,
    delete_subtitle_track,
    detach_reference_upload,
    list_creation_requests,
    list_reference_uploads,
    list_storyboard_plans,
    list_subtitle_tracks,
    load_canvas_state,
    load_storyboard_plan,
    load_subtitle_track,
    new_request_id,
    read_reference_preview,
    resolve_reference_claims,
    save_canvas_state,
    save_reference_upload,
    save_storyboard_plan,
    save_subtitle_track,
    write_creation_request,
)
from server.services.generation_context import (
    AudioLaneRequest,
    ImageLaneRequest,
    VideoLaneRequest,
    resolve_generation_context,
)

router = APIRouter()
entry_router = APIRouter()
self_auth_router = APIRouter()
logger = logging.getLogger(__name__)

FreeOutputType = Literal["image", "video", "edit"]
PromptMode = Literal["original"]
FreeReferenceRole = Literal[
    "first_frame",
    "last_frame",
    "reference_image",
    "reference_video",
    "reference_audio",
    "prompt_context",
]
CreationId = Annotated[str, PathParam(pattern=r"^c_[a-f0-9]{20}$")]
_IMAGE_REFERENCE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_AUDIO_REFERENCE_SUFFIXES = frozenset({".wav", ".mp3"})
_VIDEO_REFERENCE_SUFFIXES = frozenset({".mp4", ".mov"})
_TEXT_REFERENCE_SUFFIXES = frozenset({".txt", ".text", ".md", ".markdown", ".rtf", ".doc", ".docx", ".pdf", ".epub"})


class FreeCreationReference(BaseModel):
    type: Literal["upload", "creation"]
    role: FreeReferenceRole | None = None
    reference_id: str | None = Field(default=None, pattern=r"^r_[a-f0-9]{20}$")
    creation_id: str | None = Field(default=None, pattern=r"^c_[a-f0-9]{20}$")
    version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_identity(self) -> FreeCreationReference:
        if self.type == "upload" and self.reference_id and self.creation_id is None and self.version is None:
            return self
        if self.type == "creation" and self.creation_id and self.reference_id is None:
            return self
        raise ValueError("reference identity does not match its type")


class FreeCreationRequest(BaseModel):
    output_type: FreeOutputType
    prompt: str = Field(min_length=1, max_length=10000)
    references: list[str | FreeCreationReference] = Field(default_factory=list, max_length=32)
    aspect_ratio: str | None = Field(default=None, min_length=3, max_length=32)
    resolution: str | None = Field(default=None, max_length=32)
    size: str | None = Field(default=None, max_length=32)
    model: str | None = Field(default=None, max_length=200)
    quantity: int = Field(default=1, ge=1, le=4)
    duration_seconds: int | None = Field(default=None, gt=0)
    parent_creation_id: str | None = Field(default=None, pattern=r"^c_[a-f0-9]{20}$")
    prompt_mode: PromptMode = "original"
    storyboard_plan_id: str | None = Field(default=None, pattern=r"^sp_[a-f0-9]{20}$")
    storyboard_shot_id: str | None = Field(default=None, min_length=1, max_length=80)
    sequence_index: int | None = Field(default=None, ge=0, le=100)

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
        storyboard_fields = (self.storyboard_plan_id, self.storyboard_shot_id, self.sequence_index)
        if any(value is not None for value in storyboard_fields) and not all(
            value is not None for value in storyboard_fields
        ):
            raise ValueError("storyboard metadata must be complete")
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


class CanvasPoint(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    x: float
    y: float


class CanvasViewport(CanvasPoint):
    scale: float = Field(ge=0.35, le=2.5)


class CanvasStateUpdate(BaseModel):
    viewport: CanvasViewport
    positions: dict[str, CanvasPoint] = Field(default_factory=dict, max_length=500)
    hidden_creation_ids: list[str] = Field(default_factory=list, max_length=500)
    hidden_reference_ids: list[str] = Field(default_factory=list, max_length=500)
    expected_revision: int | None = Field(default=None, ge=0)

    @field_validator("positions")
    @classmethod
    def validate_position_ids(cls, value: dict[str, CanvasPoint]) -> dict[str, CanvasPoint]:
        if any(not key.startswith(("c_", "r_")) for key in value):
            raise ValueError("canvas position ids must identify creations or references")
        return value

    @field_validator("hidden_creation_ids")
    @classmethod
    def validate_hidden_ids(cls, value: list[str]) -> list[str]:
        if any(not item.startswith("c_") for item in value):
            raise ValueError("hidden ids must identify creations")
        return value

    @field_validator("hidden_reference_ids")
    @classmethod
    def validate_hidden_reference_ids(cls, value: list[str]) -> list[str]:
        if any(not item.startswith("r_") for item in value):
            raise ValueError("hidden reference ids must identify uploads")
        return value


class FreeCreationExportRequest(BaseModel):
    scope: Literal["selected", "request", "all"]
    creation_ids: list[str] = Field(default_factory=list, max_length=500)
    request_id: str | None = Field(default=None, pattern=r"^q_[a-f0-9]{20}$")

    @model_validator(mode="after")
    def validate_scope(self) -> FreeCreationExportRequest:
        if self.scope == "selected" and not self.creation_ids:
            raise ValueError("creation_ids are required for selected export")
        if self.scope == "request" and not self.request_id:
            raise ValueError("request_id is required for request export")
        return self


class StoryboardPlanRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=10000)
    reference_id: str | None = Field(default=None, pattern=r"^r_[a-f0-9]{20}$")
    title: str = Field(default="", max_length=200)
    max_shots: int = Field(default=MAX_STORYBOARD_SHOTS, ge=1, le=MAX_STORYBOARD_SHOTS)

    @model_validator(mode="after")
    def validate_source(self) -> StoryboardPlanRequest:
        if not (self.prompt and self.prompt.strip()) and not self.reference_id:
            raise ValueError("storyboard prompt or reference is required")
        return self


class StoryboardShotUpdate(BaseModel):
    shot_id: str = Field(min_length=1, max_length=80)
    sequence_index: int = Field(ge=0, le=100)
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=10000)
    duration_seconds: int = Field(default=5, ge=1, le=120)


class StoryboardPlanUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    shots: list[StoryboardShotUpdate] = Field(min_length=1, max_length=MAX_STORYBOARD_SHOTS)
    expected_revision: int | None = Field(default=None, ge=1)


class StoryboardBatchRequest(BaseModel):
    shot_ids: list[str] = Field(min_length=1, max_length=MAX_STORYBOARD_SHOTS)
    output_type: Literal["image", "video"] = "image"
    model: str | None = Field(default=None, max_length=200)
    aspect_ratio: str | None = Field(default=None, min_length=3, max_length=32)
    resolution: str | None = Field(default=None, max_length=32)
    duration_seconds: int | None = Field(default=None, gt=0)
    expected_revision: int | None = Field(default=None, ge=1)

    @field_validator("aspect_ratio")
    @classmethod
    def validate_batch_aspect_ratio(cls, value: str | None) -> str | None:
        if value is not None and not is_valid_aspect_ratio(value):
            raise ValueError("aspect_ratio must be a positive width:height ratio")
        return value.strip() if value else value

    @model_validator(mode="after")
    def validate_batch_duration(self) -> StoryboardBatchRequest:
        if self.output_type == "image" and self.duration_seconds is not None:
            raise ValueError("duration_seconds is only supported for video")
        return self


class FreeVoiceRequest(BaseModel):
    text: str = Field(min_length=1, max_length=12000)
    voice: str | None = Field(default=None, max_length=120)

    @field_validator("text")
    @classmethod
    def normalize_voice_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        return value


class FreeSubtitleCue(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def validate_range(self) -> FreeSubtitleCue:
        if self.end_seconds <= self.start_seconds:
            raise ValueError("subtitle cue end must be after start")
        return self


class FreeSubtitleCreateRequest(BaseModel):
    creation_id: str = Field(pattern=r"^c_[a-f0-9]{20}$")
    text: str = Field(min_length=1, max_length=12000)
    duration_seconds: float = Field(gt=0, le=3600)

    @field_validator("text")
    @classmethod
    def normalize_subtitle_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        return value


class FreeSubtitleUpdateRequest(BaseModel):
    cues: list[FreeSubtitleCue] = Field(min_length=1, max_length=500)
    expected_revision: int | None = Field(default=None, ge=1)


def _free_creation_request_status(creations: Sequence[dict[str, Any]]) -> str:
    statuses = [str(item.get("status") or "queued") for item in creations]
    if not statuses:
        return "queued"
    if "running" in statuses:
        return "running"
    if "cancelling" in statuses:
        return "cancelling"
    if "queued" in statuses:
        return "queued"
    if all(status == "succeeded" for status in statuses):
        return "succeeded"
    if all(status == "failed" for status in statuses):
        return "failed"
    if all(status == "cancelled" for status in statuses):
        return "cancelled"
    return "partial"


def _free_creation_request_summary(
    request: dict[str, Any],
    creations_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    creation_ids = [item for item in request.get("creation_ids", []) if isinstance(item, str)]
    creations = [creations_by_id[item] for item in creation_ids if item in creations_by_id]
    representative = creations[0] if creations else {}
    reference_claims = request.get("reference_claims")
    if not isinstance(reference_claims, list):
        reference_claims = representative.get("reference_claims")
    if not isinstance(reference_claims, list):
        reference_claims = []
    status_counts: dict[str, int] = {}
    for creation in creations:
        status = str(creation.get("status") or "queued")
        status_counts[status] = status_counts.get(status, 0) + 1
    timestamps = [
        value
        for value in [request.get("created_at"), *(item.get("updated_at") for item in creations)]
        if isinstance(value, str)
    ]

    def value(name: str, default: Any = None) -> Any:
        request_value = request.get(name)
        return request_value if request_value is not None else representative.get(name, default)

    return {
        "request_id": request.get("request_id"),
        "prompt": value("prompt", ""),
        "output_type": value("output_type", "video"),
        "media_type": value("media_type", "video"),
        "effective_mode": value("effective_mode"),
        "model": value("model"),
        "reference_claims": reference_claims,
        "reference_count": len(reference_claims),
        "aspect_ratio": value("aspect_ratio"),
        "resolution": value("resolution"),
        "size": value("size"),
        "duration_seconds": value("duration_seconds"),
        "quantity": value("quantity", len(creation_ids)),
        "creation_ids": creation_ids,
        "result_count": status_counts.get("succeeded", 0),
        "status": _free_creation_request_status(creations),
        "status_counts": status_counts,
        "created_at": request.get("created_at"),
        "updated_at": max(timestamps) if timestamps else None,
    }


def _load_free_project(project_name: str) -> tuple[dict, Path]:
    pm = get_project_manager()
    if not pm.project_exists(project_name):
        raise NotFoundError("project_not_found", name=project_name)
    project = pm.load_project(project_name)
    if project.get("content_mode") != "free":
        raise ConflictError("free_creation_project_required")
    return project, pm.get_project_path(project_name)


def _validate_references(
    project_path: Path,
    references: list[str],
    media_type: Literal["image", "video"],
    claims: Sequence[str | FreeCreationReference | dict[str, Any]] | None = None,
) -> None:
    for index, reference in enumerate(references):
        if not reference.strip():
            raise BadRequestError("free_creation_reference_invalid")
        try:
            path = safe_join(project_path, reference)
        except PathTraversalError as exc:
            raise BadRequestError("free_creation_reference_invalid") from exc
        if not path.is_file():
            raise NotFoundError("file_not_found", path=reference)
        allowed_suffixes = _IMAGE_REFERENCE_SUFFIXES
        claim = claims[index] if claims and index < len(claims) else None
        claim_role = (
            claim.role
            if isinstance(claim, FreeCreationReference)
            else claim.get("role")
            if isinstance(claim, dict)
            else None
        )
        if claim_role == "prompt_context":
            allowed_suffixes |= _TEXT_REFERENCE_SUFFIXES
        if media_type == "video":
            allowed_suffixes |= _AUDIO_REFERENCE_SUFFIXES | _VIDEO_REFERENCE_SUFFIXES
        if path.suffix.lower() not in allowed_suffixes:
            raise BadRequestError("free_creation_reference_type_unsupported", type=path.suffix.lower() or "unknown")


def _validate_reference_roles(
    claims: Sequence[str | FreeCreationReference | dict[str, Any]],
    resolved_paths: list[str],
    media_type: Literal["image", "video"],
) -> None:
    role_counts: dict[str, int] = {}
    for claim, path in zip(claims, resolved_paths, strict=False):
        if isinstance(claim, str):
            continue
        role = claim.role if isinstance(claim, FreeCreationReference) else claim.get("role")
        if role is None:
            raise BadRequestError("free_creation_reference_role_required")
        role_counts[role] = role_counts.get(role, 0) + 1
        suffix = Path(path).suffix.lower()
        accepted = {
            "first_frame": _IMAGE_REFERENCE_SUFFIXES,
            "last_frame": _IMAGE_REFERENCE_SUFFIXES,
            "reference_image": _IMAGE_REFERENCE_SUFFIXES,
            "reference_video": _VIDEO_REFERENCE_SUFFIXES,
            "reference_audio": _AUDIO_REFERENCE_SUFFIXES,
            "prompt_context": _TEXT_REFERENCE_SUFFIXES,
        }.get(role)
        if accepted is not None and suffix not in accepted:
            raise BadRequestError("free_creation_reference_type_unsupported", type=suffix or "unknown")
        allowed_roles = (
            {"first_frame", "last_frame", "reference_image", "reference_video", "reference_audio", "prompt_context"}
            if media_type == "video"
            else {"reference_image", "prompt_context"}
        )
        if role not in allowed_roles:
            raise BadRequestError("free_creation_reference_role_unsupported", role=role)
    for role in ("first_frame", "last_frame"):
        if role_counts.get(role, 0) > 1:
            raise BadRequestError("request_invalid")


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
        "quantity": req.quantity,
        "parent_creation_id": req.parent_creation_id,
        "prompt_mode": req.prompt_mode,
        "storyboard_plan_id": req.storyboard_plan_id,
        "storyboard_shot_id": req.storyboard_shot_id,
        "sequence_index": req.sequence_index,
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
    reference_claims: list[dict[str, Any]] | None = None,
    user_id: str,
) -> dict[str, Any]:
    """Resolve the selected lane and reject known capability failures before enqueue."""

    payload = _free_request_payload(req, media_type)
    capability_payload = {
        **payload,
        "references": ([parent_media_path] if parent_media_path else []) + list(req.references),
        "reference_claims": reference_claims or [],
    }
    role_counts: dict[str, int] = {}
    for claim in reference_claims or []:
        role = claim.get("role")
        if isinstance(role, str):
            role_counts[role] = role_counts.get(role, 0) + 1
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
            if reference_claims:
                first_frame_count = role_counts.get("first_frame", 0)
                last_frame_count = role_counts.get("last_frame", 0)
                image_count = role_counts.get("reference_image", 0)
                video_count = role_counts.get("reference_video", 0)
                audio_count = role_counts.get("reference_audio", 0)
            else:
                first_frame_count = 0
                last_frame_count = 0
                image_count = sum(Path(item).suffix.lower() in _IMAGE_REFERENCE_SUFFIXES for item in reference_names)
                video_count = sum(Path(item).suffix.lower() in _VIDEO_REFERENCE_SUFFIXES for item in reference_names)
                audio_count = sum(Path(item).suffix.lower() in _AUDIO_REFERENCE_SUFFIXES for item in reference_names)
            has_visual_input = bool(
                parent_media_path or first_frame_count or last_frame_count or image_count or video_count
            )
            model_name = f"{ctx.video.provider_model.provider_id}/{ctx.video.backend_model}"
            if not has_visual_input and not getattr(ctx.video, "text_to_video", True):
                raise VideoCapabilityError(
                    "free_creation_t2v_unsupported",
                    provider=ctx.video.provider_model.provider_id,
                    model=ctx.video.backend_model,
                )
            if first_frame_count and not getattr(ctx.video, "first_frame", True):
                raise VideoCapabilityError("free_creation_first_frame_unsupported", model=model_name)
            if last_frame_count and not first_frame_count:
                raise VideoCapabilityError("free_creation_input_combination_unsupported", model=model_name)
            if last_frame_count and not getattr(ctx.video, "last_frame", False):
                raise VideoCapabilityError("free_creation_last_frame_unsupported", model=model_name)
            supported = (
                ctx.video.supported_durations_with_reference_video
                if video_count and ctx.video.supported_durations_with_reference_video
                else ctx.video.supported_durations
            )
            if not supported:
                raise VideoCapabilityError("video_supported_durations_missing")
            duration = req.duration_seconds if req.duration_seconds is not None else supported[0]
            if duration not in supported:
                raise VideoCapabilityError(
                    "video_duration_not_supported",
                    duration=duration,
                    supported=", ".join(str(item) for item in supported),
                )
            payload["duration_seconds"] = duration
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
                        "free_creation_reference_images_unsupported",
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
                        "free_creation_reference_videos_unsupported",
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
            if audio_count:
                if ctx.video.max_reference_audio_count <= 0:
                    raise VideoCapabilityError(
                        "free_creation_reference_audio_unsupported",
                        provider=ctx.video.provider_model.provider_id,
                        model=ctx.video.backend_model,
                    )
                if audio_count > ctx.video.max_reference_audio_count:
                    raise VideoCapabilityError(
                        "video_reference_audio_exceeded",
                        model=ctx.video.backend_model,
                        limit=ctx.video.max_reference_audio_count,
                        count=audio_count,
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
            image_reference_count = role_counts.get("reference_image", 0)
            ctx = await resolve_generation_context(
                project_name,
                payload,
                project=project,
                project_path=project_path,
                user_id=user_id,
                image=ImageLaneRequest(
                    capability="i2i" if req.output_type == "edit" or image_reference_count else "t2i"
                ),
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
    reference_kind: Literal["none", "frame", "image", "video"] = Query(default="none"),
    project_name: str | None = None,
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
    project = (
        (await asyncio.to_thread(_load_free_project, project_name))[0]
        if project_name
        else {"content_mode": "free", "generation_mode": None}
    )
    try:
        if output_type == "video":
            capability = "i2v" if reference_kind == "frame" else "r2v" if reference_kind in {"image", "video"} else None
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
            modes = ["t2v"] if caps.get("text_to_video", True) else []
            if reference_kind == "none" and "t2v" not in modes:
                raise VideoCapabilityError(
                    "video_capability_missing_t2v",
                    provider=resolved.provider_id,
                    model=resolved.model_id,
                )
            input_slots: list[dict[str, Any]] = []
            if caps.get("first_frame"):
                modes.append("first_frame")
                input_slots.append({"role": "first_frame", "accepted_types": ["image"], "max_count": 1})
            if caps.get("first_frame") and caps.get("last_frame"):
                modes.append("first_last_frame")
                input_slots.append({"role": "last_frame", "accepted_types": ["image"], "max_count": 1})
            if (caps.get("max_reference_images") or 0) > 0:
                modes.append("reference_image")
                input_slots.append(
                    {
                        "role": "reference_image",
                        "accepted_types": ["image"],
                        "max_count": int(caps["max_reference_images"]),
                    }
                )
            if (caps.get("max_reference_videos") or 0) > 0:
                modes.append("reference_video")
                input_slots.append(
                    {
                        "role": "reference_video",
                        "accepted_types": ["video"],
                        "max_count": int(caps["max_reference_videos"]),
                    }
                )
            max_reference_audio_count = int(caps.get("max_reference_audio_count") or 0)
            if max_reference_audio_count > 0:
                modes.append("reference_audio")
                input_slots.append(
                    {
                        "role": "reference_audio",
                        "accepted_types": ["audio"],
                        "max_count": max_reference_audio_count,
                    }
                )
            input_slots.append({"role": "prompt_context", "accepted_types": ["text"], "max_count": 1})
            combinations: list[list[str]] = []
            if caps.get("first_frame"):
                combinations.append(["first_frame"])
            if caps.get("first_frame") and caps.get("last_frame"):
                combinations.append(["first_frame", "last_frame"])
            if (caps.get("max_reference_images") or 0) > 0:
                combinations.append(["reference_image"])
            if (caps.get("max_reference_videos") or 0) > 0:
                combinations.append(["reference_video"])
            if max_reference_audio_count > 0:
                combinations.append(["reference_audio"])
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
                "max_reference_audio_count": max_reference_audio_count,
                "max_reference_media_count": caps.get("max_reference_media_count"),
                "text_to_video": caps.get("text_to_video", True),
                "modes": modes,
                "input_slots": input_slots,
                "combinations": combinations,
                "quantity": {"min": 1, "max": 4},
            }
        image_capability = "i2i" if reference_kind == "image" else "t2i"
        resolved = await resolver.resolve_image_backend(project, payload, capability=image_capability)
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
            "modes": [image_capability],
            "input_slots": (
                [
                    {"role": "reference_image", "accepted_types": ["image"], "max_count": 32},
                    {"role": "prompt_context", "accepted_types": ["text"], "max_count": 1},
                ]
                if image_capability == "i2i"
                else [{"role": "prompt_context", "accepted_types": ["text"], "max_count": 1}]
            ),
            "combinations": [["reference_image"]] if image_capability == "i2i" else [],
            "quantity": {"min": 1, "max": 4},
        }
    except (ValueError, ImageCapabilityError, VideoCapabilityError, VideoBucketCapabilityError) as exc:
        code = getattr(exc, "code", "free_creation_capabilities_unavailable")
        params = getattr(exc, "params", {})
        raise BadRequestError(code, **params) from exc


@router.post("/projects/{project_name}/creations")
async def create_free_creation(project_name: str, req: FreeCreationRequest, user: CurrentUser):
    project, project_path = await asyncio.to_thread(_load_free_project, project_name)
    storyboard_plan: dict[str, Any] | None = None
    if req.storyboard_plan_id:
        storyboard_plan = await asyncio.to_thread(load_storyboard_plan, project_path, req.storyboard_plan_id)
        if storyboard_plan is None:
            raise NotFoundError("free_creation_storyboard_not_found", id=req.storyboard_plan_id)
        shot_ids = {item.get("shot_id") for item in storyboard_plan.get("shots", []) if isinstance(item, dict)}
        if req.storyboard_shot_id not in shot_ids:
            raise BadRequestError("free_creation_storyboard_shot_not_found")
    if any(isinstance(item, str) or item.role is None for item in req.references):
        raise BadRequestError("free_creation_reference_role_required")
    public_references = [
        item if isinstance(item, str) else item.model_dump(exclude_none=True) for item in req.references
    ]
    try:
        resolved_references, reference_claims = await asyncio.to_thread(
            resolve_reference_claims,
            project_path,
            public_references,
            load_creation=load_creation_metadata,
        )
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_reference_not_found", id=str(exc)) from exc
    except ValueError as exc:
        raise BadRequestError("free_creation_reference_invalid") from exc
    roles = [claim.get("role") for claim in reference_claims if claim.get("role")]
    if "first_frame" in roles and "last_frame" in roles:
        effective_mode = "first_last_frame"
    elif "first_frame" in roles:
        effective_mode = "first_frame"
    elif "reference_video" in roles:
        effective_mode = "reference_video"
    elif "reference_image" in roles:
        effective_mode = "reference_image"
    else:
        effective_mode = "t2v" if req.output_type == "video" else req.output_type
    execution_req = req.model_copy(update={"references": resolved_references})
    parent: dict[str, Any] | None = None
    parent_media_path: str | None = None
    media_type: Literal["image", "video"] = "video" if execution_req.output_type == "video" else "image"
    if execution_req.parent_creation_id:
        parent = await asyncio.to_thread(load_creation_metadata, project_path, execution_req.parent_creation_id)
        if not parent or parent.get("output_type") not in {"image", "video", "edit"}:
            raise NotFoundError("free_creation_parent_not_found", id=execution_req.parent_creation_id)
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
            raise NotFoundError("free_creation_parent_not_found", id=execution_req.parent_creation_id) from exc
        if parent_path is None or not parent_path.is_file():
            raise NotFoundError("free_creation_parent_not_found", id=execution_req.parent_creation_id)

    await asyncio.to_thread(_validate_references, project_path, resolved_references, media_type, reference_claims)
    _validate_reference_roles(req.references, resolved_references, media_type)
    if media_type == "image" and execution_req.duration_seconds is not None:
        raise BadRequestError("request_invalid")
    if media_type == "video" and execution_req.size is not None:
        raise BadRequestError("request_invalid")

    request_payload = await _preflight_free_creation(
        project_name,
        project,
        project_path,
        execution_req,
        media_type=media_type,
        parent_media_path=parent_media_path,
        reference_claims=reference_claims,
        user_id=user.id,
    )
    request_id = new_request_id()
    task_type = {"image": "free_image", "video": "free_video", "edit": "free_edit"}[execution_req.output_type]
    enqueued: list[dict[str, Any]] = []
    task_payload = {
        **request_payload,
        "request_id": request_id,
        "media_type": media_type,
        "references": ([parent_media_path] if parent_media_path else []) + resolved_references,
        "reference_claims": reference_claims,
        "effective_mode": effective_mode,
    }
    try:
        for _ in range(execution_req.quantity):
            creation_id = new_creation_id()
            spec = TaskSpec.from_request(
                task_type=task_type,
                media_type=media_type,
                resource_id=creation_id,
                prompt=execution_req.prompt.strip(),
                source="webui",
                extra_payload={
                    "output_type": execution_req.output_type,
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
                "request_id": request_id,
                "output_type": execution_req.output_type,
                "media_type": media_type,
                "prompt": execution_req.prompt.strip(),
                "prompt_mode": execution_req.prompt_mode,
                "references": task_payload["references"],
                "reference_claims": reference_claims,
                "effective_mode": effective_mode,
                "aspect_ratio": execution_req.aspect_ratio or project.get("aspect_ratio") or "9:16",
                "resolution": execution_req.resolution,
                "size": execution_req.size,
                "model": request_payload.get("model"),
                "duration_seconds": request_payload.get("duration_seconds"),
                "quantity": execution_req.quantity,
                "parent_creation_id": execution_req.parent_creation_id,
                "storyboard_plan_id": execution_req.storyboard_plan_id,
                "storyboard_shot_id": execution_req.storyboard_shot_id,
                "sequence_index": execution_req.sequence_index,
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
    try:
        await asyncio.to_thread(
            write_creation_request,
            project_path,
            request_id,
            {
                "output_type": execution_req.output_type,
                "media_type": media_type,
                "prompt": execution_req.prompt,
                "reference_claims": reference_claims,
                "effective_mode": effective_mode,
                "model": request_payload.get("model"),
                "aspect_ratio": execution_req.aspect_ratio or project.get("aspect_ratio") or "9:16",
                "resolution": execution_req.resolution,
                "size": execution_req.size,
                "quantity": execution_req.quantity,
                "duration_seconds": request_payload.get("duration_seconds"),
                "parent_creation_id": execution_req.parent_creation_id,
                "storyboard_plan_id": execution_req.storyboard_plan_id,
                "storyboard_shot_id": execution_req.storyboard_shot_id,
                "sequence_index": execution_req.sequence_index,
                "creation_ids": [item["creation_id"] for item in enqueued],
            },
        )
    except BaseException:
        await _compensate_partial_batch(project_path, enqueued)
        raise
    created = [{"creation_id": item["creation_id"], "task_id": item["task_id"]} for item in enqueued]
    return {
        "success": True,
        "request_id": request_id,
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
async def list_free_creations(
    project_name: str,
    limit: int = Query(default=60, ge=1, le=100),
    cursor: str | None = Query(default=None, pattern=r"^c_[a-f0-9]{20}$"),
):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    creations = await asyncio.to_thread(list_creation_metadata, project_path, None)
    start = 0
    if cursor:
        start = next((index + 1 for index, item in enumerate(creations) if item.get("creation_id") == cursor), 0)
    page = creations[start : start + limit]
    next_cursor = page[-1].get("creation_id") if start + limit < len(creations) and page else None
    return {"creations": page, "next_cursor": next_cursor, "total": len(creations)}


@router.get("/projects/{project_name}/free-creation-requests")
async def list_free_creation_requests(
    project_name: str,
    limit: int = Query(default=40, ge=1, le=100),
    cursor: str | None = Query(default=None, pattern=r"^q_[a-f0-9]{20}$"),
):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    requests = await asyncio.to_thread(list_creation_requests, project_path, None)
    creations = await asyncio.to_thread(list_creation_metadata, project_path, None)
    creations_by_id = {str(item["creation_id"]): item for item in creations if isinstance(item.get("creation_id"), str)}
    summaries = [_free_creation_request_summary(item, creations_by_id) for item in requests]
    start = 0
    if cursor:
        start = next((index + 1 for index, item in enumerate(summaries) if item.get("request_id") == cursor), 0)
    page = summaries[start : start + limit]
    next_cursor = page[-1].get("request_id") if start + limit < len(summaries) and page else None
    return {"requests": page, "next_cursor": next_cursor, "total": len(summaries)}


@router.post("/projects/{project_name}/free-creation-voice")
async def create_free_creation_voice(project_name: str, req: FreeVoiceRequest, user: CurrentUser):
    project, project_path = await asyncio.to_thread(_load_free_project, project_name)
    try:
        ctx = await resolve_generation_context(
            project_name,
            None,
            project=project,
            project_path=project_path,
            user_id=user.id,
            audio=AudioLaneRequest(),
        )
    except (ValueError, RuntimeError) as exc:
        raise BadRequestError("free_creation_audio_unavailable") from exc
    voice = req.voice.strip() if req.voice else ctx.audio.narration_voice
    if voice not in {item.id for item in ctx.audio.voices}:
        raise BadRequestError("free_creation_voice_unsupported", voice=voice)
    resource_id = new_creation_id()
    spec = TaskSpec.from_request(
        task_type="free_audio",
        media_type="audio",
        resource_id=resource_id,
        prompt=req.text,
        extra_payload={"text": req.text, "voice": voice},
        source="webui",
    )
    result = await get_generation_queue().enqueue_task(
        project_name=project_name,
        task_type=spec.task_type,
        media_type=spec.media_type,
        resource_id=spec.resource_id,
        payload=spec.payload,
        source=spec.source,
        user_id=user.id,
    )
    return {"success": True, "task_id": result["task_id"], "voice": voice, "resource_id": resource_id}


@router.post("/projects/{project_name}/free-creation-storyboards/plan")
async def create_free_storyboard_plan(project_name: str, req: StoryboardPlanRequest):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    source: dict[str, Any] | None = None
    text = req.prompt.strip() if req.prompt else ""
    if req.reference_id:
        references = await asyncio.to_thread(list_reference_uploads, project_path)
        record = next((item for item in references if item.get("reference_id") == req.reference_id), None)
        if not record or record.get("media_type") != "text":
            raise BadRequestError("free_creation_storyboard_source_invalid")
        try:
            preview = await asyncio.to_thread(read_reference_preview, project_path, req.reference_id)
        except FileNotFoundError as exc:
            raise NotFoundError("free_creation_reference_not_found") from exc
        text = str(preview.get("text") or "").strip()
        source = {"type": "upload", "reference_id": req.reference_id}
    elif text:
        source = {"type": "prompt", "text": text}
    try:
        plan = await asyncio.to_thread(
            create_storyboard_plan,
            project_path,
            title=req.title or (text.splitlines()[0][:80] if text else "Storyboard"),
            source=source,
            text=text,
            max_shots=req.max_shots,
        )
    except ValueError as exc:
        raise BadRequestError("free_creation_storyboard_source_invalid") from exc
    return {"success": True, "plan": plan}


@router.get("/projects/{project_name}/free-creation-storyboards")
async def list_free_storyboard_plans(project_name: str, limit: int = Query(default=50, ge=1, le=100)):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    return {"plans": await asyncio.to_thread(list_storyboard_plans, project_path, limit)}


@router.get("/projects/{project_name}/free-creation-storyboards/{plan_id}")
async def get_free_storyboard_plan(project_name: str, plan_id: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    plan = await asyncio.to_thread(load_storyboard_plan, project_path, plan_id)
    if plan is None:
        raise NotFoundError("free_creation_storyboard_not_found", id=plan_id)
    return {"plan": plan}


@router.put("/projects/{project_name}/free-creation-storyboards/{plan_id}")
async def update_free_storyboard_plan(project_name: str, plan_id: str, req: StoryboardPlanUpdate):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    plan = await asyncio.to_thread(load_storyboard_plan, project_path, plan_id)
    if plan is None:
        raise NotFoundError("free_creation_storyboard_not_found", id=plan_id)
    shot_ids = [shot.shot_id for shot in req.shots]
    sequence_indexes = [shot.sequence_index for shot in req.shots]
    if len(set(shot_ids)) != len(shot_ids) or len(set(sequence_indexes)) != len(sequence_indexes):
        raise BadRequestError("free_creation_storyboard_order_invalid")
    old_shots = {
        item.get("shot_id"): item
        for item in plan.get("shots", [])
        if isinstance(item, dict) and isinstance(item.get("shot_id"), str)
    }
    shots = []
    for shot in req.shots:
        existing = old_shots.get(shot.shot_id, {})
        shots.append(
            {
                **existing,
                **shot.model_dump(),
            }
        )
    try:
        updated = await asyncio.to_thread(
            save_storyboard_plan,
            project_path,
            {**plan, "title": req.title, "shots": sorted(shots, key=lambda item: item["sequence_index"])},
            expected_revision=req.expected_revision,
        )
    except RuntimeError as exc:
        raise ConflictError("free_creation_storyboard_conflict") from exc
    return {"success": True, "plan": updated}


@router.delete("/projects/{project_name}/free-creation-storyboards/{plan_id}")
async def delete_free_storyboard_plan(project_name: str, plan_id: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    try:
        await asyncio.to_thread(delete_storyboard_plan, project_path, plan_id)
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_storyboard_not_found", id=plan_id) from exc
    return {"success": True}


async def _preflight_storyboard_batch_item(
    project_name: str,
    project: dict[str, Any],
    project_path: Path,
    request: FreeCreationRequest,
    *,
    user_id: str,
) -> None:
    public_references = [
        item if isinstance(item, str) else item.model_dump(exclude_none=True) for item in request.references
    ]
    try:
        resolved_references, reference_claims = await asyncio.to_thread(
            resolve_reference_claims,
            project_path,
            public_references,
            load_creation=load_creation_metadata,
        )
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_reference_not_found", id=str(exc)) from exc
    except ValueError as exc:
        raise BadRequestError("free_creation_reference_invalid") from exc
    media_type: Literal["image", "video"] = "video" if request.output_type == "video" else "image"
    await asyncio.to_thread(_validate_references, project_path, resolved_references, media_type, reference_claims)
    _validate_reference_roles(request.references, resolved_references, media_type)
    await _preflight_free_creation(
        project_name,
        project,
        project_path,
        request.model_copy(update={"references": resolved_references}),
        media_type=media_type,
        reference_claims=reference_claims,
        user_id=user_id,
    )


@router.post("/projects/{project_name}/free-creation-storyboards/{plan_id}/generate")
async def generate_free_storyboard_batch(
    project_name: str,
    plan_id: str,
    req: StoryboardBatchRequest,
    user: CurrentUser,
):
    project, project_path = await asyncio.to_thread(_load_free_project, project_name)
    plan = await asyncio.to_thread(load_storyboard_plan, project_path, plan_id)
    if plan is None:
        raise NotFoundError("free_creation_storyboard_not_found", id=plan_id)
    if req.expected_revision is not None and req.expected_revision != plan["revision"]:
        raise ConflictError("free_creation_storyboard_conflict")
    if len(set(req.shot_ids)) != len(req.shot_ids):
        raise BadRequestError("free_creation_storyboard_order_invalid")
    shots_by_id = {
        item.get("shot_id"): item
        for item in plan.get("shots", [])
        if isinstance(item, dict) and isinstance(item.get("shot_id"), str)
    }
    if any(shot_id not in shots_by_id for shot_id in req.shot_ids):
        raise BadRequestError("free_creation_storyboard_shot_not_found")
    ordered_shots = [shots_by_id[shot_id] for shot_id in req.shot_ids]
    requests: list[FreeCreationRequest] = []
    for shot in ordered_shots:
        references: list[str | FreeCreationReference] = []
        duration = req.duration_seconds or int(shot.get("duration_seconds") or 5)
        if req.output_type == "video":
            image_creation_id = shot.get("image_creation_id")
            if not isinstance(image_creation_id, str):
                raise BadRequestError("free_creation_storyboard_image_required")
            image_creation = await asyncio.to_thread(load_creation_metadata, project_path, image_creation_id)
            version = image_creation.get("version") if isinstance(image_creation, dict) else None
            if (
                not isinstance(image_creation, dict)
                or image_creation.get("status") != "succeeded"
                or not isinstance(version, int)
            ):
                raise BadRequestError("free_creation_storyboard_image_required")
            references.append(
                FreeCreationReference(
                    type="creation",
                    creation_id=image_creation_id,
                    version=version,
                    role="first_frame",
                )
            )
        requests.append(
            FreeCreationRequest(
                output_type=req.output_type,
                prompt=str(shot.get("prompt") or "").strip(),
                references=references,
                model=req.model,
                aspect_ratio=req.aspect_ratio,
                resolution=req.resolution,
                duration_seconds=duration if req.output_type == "video" else None,
                storyboard_plan_id=plan_id,
                storyboard_shot_id=str(shot["shot_id"]),
                sequence_index=int(shot.get("sequence_index") or 0),
            )
        )
    for request in requests:
        await _preflight_storyboard_batch_item(
            project_name,
            project,
            project_path,
            request,
            user_id=user.id,
        )

    results: list[dict[str, Any]] = []
    try:
        for request in requests:
            results.append(await create_free_creation(project_name, request, user))
    except BaseException:
        compensated: list[dict[str, Any]] = []
        for result in results:
            for item in result.get("creations", []):
                creation_id = item.get("creation_id")
                if not isinstance(creation_id, str):
                    continue
                metadata = await asyncio.to_thread(load_creation_metadata, project_path, creation_id)
                if isinstance(metadata, dict) and isinstance(metadata.get("task_id"), str):
                    compensated.append(
                        {
                            "creation_id": creation_id,
                            "task_id": metadata["task_id"],
                            "metadata": metadata,
                        }
                    )
        await _compensate_partial_batch(project_path, compensated)
        raise

    creation_by_shot: dict[str, str] = {}
    request_ids: list[str] = []
    task_ids: list[str] = []
    for request, result in zip(requests, results, strict=True):
        shot_id = str(request.storyboard_shot_id)
        creation_by_shot[shot_id] = result["creation_id"]
        if isinstance(result.get("request_id"), str):
            request_ids.append(result["request_id"])
        if isinstance(result.get("task_id"), str):
            task_ids.append(result["task_id"])
    updated_shots = []
    output_key = "image_creation_id" if req.output_type == "image" else "video_creation_id"
    for shot in plan["shots"]:
        shot_id = shot.get("shot_id")
        updated_shots.append(
            {**shot, **({output_key: creation_by_shot[shot_id]} if shot_id in creation_by_shot else {})}
        )
    updated_plan = await asyncio.to_thread(
        save_storyboard_plan,
        project_path,
        {**plan, "shots": updated_shots, "status": "generating"},
        expected_revision=plan["revision"],
    )
    return {
        "success": True,
        "plan": updated_plan,
        "request_ids": request_ids,
        "task_ids": task_ids,
        "creation_ids": list(creation_by_shot.values()),
    }


@router.post("/projects/{project_name}/free-creation-subtitles")
async def create_free_creation_subtitles(project_name: str, req: FreeSubtitleCreateRequest):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    creation = await asyncio.to_thread(load_creation_metadata, project_path, req.creation_id)
    if not isinstance(creation, dict) or creation.get("status") != "succeeded":
        raise NotFoundError("free_creation_not_found", id=req.creation_id)
    if creation.get("media_type") != "video":
        raise BadRequestError("free_creation_subtitle_video_required")
    track = await asyncio.to_thread(
        create_subtitle_track,
        project_path,
        creation_id=req.creation_id,
        text=req.text,
        duration_seconds=req.duration_seconds,
    )
    return {"success": True, "track": track}


@router.get("/projects/{project_name}/free-creation-subtitles")
async def list_free_creation_subtitles(project_name: str, creation_id: str | None = Query(default=None)):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    return {"tracks": await asyncio.to_thread(list_subtitle_tracks, project_path, creation_id)}


@router.get("/projects/{project_name}/free-creation-subtitles/{subtitle_id}")
async def get_free_creation_subtitle(project_name: str, subtitle_id: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    track = await asyncio.to_thread(load_subtitle_track, project_path, subtitle_id)
    if track is None:
        raise NotFoundError("free_creation_subtitle_not_found", id=subtitle_id)
    return {"track": track}


@router.put("/projects/{project_name}/free-creation-subtitles/{subtitle_id}")
async def update_free_creation_subtitle(project_name: str, subtitle_id: str, req: FreeSubtitleUpdateRequest):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    track = await asyncio.to_thread(load_subtitle_track, project_path, subtitle_id)
    if track is None:
        raise NotFoundError("free_creation_subtitle_not_found", id=subtitle_id)
    try:
        updated = await asyncio.to_thread(
            save_subtitle_track,
            project_path,
            {**track, "cues": [cue.model_dump() for cue in req.cues]},
            expected_revision=req.expected_revision,
        )
    except RuntimeError as exc:
        raise ConflictError("free_creation_subtitle_conflict") from exc
    return {"success": True, "track": updated}


@router.delete("/projects/{project_name}/free-creation-subtitles/{subtitle_id}")
async def delete_free_creation_subtitle(project_name: str, subtitle_id: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    try:
        await asyncio.to_thread(delete_subtitle_track, project_path, subtitle_id)
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_subtitle_not_found", id=subtitle_id) from exc
    return {"success": True}


@router.get("/projects/{project_name}/free-creation-canvas")
async def get_free_creation_canvas(project_name: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    return {"canvas": await asyncio.to_thread(load_canvas_state, project_path)}


@router.put("/projects/{project_name}/free-creation-canvas")
async def update_free_creation_canvas(project_name: str, req: CanvasStateUpdate):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    try:
        canvas = await asyncio.to_thread(
            save_canvas_state,
            project_path,
            viewport=req.viewport.model_dump(),
            positions={key: value.model_dump() for key, value in req.positions.items()},
            hidden_creation_ids=req.hidden_creation_ids,
            hidden_reference_ids=req.hidden_reference_ids,
            expected_revision=req.expected_revision,
        )
    except RuntimeError as exc:
        raise ConflictError("free_creation_canvas_conflict") from exc
    return {"success": True, "canvas": canvas}


@router.get("/projects/{project_name}/free-creation-references")
async def get_free_creation_references(project_name: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    return {"references": await asyncio.to_thread(list_reference_uploads, project_path)}


@router.get("/projects/{project_name}/free-creation-references/{reference_id}/preview")
async def preview_free_creation_reference(project_name: str, reference_id: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    try:
        return await asyncio.to_thread(read_reference_preview, project_path, reference_id)
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_reference_not_found") from exc


@router.post("/projects/{project_name}/free-creation-references")
async def upload_free_creation_reference(project_name: str, file: UploadFile = File(...)):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    if not file.filename:
        raise BadRequestError("free_creation_reference_invalid")
    content = await file.read(MAX_REFERENCE_BYTES + 1)
    try:
        record = await asyncio.to_thread(
            save_reference_upload,
            project_path,
            original_filename=file.filename,
            content=content,
        )
    except (ValueError, OverflowError) as exc:
        raise BadRequestError("free_creation_reference_invalid") from exc
    return {
        "success": True,
        "reference": record,
        "url": f"/api/v1/files/{project_name}/{record['path']}",
    }


@router.delete("/projects/{project_name}/free-creation-references/{reference_id}")
async def remove_free_creation_reference(project_name: str, reference_id: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    try:
        await asyncio.to_thread(delete_reference_upload, project_path, reference_id)
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_reference_not_found") from exc
    except RuntimeError as exc:
        raise ConflictError("request_invalid") from exc
    return {"success": True}


@router.post("/projects/{project_name}/free-creation-references/{reference_id}/detach")
async def detach_free_creation_reference(project_name: str, reference_id: str):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    try:
        await asyncio.to_thread(detach_reference_upload, project_path, reference_id)
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_reference_not_found") from exc
    return {"success": True}


@router.post("/projects/{project_name}/free-creation-export")
async def export_free_creations(project_name: str, req: FreeCreationExportRequest):
    _, project_path = await asyncio.to_thread(_load_free_project, project_name)
    creations = await asyncio.to_thread(list_creation_metadata, project_path, None)
    try:
        archive = await asyncio.to_thread(
            build_creation_export,
            project_path,
            scope=req.scope,
            creation_ids=req.creation_ids,
            request_id=req.request_id,
            creations=creations,
        )
    except FileNotFoundError as exc:
        raise NotFoundError("free_creation_export_empty") from exc
    except ValueError as exc:
        raise BadRequestError("request_invalid") from exc
    return FileResponse(
        archive,
        media_type="application/zip",
        filename=f"{project_name}-creations.zip",
        background=BackgroundTask(archive.unlink, missing_ok=True),
    )


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
    stored_claims = creation.get("reference_claims")
    validation_claims = stored_claims if isinstance(stored_claims, list) else None
    await asyncio.to_thread(_validate_references, project_path, request_references, media_type, validation_claims)
    retry_request = FreeCreationRequest(
        output_type=output_type,
        prompt=prompt,
        references=request_references,
        aspect_ratio=creation.get("aspect_ratio") or project.get("aspect_ratio"),
        resolution=creation.get("resolution"),
        size=creation.get("size"),
        model=creation.get("model"),
        duration_seconds=creation.get("duration_seconds"),
        quantity=creation.get("quantity", 1),
        parent_creation_id=creation.get("parent_creation_id"),
        storyboard_plan_id=creation.get("storyboard_plan_id"),
        storyboard_shot_id=creation.get("storyboard_shot_id"),
        sequence_index=creation.get("sequence_index"),
    )
    request_payload = await _preflight_free_creation(
        project_name,
        project,
        project_path,
        retry_request,
        media_type=media_type,
        parent_media_path=parent_media_path,
        reference_claims=validation_claims,
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
            "request_id": creation.get("request_id"),
            "reference_claims": creation.get("reference_claims") or [],
            "effective_mode": creation.get("effective_mode"),
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
