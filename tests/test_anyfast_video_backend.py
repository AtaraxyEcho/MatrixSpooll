"""AnyFast Seedance request mapping tests."""

from __future__ import annotations

import struct
from pathlib import Path

import httpx
import pytest

from lib.video_backends.anyfast import (
    AnyFastSeedanceBackend,
    _provider_error_from_payload,
    build_seedance_request_body,
)
from lib.video_backends.base import VideoCapabilityError, VideoGenerationRequest, VideoProviderError

pytestmark = pytest.mark.unit


def _write_png(path: Path) -> None:
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
        b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00"
        b"\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00"
        b"\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def _write_wav(path: Path) -> None:
    pcm = b"\x00\x00" * 80
    path.write_bytes(
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16)
        + b"data"
        + struct.pack("<I", len(pcm))
        + pcm
    )


def _write_mp4(path: Path) -> None:
    # The request builder only needs a readable local payload; media decoding is
    # covered by the upload/ffprobe tests.
    path.write_bytes(b"mock-mp4")


def test_frame_request_maps_first_and_last_frame_roles(tmp_path: Path) -> None:
    first = tmp_path / "first.png"
    last = tmp_path / "last.png"
    _write_png(first)
    _write_png(last)
    request = VideoGenerationRequest(
        prompt="move from the first frame to the last",
        output_path=tmp_path / "out.mp4",
        start_image=first,
        end_image=last,
        aspect_ratio="16:9",
        resolution="1080p",
        duration_seconds=10,
    )

    body = build_seedance_request_body("seedance-2.0", request)

    assert [item.get("role") for item in body["content"]] == [None, "first_frame", "last_frame"]
    assert body["ratio"] == "16:9"
    assert body["resolution"] == "1080p"


def test_reference_request_orders_images_before_audio_and_keeps_roles(tmp_path: Path) -> None:
    image = tmp_path / "reference.png"
    audio = tmp_path / "voice.wav"
    _write_png(image)
    _write_wav(audio)
    request = VideoGenerationRequest(
        prompt="@image1 speaks with @audio1",
        output_path=tmp_path / "out.mp4",
        reference_images=[image],
        reference_audio_files=[audio],
    )

    body = build_seedance_request_body("seedance-2.0", request)

    assert [item["type"] for item in body["content"]] == ["text", "image_url", "audio_url"]
    assert [item.get("role") for item in body["content"]] == [None, "reference_image", "reference_audio"]


def test_reference_video_maps_to_anyfast_video_url_role(tmp_path: Path) -> None:
    reference = tmp_path / "reference.mp4"
    _write_mp4(reference)
    request = VideoGenerationRequest(
        prompt="use the clip",
        output_path=tmp_path / "out.mp4",
        reference_videos=[reference],
    )

    body = build_seedance_request_body("seedance-2.5", request)

    assert [item["type"] for item in body["content"]] == ["text", "video_url"]
    assert body["content"][1]["role"] == "reference_video"
    assert body["content"][1]["video_url"]["url"].startswith("data:video/mp4;base64,")


def test_reference_limits_cannot_be_bypassed_by_custom_capability_overrides(tmp_path: Path) -> None:
    image = tmp_path / "reference.png"
    audio = tmp_path / "voice.wav"
    _write_png(image)
    _write_wav(audio)

    with pytest.raises(VideoCapabilityError) as images_error:
        build_seedance_request_body(
            "seedance-2.0",
            VideoGenerationRequest(
                prompt="use all references",
                output_path=tmp_path / "images.mp4",
                reference_images=[image] * 10,
            ),
        )
    assert images_error.value.code == "video_reference_images_exceeded"

    with pytest.raises(VideoCapabilityError) as audio_error:
        build_seedance_request_body(
            "seedance-2.0",
            VideoGenerationRequest(
                prompt="use all voices",
                output_path=tmp_path / "audio.mp4",
                reference_audio_files=[audio] * 4,
            ),
        )
    assert audio_error.value.code == "video_reference_audio_exceeded"

    video = tmp_path / "reference.mp4"
    _write_mp4(video)
    with pytest.raises(VideoCapabilityError) as video_error:
        build_seedance_request_body(
            "seedance-2.0",
            VideoGenerationRequest(
                prompt="use all references",
                output_path=tmp_path / "videos.mp4",
                reference_videos=[video] * 4,
            ),
        )
    assert video_error.value.code == "video_reference_videos_exceeded"


