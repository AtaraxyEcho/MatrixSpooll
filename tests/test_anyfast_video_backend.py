"""AnyFast Seedance request mapping tests."""

from __future__ import annotations

import struct
from pathlib import Path

import pytest

from lib.video_backends.anyfast import AnyFastSeedanceBackend, build_seedance_request_body
from lib.video_backends.base import VideoCapabilityError, VideoGenerationRequest

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


def test_reference_video_fails_loud_instead_of_being_silently_dropped(tmp_path: Path) -> None:
    request = VideoGenerationRequest(
        prompt="use the clip",
        output_path=tmp_path / "out.mp4",
        reference_videos=[tmp_path / "reference.mp4"],
    )

    with pytest.raises(VideoCapabilityError) as exc_info:
        build_seedance_request_body("seedance-2.0", request)

    assert exc_info.value.code == "video_reference_videos_unsupported"


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


def test_anyfast_capabilities_match_the_transport_that_is_actually_implemented() -> None:
    caps = AnyFastSeedanceBackend.video_capabilities_for_model("seedance-2.0")

    assert caps.text_to_video is True
    assert caps.first_frame is True
    assert caps.last_frame is True
    assert caps.max_reference_images == 9
    assert caps.max_reference_videos == 0
    assert caps.max_reference_audio_count == 3
    assert AnyFastSeedanceBackend.video_capabilities_for_model("seedance-2.5").first_frame_ratio_adaptive_only is True
