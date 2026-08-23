import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError
from starlette.requests import Request

from lib.api_errors import BadRequestError
from lib.artifact_manifest import ArtifactKey, ProjectArtifactManifestAdapter
from lib.generation_queue import free_video_capability
from lib.i18n import _ as translate_message
from lib.task_failure import encode_failure
from lib.version_manager import VersionManager
from lib.video_backends.base import VideoCapabilityError
from server.auth import CurrentUserInfo
from server.routers import free_creations as free_creation_router_module
from server.routers.free_creations import (
    FreeCreationRequest,
    _free_creation_request_summary,
    _free_request_payload,
    _localize_creation,
    _preflight_free_creation,
    _record_batch_compensation,
    _record_enqueued_metadata,
    _validate_declared_resolution,
    _validate_reference_roles,
    _validate_references,
    get_free_creation_capabilities,
    get_free_creation_cover,
    get_model_capabilities,
    retry_free_creation,
)
from server.services import free_creation_merge as free_creation_merge_module
from server.services import free_creation_tasks as free_creation_tasks_module
from server.services.free_creation_merge import (
    composite_creation_audio,
    render_creation_subtitles,
    resolve_audio_composite_paths,
    resolve_merge_video_paths,
)
from server.services.free_creation_planner import plan_video_references
from server.services.free_creation_tasks import (
    commit_free_creation_state,
    delete_creation_metadata,
    discard_free_creation_result,
    execute_free_audio_task,
    execute_free_edit_task,
    execute_free_video_task,
    list_creation_metadata,
    load_creation_metadata,
    register_free_creation_artifact,
    restore_creation_metadata,
    write_creation_metadata,
)
from server.services.free_creation_workspace import (
    build_creation_export,
    create_storyboard_plan,
    create_subtitle_track,
    delete_reference_upload,
    delete_storyboard_plan,
    delete_subtitle_track,
    derive_storyboard_plan_status,
    list_creation_requests,
    list_reference_uploads,
    list_storyboard_plans,
    load_canvas_state,
    load_storyboard_plan,
    load_subtitle_track,
    read_reference_preview,
    resolve_reference_claims,
    restore_reference_upload,
    save_canvas_state,
    save_reference_upload,
    save_storyboard_plan,
    save_subtitle_track,
    split_storyboard_text,
    subtitle_track_webvtt,
    write_creation_request,
)

pytestmark = pytest.mark.unit


async def test_free_creation_cover_uses_the_stored_thumbnail_path(tmp_path: Path, monkeypatch) -> None:
    creation_id = "c_0123456789abcdef0123"
    cover = tmp_path / "free_creation" / "covers" / f"{creation_id}.jpg"
    cover.parent.mkdir(parents=True)
    cover.write_bytes(b"jpeg-cover")
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "output_type": "video",
            "media_type": "video",
            "status": "succeeded",
            "cover_path": cover.relative_to(tmp_path).as_posix(),
        },
    )
    monkeypatch.setattr(
        free_creation_router_module,
        "_load_free_project",
        lambda _project_name: ({"content_mode": "free"}, tmp_path),
    )
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": f"/projects/demo/creations/{creation_id}/cover",
            "query_string": b"v=3",
            "headers": [],
        }
    )

    response = await get_free_creation_cover(
        "demo",
        creation_id,
        request,
        CurrentUserInfo(id="user", sub="user", role="member"),
    )

    assert response.media_type == "image/jpeg"
    assert Path(getattr(response, "path")) == cover
    assert "immutable" in response.headers["cache-control"]


def test_localize_creation_exposes_specific_failure_in_request_language() -> None:
    stored = encode_failure("video_first_frame_content_rejected")

    localized = _localize_creation(
        {
            "creation_id": "c_0123456789abcdef0123",
            "status": "failed",
            "error_code": "video_first_frame_content_rejected",
            "error": stored,
        },
        lambda key, **params: translate_message(key, locale="zh", **params),
    )

    assert localized["error_code"] == "video_first_frame_content_rejected"
    assert localized["error_params"] == {}
    assert "首帧" in localized["error"]
    assert not localized["error"].startswith("[")


def test_free_creation_request_read_model_aggregates_batch_status() -> None:
    request_id = "q_0123456789abcdef0123"
    first_id = "c_0123456789abcdef0123"
    second_id = "c_0123456789abcdef0124"
    summary = _free_creation_request_summary(
        {
            "request_id": request_id,
            "prompt": "A quiet station at night",
            "output_type": "video",
            "effective_mode": "reference_image",
            "model": "ark/seedance",
            "reference_claims": [
                {"type": "upload", "reference_id": "r_0123456789abcdef0123", "role": "reference_image"}
            ],
            "quantity": 2,
            "creation_ids": [first_id, second_id],
            "created_at": "2026-08-19T10:00:00+00:00",
        },
        {
            first_id: {
                "creation_id": first_id,
                "status": "succeeded",
                "updated_at": "2026-08-19T10:01:00+00:00",
            },
            second_id: {
                "creation_id": second_id,
                "status": "failed",
                "updated_at": "2026-08-19T10:02:00+00:00",
            },
        },
    )

    assert summary["status"] == "partial"
    assert summary["result_count"] == 1
    assert summary["reference_count"] == 1
    assert summary["effective_mode"] == "reference_image"
    assert summary["updated_at"] == "2026-08-19T10:02:00+00:00"