def test_anyfast_capabilities_match_the_transport_that_is_actually_implemented() -> None:
    caps = AnyFastSeedanceBackend.video_capabilities_for_model("seedance-2.0")

    assert caps.text_to_video is True
    assert caps.first_frame is True
    assert caps.last_frame is True
    assert caps.max_reference_images == 9
    assert caps.max_reference_videos == 3
    assert caps.min_reference_video_seconds == 2
    assert caps.max_reference_video_seconds == 15
    assert caps.max_reference_audio_count == 3
    assert caps.supported_resolutions == ("480p", "720p", "1080p", "4k")
    assert caps.supported_durations == tuple(range(4, 16))
    assert AnyFastSeedanceBackend.video_capabilities_for_model("seedance-2.5").first_frame_ratio_adaptive_only is True


def test_seedance_25_reference_video_limits_are_declared() -> None:
    caps = AnyFastSeedanceBackend.video_capabilities_for_model("seedance-2.5")

    assert caps.max_reference_videos == 10
    assert caps.min_reference_video_seconds == 2
    assert caps.max_reference_video_seconds == 30
    assert caps.max_reference_video_total_seconds == 30


def test_seedance_20_ultra_reference_video_limits_are_declared() -> None:
    caps = AnyFastSeedanceBackend.video_capabilities_for_model("seedance-2.0-ultra")

    assert caps.max_reference_videos == 3
    assert caps.min_reference_video_seconds == 2
    assert caps.max_reference_video_seconds == 15
    assert caps.max_reference_video_total_seconds == 15


@pytest.mark.parametrize("model", ["seedance2.5", "seedance-2-5", "seedance_2_5"])
def test_seedance_25_model_aliases_keep_30_second_and_resolution_capabilities(model: str) -> None:
    caps = AnyFastSeedanceBackend.video_capabilities_for_model(model)

    assert caps.supported_resolutions == ("480p", "720p", "1080p")
    assert caps.supported_durations == tuple(range(4, 31))
    assert caps.first_frame_ratio_adaptive_only is True

    request = VideoGenerationRequest(
        prompt="a slow camera move",
        output_path=Path("out.mp4"),
        aspect_ratio="16:9",
        duration_seconds=30,
        resolution="1080p",
    )
    body = build_seedance_request_body(model, request)
    assert body["duration"] == 30
    assert body["resolution"] == "1080p"


@pytest.mark.parametrize(
    ("model", "resolutions", "max_duration"),
    [
        ("seedance-2.0-fast", ("480p", "720p"), 15),
        ("seedance-2.0-mini", ("480p", "720p"), 15),
        ("seedance-2.0-ultra", ("720p", "1080p", "2k"), 15),
        ("doubao-seedance-1-5-pro-251215", ("480p", "720p", "1080p"), 12),
        ("doubao-seedance-1-0-pro-250528", ("480p", "720p", "1080p"), 12),
    ],
)
def test_documented_model_profiles_expose_only_supported_resolution_and_duration_options(
    model: str, resolutions: tuple[str, ...], max_duration: int
) -> None:
    caps = AnyFastSeedanceBackend.video_capabilities_for_model(model)

    assert caps.supported_resolutions == resolutions
    assert caps.supported_durations == tuple(range(4, max_duration + 1))


def test_model_profiles_expose_only_supported_aspect_ratios() -> None:
    ultra = AnyFastSeedanceBackend.video_capabilities_for_model("seedance-2.0-ultra")
    assert ultra.supported_aspect_ratios == ("16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive")
    assert (
        "adaptive"
        not in AnyFastSeedanceBackend.video_capabilities_for_model(
            "doubao-seedance-1-0-pro-250528"
        ).supported_aspect_ratios
    )


