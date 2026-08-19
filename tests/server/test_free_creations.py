from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from lib.api_errors import BadRequestError
from lib.artifact_manifest import ArtifactKey, ProjectArtifactManifestAdapter
from lib.version_manager import VersionManager
from server.routers.free_creations import (
    FreeCreationRequest,
    _free_request_payload,
    _preflight_free_creation,
    _record_batch_compensation,
    _record_enqueued_metadata,
    _validate_declared_resolution,
    _validate_references,
    get_free_creation_capabilities,
)
from server.services import free_creation_tasks as free_creation_tasks_module
from server.services.free_creation_tasks import (
    commit_free_creation_state,
    discard_free_creation_result,
    execute_free_video_task,
    list_creation_metadata,
    load_creation_metadata,
    register_free_creation_artifact,
    write_creation_metadata,
)

pytestmark = pytest.mark.unit


def test_free_creation_request_validates_mode_specific_fields() -> None:
    request = FreeCreationRequest(output_type="video", prompt="city at night", aspect_ratio="21:9")
    assert request.aspect_ratio == "21:9"
    assert FreeCreationRequest(output_type="video", prompt="city", duration_seconds=30).duration_seconds == 30
    assert FreeCreationRequest(output_type="image", prompt="poster", quantity=4, size="1024x1024").quantity == 4

    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="video", prompt="city", duration_seconds=31)
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="image", prompt="poster", duration_seconds=4)
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="edit", prompt="rainy background")
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="video", prompt="city", aspect_ratio="wide")
    with pytest.raises(ValidationError):
        FreeCreationRequest.model_validate({"output_type": "image", "prompt": "poster", "prompt_mode": "enhance"})
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="image", prompt="   ")
    with pytest.raises(ValidationError):
        FreeCreationRequest(
            output_type="video",
            prompt="city",
            parent_creation_id="c_0123456789abcdef0123",
        )
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="edit", prompt="rainy background", quantity=2)
    with pytest.raises(ValidationError):
        FreeCreationRequest(output_type="video", prompt="city", size="1024x1024")


def test_free_creation_model_selects_only_the_requested_media_lane() -> None:
    image = _free_request_payload(
        FreeCreationRequest(output_type="image", prompt="poster", model="ark/doubao-seedream-4-0"),
        "image",
    )
    assert image["image_provider"] == "ark"
    assert image["image_model"] == "doubao-seedream-4-0"
    assert "video_provider" not in image

    video = _free_request_payload(
        FreeCreationRequest(output_type="video", prompt="city", model="ark/doubao-seedance-1-5-pro"),
        "video",
    )
    assert video["video_provider"] == "ark"
    assert video["video_model"] == "doubao-seedance-1-5-pro"
    assert "image_provider" not in video

    with pytest.raises(BadRequestError):
        _free_request_payload(
            FreeCreationRequest(output_type="image", prompt="poster", model="missing-provider"),
            "image",
        )


def test_declared_video_resolution_is_rejected_before_enqueue() -> None:
    with pytest.raises(BadRequestError):
        _validate_declared_resolution("ark", "doubao-seedance-1-5-pro-251215", "4k")

    _validate_declared_resolution("ark", "doubao-seedance-1-5-pro-251215", "1080P")


