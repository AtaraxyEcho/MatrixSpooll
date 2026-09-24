"""Lightweight submit identity for free-creation video jobs.

Free video has no storyboard artifact currency / narration / staged media, so it
cannot reuse ``StoryboardSubmissionCheckpoint``. This module freezes just the
facts needed to poll an already-submitted provider job without re-billing.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from lib.reference_video.execution_checkpoint import ReferenceExecutionIdentityError, VideoResumeState

logger = logging.getLogger(__name__)

FREE_VIDEO_CHECKPOINT_KIND = "free_video_submit"
_SCHEMA_VERSION = 1

_Fields = frozenset(
    {
        "kind",
        "schema_version",
        "task_id",
        "project_name",
        "unit_id",
        "capability",
        "provider_id",
        "provider_model_id",
        "backend_model_id",
        "endpoint_guard",
        "prompt",
        "duration_seconds",
        "aspect_ratio",
        "resolution",
        "generate_audio",
        "output_type",
        "parent_creation_id",
        "api_call_id",
    }
)


def build_free_video_checkpoint(
    *,
    task_id: str,
    project_name: str,
    resource_id: str,
    capability: Literal["i2v", "r2v"],
    provider_id: str,
    provider_model_id: str,
    backend_model_id: str,
    endpoint_guard: str | None,
    prompt: str,
    duration_seconds: int,
    aspect_ratio: str,
    resolution: str | None,
    generate_audio: bool,
    output_type: str = "video",
    parent_creation_id: str | None = None,
    api_call_id: int | None = None,
) -> dict[str, Any]:
    return {
        "kind": FREE_VIDEO_CHECKPOINT_KIND,
        "schema_version": _SCHEMA_VERSION,
        "task_id": task_id,
        "project_name": project_name,
        "unit_id": resource_id,
        "capability": capability,
        "provider_id": provider_id,
        "provider_model_id": provider_model_id,
        "backend_model_id": backend_model_id,
        "endpoint_guard": endpoint_guard,
        "prompt": prompt,
        "duration_seconds": int(duration_seconds),
        "aspect_ratio": aspect_ratio,
        "resolution": resolution,
        "generate_audio": bool(generate_audio),
        "output_type": output_type,
        "parent_creation_id": parent_creation_id,
        "api_call_id": api_call_id,
    }


def dump_free_video_checkpoint(checkpoint: dict[str, Any]) -> str:
    return json.dumps(checkpoint, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_free_video_checkpoint(task: dict[str, Any]) -> dict[str, Any]:
    """Parse and bind a free-video checkpoint to its task row. Raises on mismatch."""
    raw = task.get("execution_checkpoint_json")
    if not isinstance(raw, str) or not raw.strip():
        raise ReferenceExecutionIdentityError("free video checkpoint is missing")
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ReferenceExecutionIdentityError("free video checkpoint is not valid JSON") from exc
    if not isinstance(decoded, dict) or decoded.get("kind") != FREE_VIDEO_CHECKPOINT_KIND:
        raise ReferenceExecutionIdentityError("unsupported free video checkpoint kind")
    missing = _Fields - set(decoded)
    unexpected = set(decoded) - _Fields
    if missing or unexpected:
        raise ReferenceExecutionIdentityError(
            f"free video checkpoint fields mismatch missing={sorted(missing)} unexpected={sorted(unexpected)}"
        )
    row_task_type = task.get("task_type")
    if row_task_type not in {"free_video", "free_edit"}:
        raise ReferenceExecutionIdentityError(f"free video checkpoint does not match task type {row_task_type!r}")
    expected = (
        ("task_id", decoded.get("task_id"), task.get("task_id")),
        ("project_name", decoded.get("project_name"), task.get("project_name")),
        ("unit_id", decoded.get("unit_id"), str(task.get("resource_id"))),
    )
    for field, frozen, row_value in expected:
        if frozen != row_value:
            raise ReferenceExecutionIdentityError(
                f"free video checkpoint {field}={frozen!r} does not match task row {row_value!r}"
            )
    return decoded


def classify_free_video_resume_state(task: dict[str, Any]) -> tuple[VideoResumeState, dict[str, Any] | None]:
    raw_checkpoint = task.get("execution_checkpoint_json")
    has_checkpoint = raw_checkpoint not in (None, "")
    has_job = bool(task.get("provider_job_id"))
    if not has_job:
        state = VideoResumeState.CHECKPOINT_WITHOUT_JOB if has_checkpoint else VideoResumeState.NO_CHECKPOINT_NO_JOB
        return state, None
    if not has_checkpoint:
        return VideoResumeState.IDENTITY_UNRECOVERABLE, None
    try:
        return VideoResumeState.READY, load_free_video_checkpoint(task)
    except (TypeError, ValueError, ReferenceExecutionIdentityError):
        return VideoResumeState.IDENTITY_UNRECOVERABLE, None