def test_ultra_requires_a_resolution_before_submission() -> None:
    request = VideoGenerationRequest(
        prompt="a slow camera move",
        output_path=Path("out.mp4"),
        aspect_ratio="16:9",
        duration_seconds=5,
    )

    with pytest.raises(VideoCapabilityError) as exc_info:
        build_seedance_request_body("seedance-2.0-ultra", request)

    assert exc_info.value.code == "video_resolution_required"


@pytest.mark.asyncio
async def test_create_failure_unwraps_nested_image_moderation_and_locates_first_frame() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            400,
            request=request,
            json={
                "code": "fail_to_fetch_task",
                "message": (
                    '{"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation",'
                    '"message":"The input image \'content[1]\' may contain real person.",'
                    '"param":"","type":"BadRequest"}}'
                ),
                "data": None,
            },
        )

    backend = AnyFastSeedanceBackend(
        api_key="test-key",
        base_url="https://anyfast.invalid",
        model="seedance-2.0",
        transport=httpx.MockTransport(handler),
    )
    body = {
        "content": [
            {"type": "text", "text": "a slow camera move"},
            {"type": "image_url", "role": "first_frame", "image_url": {"url": "data:image/png;base64,AA=="}},
            {"type": "image_url", "role": "last_frame", "image_url": {"url": "data:image/png;base64,AA=="}},
        ]
    }

    async with backend._client() as client:
        with pytest.raises(VideoProviderError) as exc_info:
            await backend._create_task(client, backend._root, body)

    assert calls == 1
    assert exc_info.value.code == "video_first_frame_content_rejected"
    assert exc_info.value.params == {}


@pytest.mark.parametrize(
    ("content", "pointer", "expected_code", "expected_params"),
    [
        (
            [{"type": "text"}, {"role": "first_frame"}, {"role": "last_frame"}],
            "content[2]",
            "video_last_frame_content_rejected",
            {},
        ),
        (
            [{"type": "text"}, {"role": "reference_image"}, {"role": "reference_image"}],
            "content[2]",
            "video_reference_image_content_rejected",
            {"number": 2},
        ),
        (
            [{"type": "text"}],
            "content[9]",
            "video_input_image_content_rejected",
            {},
        ),
    ],
)
def test_image_moderation_pointer_is_resolved_against_submitted_content_roles(
    content: list[dict[str, str]],
    pointer: str,
    expected_code: str,
    expected_params: dict[str, int],
) -> None:
    error = _provider_error_from_payload(
        {
            "error": {
                "code": "InputImageSensitiveContentDetected",
                "message": f"The input image '{pointer}' did not pass review.",
            }
        },
        content,
    )

    assert error is not None
    assert error.code == expected_code
    assert error.params == expected_params


@pytest.mark.asyncio
async def test_poll_failure_keeps_documented_output_moderation_reason(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            json={
                "code": "success",
                "data": {
                    "status": "FAILURE",
                    "fail_reason": (
                        '{"error":{"code":"OutputVideoSensitiveContentDetected",'
                        '"message":"The generated video did not pass content review."}}'
                    ),
                },
            },
        )

    backend = AnyFastSeedanceBackend(
        api_key="test-key",
        base_url="https://anyfast.invalid",
        model="seedance-2.0",
        transport=httpx.MockTransport(handler),
        poll_interval_seconds=0,
    )
    request = VideoGenerationRequest(
        prompt="a slow camera move",
        output_path=tmp_path / "out.mp4",
        aspect_ratio="16:9",
        duration_seconds=4,
        resolution="720p",
    )

    async with backend._client() as client:
        with pytest.raises(VideoProviderError) as exc_info:
            await backend._poll_and_build(client, "task-1", request, is_resume=False)

    assert exc_info.value.code == "video_output_content_rejected"