def test_creation_requests_are_read_from_the_request_record_store(tmp_path: Path) -> None:
    write_creation_request(
        tmp_path,
        "q_0123456789abcdef0123",
        {"prompt": "First request", "creation_ids": ["c_0123456789abcdef0123"]},
    )
    write_creation_request(
        tmp_path,
        "q_0123456789abcdef0124",
        {"prompt": "Second request", "creation_ids": ["c_0123456789abcdef0124"]},
    )

    records = list_creation_requests(tmp_path)
    assert {item["prompt"] for item in records} == {"First request", "Second request"}
    assert len(list_creation_requests(tmp_path, limit=1)) == 1


def test_storyboard_splitter_preserves_short_sentences_and_caps_shots() -> None:
    text = "One. Two. Three. Four. Five. Six."
    assert split_storyboard_text(text, max_shots=3) == ["One. Two.", "Three. Four.", "Five. Six."]
    assert split_storyboard_text("\n\n第一幕。\n\n第二幕。", max_shots=12) == ["第一幕。", "第二幕。"]


def test_storyboard_plan_persists_editable_shot_metadata(tmp_path: Path) -> None:
    plan = create_storyboard_plan(
        tmp_path,
        title="Rain station",
        source={"type": "upload", "reference_id": "r_0123456789abcdef0123"},
        text="Exterior. Interior.",
    )
    assert plan["plan_id"].startswith("sp_")
    assert [shot["sequence_index"] for shot in plan["shots"]] == [0, 1]

    updated = save_storyboard_plan(
        tmp_path,
        {
            **plan,
            "shots": [
                {**plan["shots"][1], "sequence_index": 0},
                {**plan["shots"][0], "sequence_index": 1},
            ],
        },
    )
    loaded = load_storyboard_plan(tmp_path, plan["plan_id"])
    assert loaded is not None
    assert updated["shots"][0]["sequence_index"] == 0
    assert loaded["shots"][1]["sequence_index"] == 1


def test_storyboard_plan_tracks_source_revision_and_soft_delete(tmp_path: Path) -> None:
    plan = create_storyboard_plan(tmp_path, title="Prompt source", source=None, text="A. B.")
    assert plan["source"] == {"type": "prompt", "text": "A. B."}
    assert plan["revision"] == 1

    updated = save_storyboard_plan(tmp_path, {**plan, "title": "Updated"}, expected_revision=1)
    assert updated["revision"] == 2
    with pytest.raises(RuntimeError, match="revision conflict"):
        save_storyboard_plan(tmp_path, {**updated, "title": "Stale"}, expected_revision=1)

    assert len(list_storyboard_plans(tmp_path)) == 1
    delete_storyboard_plan(tmp_path, plan["plan_id"])
    assert load_storyboard_plan(tmp_path, plan["plan_id"]) is None
    assert list_storyboard_plans(tmp_path) == []


def test_storyboard_plan_status_is_derived_from_its_creation_results() -> None:
    plan = {
        "status": "generating",
        "shots": [
            {"image_creation_id": "c_0123456789abcdef0123", "video_creation_id": None},
            {"image_creation_id": "c_0123456789abcdef0124", "video_creation_id": None},
        ],
    }
    states = {
        "c_0123456789abcdef0123": {"status": "succeeded"},
        "c_0123456789abcdef0124": {"status": "failed"},
    }

    assert derive_storyboard_plan_status(Path(), plan, load_creation=lambda _path, item: states.get(item)) == "partial"
    states["c_0123456789abcdef0124"] = {"status": "succeeded"}
    assert derive_storyboard_plan_status(Path(), plan, load_creation=lambda _path, item: states.get(item)) == "ready"

    plan["shots"][1]["image_creation_id"] = None
    assert derive_storyboard_plan_status(Path(), plan, load_creation=lambda _path, item: states.get(item)) == "partial"

    plan["shots"][0]["video_creation_id"] = "c_0123456789abcdef0125"
    states["c_0123456789abcdef0125"] = {"status": "succeeded"}
    assert derive_storyboard_plan_status(Path(), plan, load_creation=lambda _path, item: states.get(item)) == "partial"