@pytest.mark.asyncio
async def test_video_reference_duration_is_rejected_from_backend_context_before_enqueue(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async def _context(*_args, **_kwargs):
        return SimpleNamespace(
            video=SimpleNamespace(
                supported_durations=tuple(range(2, 16)),
                supported_durations_with_reference_video=tuple(range(2, 11)),
                supported_aspect_ratios=("16:9", "9:16"),
                max_reference_images=5,
                max_reference_videos=5,
                max_reference_media_count=5,
                provider_model=SimpleNamespace(provider_id="dashscope"),
                backend_model="wan2.7-r2v",
            )
        )

    monkeypatch.setattr("server.routers.free_creations.resolve_generation_context", _context)
    request = FreeCreationRequest(
        output_type="video",
        prompt="restyle this clip",
        references=["uploads/clip.mp4"],
        aspect_ratio="16:9",
        duration_seconds=12,
    )

    with pytest.raises(BadRequestError) as exc:
        await _preflight_free_creation(
            "demo",
            {"content_mode": "free", "aspect_ratio": "16:9"},
            tmp_path,
            request,
            media_type="video",
            user_id="user-1",
        )

    assert exc.value.key == "video_duration_not_supported"
    assert exc.value.params["supported"] == "2, 3, 4, 5, 6, 7, 8, 9, 10"


@pytest.mark.asyncio
async def test_capability_endpoint_uses_video_reference_duration_subset(monkeypatch) -> None:
    class FakeResolver:
        def __init__(self, _session_factory):
            pass

        async def resolve_video_backend(self, _project, _payload, *, capability=None):
            assert capability == "r2v"
            return SimpleNamespace(provider_id="dashscope", model_id="wan2.7-r2v")

        async def video_capabilities_for_model(self, _provider_id, _model_id, _project):
            return {
                "supported_durations": list(range(2, 16)),
                "supported_durations_with_reference_video": list(range(2, 11)),
                "supported_aspect_ratios": ["16:9", "9:16"],
                "max_reference_images": 5,
                "max_reference_videos": 5,
                "max_reference_media_count": 5,
            }

        async def resolve_resolution(self, _project, _provider_id, _model_id):
            return None

    monkeypatch.setattr("lib.config.resolver.ConfigResolver", FakeResolver)

    result = await get_free_creation_capabilities(
        output_type="video",
        model=None,
        reference_kind="video",
    )

    assert result["durations"] == list(range(2, 11))
    assert result["ratios"] == ["16:9", "9:16"]


@pytest.mark.asyncio
async def test_capability_endpoint_fails_when_video_ratios_are_undeclared(monkeypatch) -> None:
    class FakeResolver:
        def __init__(self, _session_factory):
            pass

        async def resolve_video_backend(self, _project, _payload, *, capability=None):
            return SimpleNamespace(provider_id="custom-provider", model_id="unknown-video")

        async def video_capabilities_for_model(self, _provider_id, _model_id, _project):
            return {"supported_durations": [4, 8], "supported_aspect_ratios": []}

    monkeypatch.setattr("lib.config.resolver.ConfigResolver", FakeResolver)

    with pytest.raises(BadRequestError) as exc:
        await get_free_creation_capabilities(output_type="video", model=None, reference_kind="none")

    assert exc.value.key == "free_creation_aspect_ratio_capabilities_missing"


@pytest.mark.asyncio
async def test_prompt_only_free_video_executes_only_the_video_lane(tmp_path: Path, monkeypatch) -> None:
    output_path = tmp_path / "creations" / "c_0123456789abcdef0123.mp4"
    output_path.parent.mkdir(parents=True)
    output_path.write_bytes(b"video")
    video_calls: list[dict] = []

    class FakeProjectManager:
        def load_project(self, _project_name):
            return {"content_mode": "free", "aspect_ratio": "16:9"}

        def get_project_path(self, _project_name):
            return tmp_path

    class VideoOnlyGenerator:
        async def generate_video_async(self, **kwargs):
            video_calls.append(kwargs)
            return output_path, 1, None, None

        async def generate_image_async(self, **_kwargs):
            raise AssertionError("prompt-only free video must not call the image lane")

    async def _context(*_args, **kwargs):
        assert kwargs.get("video") is not None
        assert "image" not in kwargs
        return SimpleNamespace(
            generator=VideoOnlyGenerator(),
            video=SimpleNamespace(
                provider_model=SimpleNamespace(provider_id="ark"),
                backend_model="doubao-seedance-2-0",
                resolution="1080p",
            ),
        )

    monkeypatch.setattr(free_creation_tasks_module, "get_project_manager", lambda: FakeProjectManager())
    monkeypatch.setattr(free_creation_tasks_module, "resolve_generation_context", _context)

    result = await execute_free_video_task(
        "demo",
        "c_0123456789abcdef0123",
        {"prompt": "a quiet city at night", "aspect_ratio": "16:9", "duration_seconds": 6},
        user_id="user-1",
        commit_result=False,
    )

    assert result["media_type"] == "video"
    assert result["model"] == "ark/doubao-seedance-2-0"
    assert len(video_calls) == 1
    assert video_calls[0]["reference_images"] is None
    assert video_calls[0]["reference_videos"] is None
    assert video_calls[0]["duration_seconds"] == 6


def test_reference_validation_is_media_aware_and_path_safe(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    uploads = project_path / "uploads"
    uploads.mkdir(parents=True)
    (uploads / "frame.png").write_bytes(b"png")
    (uploads / "voice.wav").write_bytes(b"wav")
    (uploads / "clip.mp4").write_bytes(b"mp4")
    (uploads / "clip.mov").write_bytes(b"mov")
    (uploads / "notes.txt").write_text("notes", encoding="utf-8")

    _validate_references(project_path, ["uploads/frame.png"], "image")
    _validate_references(
        project_path,
        ["uploads/frame.png", "uploads/voice.wav", "uploads/clip.mp4", "uploads/clip.mov"],
        "video",
    )

    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["uploads/voice.wav"], "image")
    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["uploads/notes.txt"], "video")
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


