"""Free-video submit checkpoint classification."""

from __future__ import annotations

import pytest

from lib.free_video_checkpoint import (
    build_free_video_checkpoint,
    classify_free_video_resume_state,
    dump_free_video_checkpoint,
    load_free_video_checkpoint,
)
from lib.reference_video.execution_checkpoint import ReferenceExecutionIdentityError, VideoResumeState

pytestmark = pytest.mark.unit


def _checkpoint(**overrides):
    base = dict(
        task_id="t1",
        project_name="demo",
        resource_id="c_abc",
        capability="r2v",
        provider_id="ark",
        provider_model_id="m",
        backend_model_id="m",
        endpoint_guard=None,
        prompt="hello",
        duration_seconds=4,
        aspect_ratio="9:16",
        resolution=None,
        generate_audio=True,
        api_call_id=42,
    )
    base.update(overrides)
    return build_free_video_checkpoint(**base)


def test_roundtrip_and_ready_state():
    raw = dump_free_video_checkpoint(_checkpoint())
    task = {
        "task_id": "t1",
        "project_name": "demo",
        "resource_id": "c_abc",
        "task_type": "free_video",
        "media_type": "video",
        "provider_job_id": "job-1",
        "execution_checkpoint_json": raw,
    }
    state, checkpoint = classify_free_video_resume_state(task)
    assert state is VideoResumeState.READY
    assert checkpoint is not None
    assert checkpoint["provider_id"] == "ark"
    assert load_free_video_checkpoint(task)["prompt"] == "hello"


def test_no_job_is_checkpoint_without_job():
    raw = dump_free_video_checkpoint(_checkpoint())
    state, _ = classify_free_video_resume_state(
        {
            "task_type": "free_video",
            "resource_id": "c_abc",
            "task_id": "t1",
            "project_name": "demo",
            "execution_checkpoint_json": raw,
        }
    )
    assert state is VideoResumeState.CHECKPOINT_WITHOUT_JOB


def test_job_without_checkpoint_is_unrecoverable():
    state, _ = classify_free_video_resume_state({"provider_job_id": "job", "execution_checkpoint_json": None})
    assert state is VideoResumeState.IDENTITY_UNRECOVERABLE


def test_mismatched_task_id_rejected():
    raw = dump_free_video_checkpoint(_checkpoint())
    with pytest.raises(ReferenceExecutionIdentityError):
        load_free_video_checkpoint(
            {
                "task_id": "other",
                "project_name": "demo",
                "resource_id": "c_abc",
                "task_type": "free_video",
                "execution_checkpoint_json": raw,
            }
        )