def test_subtitle_track_persists_cues_with_optimistic_revision_and_soft_delete(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    track = create_subtitle_track(
        tmp_path,
        creation_id=creation_id,
        text="A quiet station at night",
        duration_seconds=8,
    )
    assert track["subtitle_id"].startswith("sub_")
    assert track["revision"] == 1
    assert track["cues"] == [{"start_seconds": 0.0, "end_seconds": 8, "text": "A quiet station at night"}]
    assert subtitle_track_webvtt(track) == ("WEBVTT\n\n1\n00:00:00.000 --> 00:00:08.000\nA quiet station at night\n")

    updated = save_subtitle_track(
        tmp_path,
        {**track, "cues": [{"start_seconds": 1.0, "end_seconds": 4.0, "text": "The train arrives."}]},
        expected_revision=1,
    )
    assert updated["revision"] == 2
    assert load_subtitle_track(tmp_path, track["subtitle_id"]) == updated
    with pytest.raises(RuntimeError, match="revision conflict"):
        save_subtitle_track(tmp_path, {**updated, "cues": []}, expected_revision=1)

    delete_subtitle_track(tmp_path, track["subtitle_id"])
    assert load_subtitle_track(tmp_path, track["subtitle_id"]) is None


def test_free_creation_request_validates_mode_specific_fields() -> None:
    request = FreeCreationRequest(output_type="video", prompt="city at night", aspect_ratio="21:9")
    assert request.aspect_ratio == "21:9"
    assert FreeCreationRequest(output_type="video", prompt="city", duration_seconds=60).duration_seconds == 60
    assert FreeCreationRequest(output_type="image", prompt="poster", quantity=4, size="1024x1024").quantity == 4

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


def test_reference_roles_are_explicit_and_lane_aware() -> None:
    with pytest.raises(BadRequestError) as missing:
        _validate_reference_roles(
            [{"type": "upload", "reference_id": "r_0123456789abcdef0123"}],
            ["uploads/frame.png"],
            "video",
        )
    assert missing.value.key == "free_creation_reference_role_required"

    with pytest.raises(BadRequestError) as unsupported:
        _validate_reference_roles(
            [{"type": "upload", "reference_id": "r_0123456789abcdef0123", "role": "first_frame"}],
            ["uploads/frame.png"],
            "image",
        )
    assert unsupported.value.key == "free_creation_reference_role_unsupported"


def test_video_reference_plan_keeps_paths_and_explicit_roles_aligned() -> None:
    references = [
        Path("uploads/first.png"),
        Path("uploads/last.png"),
        Path("uploads/style.png"),
        Path("uploads/motion.mp4"),
        Path("uploads/voice.wav"),
        Path("uploads/script.md"),
    ]
    plan = plan_video_references(
        references,
        [
            {"role": "first_frame"},
            {"role": "last_frame"},
            {"role": "reference_image"},
            {"role": "reference_video"},
            {"role": "reference_audio"},
            {"role": "prompt_context"},
        ],
    )

    assert plan.start_image == references[0]
    assert plan.end_image == references[1]
    assert plan.reference_images == (references[2],)
    assert plan.reference_videos == (references[3],)
    assert plan.reference_audio == (references[4],)
    legacy = plan_video_references(references[:2], [])
    assert legacy.reference_images == tuple(references[:2])
    with pytest.raises(ValueError, match="align"):
        plan_video_references(references[:2], [{"role": "first_frame"}])


def test_reference_audio_selects_the_reference_video_capability_bucket() -> None:
    assert free_video_capability({"reference_claims": [{"role": "reference_audio"}]}) == "r2v"


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
async def test_video_duration_defaults_to_the_selected_models_first_declared_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async def _context(*_args, **_kwargs):
        return SimpleNamespace(
            video=SimpleNamespace(
                supported_durations=(6, 10),
                supported_durations_with_reference_video=(),
                supported_aspect_ratios=("16:9",),
                max_reference_images=0,
                max_reference_videos=0,
                max_reference_media_count=0,
                provider_model=SimpleNamespace(provider_id="fake"),
                backend_model="six-second-model",
            )
        )

    monkeypatch.setattr("server.routers.free_creations.resolve_generation_context", _context)
    request = FreeCreationRequest(output_type="video", prompt="city", aspect_ratio="16:9")

    payload = await _preflight_free_creation(
        "demo",
        {"content_mode": "free", "aspect_ratio": "16:9"},
        tmp_path,
        request,
        media_type="video",
        user_id="user-1",
    )

    assert payload["duration_seconds"] == 6


@pytest.mark.asyncio
async def test_preflight_rejects_frame_and_reference_roles_in_one_request(
    tmp_path: Path,
    monkeypatch,
) -> None:
    async def _context(*_args, **_kwargs):
        return SimpleNamespace(
            video=SimpleNamespace(
                supported_durations=(4, 8, 12),
                supported_durations_with_reference_video=(),
                supported_aspect_ratios=("16:9", "9:16"),
                max_reference_images=3,
                max_reference_videos=1,
                max_reference_media_count=3,
                max_reference_audio_count=0,
                provider_model=SimpleNamespace(provider_id="anyfast"),
                backend_model="seedance-2.0",
                text_to_video=True,
                first_frame=True,
                last_frame=True,
            )
        )

    monkeypatch.setattr("server.routers.free_creations.resolve_generation_context", _context)
    request = FreeCreationRequest(
        output_type="video",
        prompt="a train in rain",
        references=["uploads/frame.png", "uploads/style.png"],
        aspect_ratio="16:9",
        duration_seconds=8,
    )

    with pytest.raises(BadRequestError) as exc:
        await _preflight_free_creation(
            "demo",
            {"content_mode": "free", "aspect_ratio": "16:9"},
            tmp_path,
            request,
            media_type="video",
            reference_claims=[
                {"type": "upload", "reference_id": "r-frame", "role": "first_frame"},
                {"type": "upload", "reference_id": "r-style", "role": "reference_image"},
            ],
            user_id="user-1",
        )

    assert exc.value.key == "free_creation_input_combination_unsupported"


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
async def test_capability_endpoint_limits_first_frame_to_adaptive_ratio(monkeypatch) -> None:
    class FakeResolver:
        def __init__(self, _session_factory):
            pass

        async def resolve_video_backend(self, _project, _payload, *, capability=None):
            assert capability == "i2v"
            return SimpleNamespace(provider_id="custom-provider", model_id="frame-model")

        async def video_capabilities_for_model(self, _provider_id, _model_id, _project):
            return {
                "supported_durations": [4, 8],
                "supported_aspect_ratios": ["16:9", "adaptive", "9:16"],
                "first_frame_ratio_adaptive_only": True,
            }

        async def resolve_resolution(self, _project, _provider_id, _model_id):
            return None

    monkeypatch.setattr("lib.config.resolver.ConfigResolver", FakeResolver)

    result = await get_free_creation_capabilities(output_type="video", model=None, reference_kind="frame")

    assert result["ratios"] == ["adaptive"]


@pytest.mark.asyncio
async def test_capability_endpoint_hides_first_frame_only_adaptive_ratio_for_t2v(monkeypatch) -> None:
    class FakeResolver:
        def __init__(self, _session_factory):
            pass

        async def resolve_video_backend(self, _project, _payload, *, capability=None):
            assert capability is None
            return SimpleNamespace(provider_id="custom-provider", model_id="mixed-model")

        async def video_capabilities_for_model(self, _provider_id, _model_id, _project):
            return {
                "supported_durations": [4, 8],
                "supported_aspect_ratios": ["16:9", "adaptive", "9:16"],
                "first_frame_ratio_adaptive_only": True,
            }

        async def resolve_resolution(self, _project, _provider_id, _model_id):
            return None

    monkeypatch.setattr("lib.config.resolver.ConfigResolver", FakeResolver)

    result = await get_free_creation_capabilities(output_type="video", model=None, reference_kind="none")

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
async def test_model_capability_endpoint_describes_i2v_only_model_without_t2v_gate(monkeypatch) -> None:
    class FakeResolver:
        def __init__(self, _session_factory):
            pass

        async def resolve_video_backend(self, _project, payload, *, capability=None):
            assert capability is None
            assert payload == {
                "video_provider_i2v": "anyfast/seedance-i2v-only",
                "video_provider_r2v": "anyfast/seedance-i2v-only",
            }
            return SimpleNamespace(provider_id="anyfast", model_id="seedance-i2v-only")

        async def video_capabilities_for_model(self, _provider_id, _model_id, _project):
            return {
                "text_to_video": False,
                "first_frame": True,
                "last_frame": False,
                "supported_durations": [4, 8, 12],
                "supported_aspect_ratios": ["16:9", "9:16"],
                "supported_resolutions": ["480p", "720p", "1080p"],
                "max_reference_images": 0,
                "max_reference_videos": 0,
            }

        async def resolve_resolution(self, _project, _provider_id, _model_id):
            return None

    monkeypatch.setattr("lib.config.resolver.ConfigResolver", FakeResolver)

    result = await get_model_capabilities(
        output_type="video",
        model="anyfast/seedance-i2v-only",
    )

    assert result["model"] == "anyfast/seedance-i2v-only"
    assert result["text_to_video"] is False
    assert result["modes"] == ["first_frame"]
    assert result["resolutions"] == ["480p", "720p", "1080p"]


@pytest.mark.asyncio
async def test_model_capability_endpoint_does_not_silently_fallback_from_selected_model(monkeypatch) -> None:
    class FakeResolver:
        def __init__(self, _session_factory):
            pass

        async def resolve_video_backend(self, _project, _payload, *, capability=None):
            return SimpleNamespace(provider_id="anyfast", model_id="seedance-2.0")

    monkeypatch.setattr("lib.config.resolver.ConfigResolver", FakeResolver)

    with pytest.raises(BadRequestError) as exc:
        await get_model_capabilities(output_type="video", model="anyfast/seedance-2.0-ultra")

    assert exc.value.key == "video_model_unsupported"


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


@pytest.mark.asyncio
async def test_video_edit_stops_before_it_can_be_reinterpreted_as_generation(tmp_path: Path, monkeypatch) -> None:
    parent_id = "c_0123456789abcdef0123"

    class FakeProjectManager:
        def get_project_path(self, _project_name):
            return tmp_path

    monkeypatch.setattr(free_creation_tasks_module, "get_project_manager", lambda: FakeProjectManager())
    monkeypatch.setattr(
        free_creation_tasks_module,
        "load_creation_metadata",
        lambda _project_path, creation_id: {
            "creation_id": creation_id,
            "output_type": "video",
            "media_type": "video",
            "media_path": f"creations/{creation_id}.mp4",
        },
    )

    with pytest.raises(VideoCapabilityError) as error:
        await execute_free_edit_task(
            "demo",
            "c_0123456789abcdef0124",
            {"parent_creation_id": parent_id, "prompt": "make the rain heavier"},
            user_id="user-1",
        )
    assert error.value.code == "free_creation_video_edit_unsupported"


@pytest.mark.asyncio
async def test_free_audio_is_committed_as_a_versioned_creation(tmp_path: Path, monkeypatch) -> None:
    creation_id = "c_0123456789abcdef0123"
    output_path = tmp_path / "audio" / f"segment_{creation_id}.wav"
    output_path.parent.mkdir(parents=True)
    output_path.write_bytes(b"voice")

    class FakeProjectManager:
        def load_project(self, _project_name):
            return {"content_mode": "free"}

        def get_project_path(self, _project_name):
            return tmp_path

    class AudioGenerator:
        async def generate_audio_async(self, **kwargs):
            assert kwargs["resource_id"] == creation_id
            return output_path, 1

    async def _context(*_args, **kwargs):
        assert kwargs.get("audio") is not None
        return SimpleNamespace(
            generator=AudioGenerator(),
            audio=SimpleNamespace(
                provider_model=SimpleNamespace(provider_id="openai"),
                backend_model="tts-1",
                narration_voice="alloy",
                narration_speed=None,
                voices=(SimpleNamespace(id="alloy"),),
            ),
        )

    monkeypatch.setattr(free_creation_tasks_module, "get_project_manager", lambda: FakeProjectManager())
    monkeypatch.setattr(free_creation_tasks_module, "resolve_generation_context", _context)

    result = await execute_free_audio_task(
        "demo",
        creation_id,
        {"request_id": "q_0123456789abcdef0123", "text": "Night train announcement", "voice": "alloy"},
        user_id="user-1",
        task_id="task-audio",
    )

    assert result["creation_id"] == creation_id
    assert result["output_type"] == "audio"
    assert result["media_type"] == "audio"
    assert result["media_path"] == f"audio/segment_{creation_id}.wav"
    assert load_creation_metadata(tmp_path, creation_id) == result
    assert ProjectArtifactManifestAdapter(tmp_path).get_entry(ArtifactKey.free_creation(creation_id)) is not None


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
    _validate_references(
        project_path,
        ["uploads/notes.txt"],
        "video",
        [{"type": "upload", "reference_id": "r_0123456789abcdef0123", "role": "prompt_context"}],
    )

    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["uploads/voice.wav"], "image")
    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["uploads/notes.txt"], "video")
    with pytest.raises(BadRequestError):
        _validate_references(project_path, ["../outside.png"], "image")