def test_list_creation_metadata_honors_recent_limit(tmp_path: Path) -> None:
    for index in range(3):
        creation_id = f"c_{index:020x}"
        write_creation_metadata(tmp_path, creation_id, {"creation_id": creation_id, "status": "succeeded"})

    assert len(list_creation_metadata(tmp_path, limit=2)) == 2


def test_free_creation_artifact_is_registered_in_project_manifest(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    media = tmp_path / "creations" / f"{creation_id}.png"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"generated image")

    register_free_creation_artifact(
        tmp_path,
        {
            "creation_id": creation_id,
            "output_type": "image",
            "prompt": "a red kite",
            "references": [],
            "media_path": media.relative_to(tmp_path).as_posix(),
        },
    )

    entry = ProjectArtifactManifestAdapter(tmp_path).get_entry(ArtifactKey.free_creation(creation_id))
    assert entry is not None
    assert entry.artifact_path == f"creations/{creation_id}.png"


def test_free_creation_state_rolls_back_manifest_when_metadata_write_fails(tmp_path: Path, monkeypatch) -> None:
    creation_id = "c_0123456789abcdef0123"
    media = tmp_path / "creations" / f"{creation_id}.png"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"generated image")

    def _fail_write(*_args, **_kwargs):
        raise OSError("metadata disk full")

    monkeypatch.setattr(free_creation_tasks_module, "write_creation_metadata", _fail_write)
    with pytest.raises(OSError, match="metadata disk full"):
        commit_free_creation_state(
            tmp_path,
            {
                "creation_id": creation_id,
                "output_type": "image",
                "prompt": "a red kite",
                "references": [],
                "media_path": f"creations/{creation_id}.png",
            },
        )

    assert ProjectArtifactManifestAdapter(tmp_path).get_entry(ArtifactKey.free_creation(creation_id)) is None


def test_discard_free_creation_result_rejects_current_version_and_claim(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    media = tmp_path / "creations" / f"{creation_id}.png"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"generated image")
    version = VersionManager(tmp_path).add_version("free_images", creation_id, "a red kite", source_file=media)
    metadata = {
        "creation_id": creation_id,
        "output_type": "image",
        "prompt": "a red kite",
        "references": [],
        "media_path": f"creations/{creation_id}.png",
        "version": version,
    }
    register_free_creation_artifact(tmp_path, metadata)

    assert discard_free_creation_result(tmp_path, metadata) is True
    assert not media.exists()
    assert ProjectArtifactManifestAdapter(tmp_path).get_entry(ArtifactKey.free_creation(creation_id)) is None
    assert VersionManager(tmp_path).get_versions("free_images", creation_id)["current_version"] == 0


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


def test_batch_compensation_does_not_overwrite_a_fast_terminal_result(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    task_id = "task-fast"
    terminal = {
        "creation_id": creation_id,
        "task_id": task_id,
        "status": "succeeded",
        "media_path": f"creations/{creation_id}.png",
    }
    write_creation_metadata(tmp_path, creation_id, terminal)

    _record_batch_compensation(
        tmp_path,
        creation_id,
        task_id,
        {"prompt": "a red kite"},
        "cancelling",
    )

    assert load_creation_metadata(tmp_path, creation_id) == terminal


def test_batch_compensation_records_cancelled_item_when_metadata_write_was_lost(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    _record_batch_compensation(
        tmp_path,
        creation_id,
        "task-lost-write",
        {"prompt": "a red kite", "output_type": "image"},
        "cancelled",
    )

    stored = load_creation_metadata(tmp_path, creation_id)
    assert stored is not None
    assert stored["status"] == "cancelled"
    assert stored["prompt"] == "a red kite"
