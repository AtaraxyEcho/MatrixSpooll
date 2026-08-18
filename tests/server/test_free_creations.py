from pathlib import Path

import pytest
from pydantic import ValidationError

from lib.api_errors import BadRequestError
from server.routers.free_creations import (
    FreeCreationRequest,
    _record_enqueued_metadata,
    _validate_references,
)
from server.services.free_creation_tasks import load_creation_metadata, write_creation_metadata

pytestmark = pytest.mark.unit


def test_free_creation_request_validates_mode_specific_fields() -> None:
    request = FreeCreationRequest(output_type="video", prompt="city at night", aspect_ratio="21:9")
    assert request.aspect_ratio == "21:9"

    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="image", prompt="poster", duration_seconds=4)
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="edit", prompt="rainy background")
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="video", prompt="city", aspect_ratio="wide")
    with pytest.raises(ValidationError):
        FreeCreationRequest.model_validate(
            {"output_type": "image", "prompt": "poster", "prompt_mode": "enhance"}
        )
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="image", prompt="   ")
    with pytest.raises(ValidationError):
        FreeCreationRequest(
            output_type="video",
            prompt="city",
            parent_creation_id="c_0123456789abcdef0123",
        )


def test_reference_validation_is_media_aware_and_path_safe(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    uploads = project_path / "uploads"
    uploads.mkdir(parents=True)
    (uploads / "frame.png").write_bytes(b"png")
    (uploads / "voice.wav").write_bytes(b"wav")
    (uploads / "clip.mp4").write_bytes(b"mp4")

    _validate_references(project_path, ["uploads/frame.png"], "image")
    _validate_references(project_path, ["uploads/frame.png", "uploads/voice.wav"], "video")

    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["uploads/voice.wav"], "image")
    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["uploads/clip.mp4"], "video")
    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["../outside.png"], "image")


def test_record_enqueued_metadata_preserves_fast_terminal_result(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "task_id": "task-new",
            "status": "succeeded",
            "media_path": f"creations/{creation_id}.png",
        },
    )

    result = _record_enqueued_metadata(
        tmp_path,
        creation_id,
        "task-new",
        {"prompt": "new prompt", "output_type": "image"},
    )

    assert result["status"] == "succeeded"
    assert result["media_path"] == f"creations/{creation_id}.png"


def test_record_enqueued_metadata_resets_retry_to_queued(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "task_id": "task-old",
            "status": "failed",
            "error": "provider failed",
            "prompt": "retry me",
        },
    )

    _record_enqueued_metadata(tmp_path, creation_id, "task-new", {})
    result = load_creation_metadata(tmp_path, creation_id)

    assert result is not None
    assert result["status"] == "queued"
    assert result["task_id"] == "task-new"
    assert "error" not in result


def test_record_enqueued_metadata_preserves_fast_running_state(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {"creation_id": creation_id, "task_id": "task-new", "status": "running"},
    )

    result = _record_enqueued_metadata(
        tmp_path,
        creation_id,
        "task-new",
        {"prompt": "new prompt", "output_type": "video"},
    )

    assert result["status"] == "running"
    assert result["prompt"] == "new prompt"