def test_text_reference_uploads_are_stored_and_previewed(tmp_path: Path) -> None:
    reference = save_reference_upload(
        tmp_path,
        original_filename="scene.md",
        content=b"# Scene\n\nA quiet room.",
    )

    assert reference["media_type"] == "text"
    preview = read_reference_preview(tmp_path, reference["reference_id"])
    assert preview["supported"] is True
    assert preview["text"] == "# Scene\n\nA quiet room."


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


def test_deleted_creation_is_removed_from_lists_and_can_be_restored(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {"creation_id": creation_id, "status": "succeeded", "media_type": "video"},
    )

    deleted = delete_creation_metadata(tmp_path, creation_id)

    assert isinstance(deleted.get("deleted_at"), str)
    assert list_creation_metadata(tmp_path) == []
    restored = restore_creation_metadata(tmp_path, creation_id)
    assert "deleted_at" not in restored
    assert [item["creation_id"] for item in list_creation_metadata(tmp_path)] == [creation_id]


def test_active_creation_cannot_be_deleted(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    write_creation_metadata(tmp_path, creation_id, {"creation_id": creation_id, "status": "running"})

    with pytest.raises(RuntimeError, match="active free creation"):
        delete_creation_metadata(tmp_path, creation_id)


def test_reference_soft_delete_is_not_blocked_by_request_history(tmp_path: Path) -> None:
    upload = save_reference_upload(tmp_path, original_filename="reference.png", content=b"png")
    reference_id = upload["reference_id"]
    write_creation_request(
        tmp_path,
        "q_0123456789abcdef0123",
        {"reference_claims": [{"type": "upload", "reference_id": reference_id}]},
    )

    delete_reference_upload(tmp_path, reference_id)

    assert list_reference_uploads(tmp_path) == []
    restored = restore_reference_upload(tmp_path, reference_id)
    assert restored["reference_id"] == reference_id
    assert [item["reference_id"] for item in list_reference_uploads(tmp_path)] == [reference_id]


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


@pytest.mark.asyncio
async def test_failed_audio_creation_retries_through_the_audio_lane(tmp_path: Path, monkeypatch) -> None:
    creation_id = "c_0123456789abcdef0123"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "request_id": "q_0123456789abcdef0123",
            "output_type": "audio",
            "media_type": "audio",
            "status": "failed",
            "prompt": "Night train announcement",
            "voice": "alloy",
        },
    )
    queued: list[dict] = []

    class Queue:
        async def enqueue_task(self, **kwargs):
            queued.append(kwargs)
            return {"task_id": "task-audio-retry"}

    async def resolve_context(*_args, **kwargs):
        assert kwargs.get("audio") is not None
        return SimpleNamespace(
            audio=SimpleNamespace(
                narration_voice="alloy",
                voices=(SimpleNamespace(id="alloy"),),
                provider_model=SimpleNamespace(provider_id="openai"),
                backend_model="tts-1",
            )
        )

    monkeypatch.setattr(
        free_creation_router_module,
        "_load_free_project",
        lambda _project_name: ({"content_mode": "free"}, tmp_path),
    )
    monkeypatch.setattr(free_creation_router_module, "resolve_generation_context", resolve_context)
    monkeypatch.setattr(free_creation_router_module, "get_generation_queue", lambda: Queue())

    result = await retry_free_creation("demo", creation_id, CurrentUserInfo(id="user-1", sub="user-1"))

    assert result == {"success": True, "creation_id": creation_id, "task_id": "task-audio-retry"}
    assert queued[0]["task_type"] == "free_audio"
    assert queued[0]["media_type"] == "audio"
    assert queued[0]["payload"]["voice"] == "alloy"
    retried = load_creation_metadata(tmp_path, creation_id)
    assert retried is not None
    assert retried["status"] == "queued"
    assert retried["task_id"] == "task-audio-retry"


@pytest.mark.asyncio
async def test_failed_video_creation_retry_keeps_the_original_model(tmp_path: Path, monkeypatch) -> None:
    creation_id = "c_0123456789abcdef0123"
    original_model = "anyfast/seedance-2.0"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "request_id": "q_0123456789abcdef0123",
            "output_type": "video",
            "media_type": "video",
            "status": "failed",
            "prompt": "Night train announcement",
            "model": original_model,
            "references": [],
            "reference_claims": [],
            "aspect_ratio": "16:9",
            "duration_seconds": 8,
        },
    )
    captured: dict[str, Any] = {}

    async def fake_preflight(*args, **_kwargs):
        request = args[3]
        captured["model"] = request.model
        return {"model": request.model, "duration_seconds": request.duration_seconds}

    class Queue:
        async def enqueue_task(self, **kwargs):
            captured["payload"] = kwargs["payload"]
            return {"task_id": "task-video-retry"}

    monkeypatch.setattr(
        free_creation_router_module,
        "_load_free_project",
        lambda _project_name: ({"content_mode": "free"}, tmp_path),
    )
    monkeypatch.setattr(free_creation_router_module, "_validate_references", lambda *_args: None)
    monkeypatch.setattr(free_creation_router_module, "_preflight_free_creation", fake_preflight)
    monkeypatch.setattr(free_creation_router_module, "get_generation_queue", lambda: Queue())

    result = await retry_free_creation("demo", creation_id, CurrentUserInfo(id="user-1", sub="user-1"))

    assert result["model"] == original_model
    assert captured["model"] == original_model
    assert captured["payload"]["model"] == original_model


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


def test_canvas_state_persists_and_rejects_stale_revision(tmp_path: Path) -> None:
    saved = save_canvas_state(
        tmp_path,
        viewport={"x": 12.0, "y": -8.0, "scale": 0.9},
        positions={"c_0123456789abcdef0123": {"x": 120.0, "y": 80.0}},
        hidden_creation_ids=["c_0123456789abcdef0123"],
        groups=[
            {
                "group_id": "g_0123456789abcdef0123",
                "member_ids": ["c_0123456789abcdef0123", "r_0123456789abcdef0123"],
            }
        ],
        show_relations=False,
        expected_revision=0,
    )

    assert saved["revision"] == 1
    loaded = load_canvas_state(tmp_path)
    assert loaded["viewport"]["scale"] == 0.9
    assert loaded["groups"][0]["member_ids"] == [
        "c_0123456789abcdef0123",
        "r_0123456789abcdef0123",
    ]
    assert loaded["show_relations"] is False
    with pytest.raises(RuntimeError, match="revision conflict"):
        save_canvas_state(
            tmp_path,
            viewport={"x": 0.0, "y": 0.0, "scale": 1.0},
            positions={},
            hidden_creation_ids=[],
            expected_revision=0,
        )


def test_structured_references_resolve_without_exposing_paths(tmp_path: Path) -> None:
    upload = save_reference_upload(tmp_path, original_filename="reference.png", content=b"png")
    creation_id = "c_0123456789abcdef0123"
    media = tmp_path / "creations" / f"{creation_id}.png"
    media.parent.mkdir(parents=True, exist_ok=True)
    media.write_bytes(b"generated")
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "status": "succeeded",
            "version": 1,
            "media_path": f"creations/{creation_id}.png",
        },
    )

    paths, claims = resolve_reference_claims(
        tmp_path,
        [
            {"type": "upload", "reference_id": upload["reference_id"]},
            {"type": "creation", "creation_id": creation_id, "version": 1},
        ],
        load_creation=load_creation_metadata,
    )

    assert paths == [upload["path"], f"creations/{creation_id}.png"]
    assert claims[1] == {"type": "creation", "creation_id": creation_id, "version": 1}


def test_structured_creation_references_can_select_a_historical_version(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    media = tmp_path / "creations" / f"{creation_id}.png"
    media.parent.mkdir(parents=True, exist_ok=True)
    versions = VersionManager(tmp_path)
    media.write_bytes(b"first image")
    first_version = versions.add_version("free_images", creation_id, "first image", source_file=media)
    media.write_bytes(b"second image")
    second_version = versions.add_version("free_images", creation_id, "second image", source_file=media)
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "status": "succeeded",
            "media_type": "image",
            "version": second_version,
            "media_path": f"creations/{creation_id}.png",
        },
    )

    paths, claims = resolve_reference_claims(
        tmp_path,
        [{"type": "creation", "creation_id": creation_id, "version": first_version}],
        load_creation=load_creation_metadata,
    )

    assert paths[0].startswith("versions/free_images/")
    assert paths[0].endswith(".png")
    assert (tmp_path / paths[0]).read_bytes() == b"first image"
    assert claims == [{"type": "creation", "creation_id": creation_id, "version": first_version}]


def test_free_creation_export_uses_only_manifested_results(tmp_path: Path) -> None:
    creation_id = "c_0123456789abcdef0123"
    media = tmp_path / "creations" / f"{creation_id}.png"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"generated image")
    creation = {
        "creation_id": creation_id,
        "request_id": "q_0123456789abcdef0123",
        "status": "succeeded",
        "output_type": "image",
        "media_type": "image",
        "prompt": "a red kite",
        "references": [],
        "media_path": f"creations/{creation_id}.png",
    }
    register_free_creation_artifact(tmp_path, creation)

    archive = build_creation_export(
        tmp_path,
        scope="selected",
        creation_ids=[creation_id],
        request_id=None,
        creations=[creation],
    )
    try:
        with zipfile.ZipFile(archive) as bundle:
            assert f"media/{creation_id}.png" in bundle.namelist()
            assert "manifest.json" in bundle.namelist()
    finally:
        archive.unlink(missing_ok=True)


def test_free_creation_merge_resolves_only_manifested_videos_in_requested_order(tmp_path: Path) -> None:
    creations: list[dict] = []
    for index, creation_id in enumerate(("c_0123456789abcdef0123", "c_0123456789abcdef0124")):
        media = tmp_path / "creations" / f"{creation_id}.mp4"
        media.parent.mkdir(parents=True, exist_ok=True)
        media.write_bytes(f"video-{index}".encode())
        creation = {
            "creation_id": creation_id,
            "status": "succeeded",
            "output_type": "video",
            "media_type": "video",
            "media_path": f"creations/{creation_id}.mp4",
        }
        register_free_creation_artifact(tmp_path, creation)
        creations.append(creation)

    paths = resolve_merge_video_paths(
        tmp_path,
        [creations[1]["creation_id"], creations[0]["creation_id"]],
        creations,
    )
    assert paths == [
        tmp_path / "creations" / "c_0123456789abcdef0124.mp4",
        tmp_path / "creations" / "c_0123456789abcdef0123.mp4",
    ]

    with pytest.raises(ValueError, match="at least two"):
        resolve_merge_video_paths(tmp_path, [creations[0]["creation_id"]], creations)


def test_audio_composite_resolves_one_manifested_video_and_voice(tmp_path: Path) -> None:
    video_id = "c_0123456789abcdef0123"
    audio_id = "c_0123456789abcdef0124"
    video_path = tmp_path / "creations" / f"{video_id}.mp4"
    audio_path = tmp_path / "audio" / f"segment_{audio_id}.wav"
    video_path.parent.mkdir(parents=True)
    audio_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"video")
    audio_path.write_bytes(b"voice")
    video = {
        "creation_id": video_id,
        "status": "succeeded",
        "output_type": "video",
        "media_type": "video",
        "references": [],
        "media_path": video_path.relative_to(tmp_path).as_posix(),
    }
    audio = {
        "creation_id": audio_id,
        "status": "succeeded",
        "output_type": "audio",
        "media_type": "audio",
        "references": [],
        "media_path": audio_path.relative_to(tmp_path).as_posix(),
    }
    register_free_creation_artifact(tmp_path, video)
    register_free_creation_artifact(tmp_path, audio)

    resolved_video, resolved_video_path, resolved_audio, resolved_audio_path = resolve_audio_composite_paths(
        tmp_path,
        video_id,
        audio_id,
        [video, audio],
    )

    assert resolved_video is video
    assert resolved_video_path == video_path
    assert resolved_audio is audio
    assert resolved_audio_path == audio_path


@pytest.mark.asyncio
async def test_audio_composite_and_subtitle_render_create_derived_canvas_videos(
    tmp_path: Path,
    monkeypatch,
) -> None:
    video_id = "c_0123456789abcdef0123"
    audio_id = "c_0123456789abcdef0124"
    composite_id = "c_0123456789abcdef0125"
    subtitle_id = "c_0123456789abcdef0126"
    video_path = tmp_path / "creations" / f"{video_id}.mp4"
    audio_path = tmp_path / "audio" / f"segment_{audio_id}.wav"
    video_path.parent.mkdir(parents=True)
    audio_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"video")
    audio_path.write_bytes(b"voice")
    video = {
        "creation_id": video_id,
        "status": "succeeded",
        "output_type": "video",
        "media_type": "video",
        "prompt": "A rainy station",
        "version": 1,
        "references": [],
        "media_path": video_path.relative_to(tmp_path).as_posix(),
        "duration_seconds": 8,
    }
    audio = {
        "creation_id": audio_id,
        "status": "succeeded",
        "output_type": "audio",
        "media_type": "audio",
        "prompt": "Station announcement",
        "version": 1,
        "references": [],
        "media_path": audio_path.relative_to(tmp_path).as_posix(),
    }
    register_free_creation_artifact(tmp_path, video)
    register_free_creation_artifact(tmp_path, audio)
    track = create_subtitle_track(
        tmp_path,
        creation_id=video_id,
        text="The train arrives.",
        duration_seconds=8,
    )
    commands: list[tuple[object, ...]] = []

    class FakeProcess:
        returncode = 0

        async def communicate(self):
            return b"", b""

        def kill(self) -> None:
            return None

        async def wait(self) -> int:
            return 0

    async def fake_create_subprocess_exec(*args, **_kwargs):
        commands.append(args)
        Path(str(args[-1])).write_bytes(b"derived-video")
        return FakeProcess()

    async def fake_thumbnail(_video_path: Path, _cover_path: Path):
        return None

    monkeypatch.setattr(free_creation_merge_module.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(free_creation_merge_module.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(free_creation_merge_module, "extract_video_thumbnail", fake_thumbnail)

    composited = await composite_creation_audio(
        tmp_path,
        video_creation_id=video_id,
        audio_creation_id=audio_id,
        output_creation_id=composite_id,
        creations=[video, audio],
    )
    subtitled = await render_creation_subtitles(
        tmp_path,
        track=track,
        output_creation_id=subtitle_id,
        creations=[video, audio],
    )

    assert composited["effective_mode"] == "audio_composite"
    assert [claim["role"] for claim in composited["reference_claims"]] == [
        "reference_video",
        "reference_audio",
    ]
    assert subtitled["effective_mode"] == "subtitle_burn"
    assert subtitled["subtitle_id"] == track["subtitle_id"]
    assert load_creation_metadata(tmp_path, composite_id) == composited
    assert load_creation_metadata(tmp_path, subtitle_id) == subtitled
    assert ProjectArtifactManifestAdapter(tmp_path).get_entry(ArtifactKey.free_creation(composite_id)) is not None
    assert ProjectArtifactManifestAdapter(tmp_path).get_entry(ArtifactKey.free_creation(subtitle_id)) is not None
    assert any("subtitles=subtitles.vtt" in command for args in commands for command in map(str, args))
    project_tmp = tmp_path / "tmp"
    assert commands
    assert all(project_tmp in Path(str(args[-1])).parents for args in commands)
    assert not any(project_tmp.iterdir())
