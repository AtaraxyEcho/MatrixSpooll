"""FFmpeg integration coverage for mixed uploaded-video merging."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from server.services.free_creation_merge import merge_video_creations

pytestmark = pytest.mark.integration


def _create_video(ffmpeg: str, path: Path, *, size: str, frame_rate: int, with_audio: bool) -> None:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c=blue:s={size}:r={frame_rate}:d=0.5",
    ]
    if with_audio:
        command.extend(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.5", "-shortest"])
    command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
    if with_audio:
        command.extend(["-c:a", "aac"])
    command.extend(["-y", str(path)])
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


async def test_merge_normalizes_different_video_specs_and_missing_audio(tmp_path: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("FFmpeg and FFprobe are required")

    uploads_path = tmp_path / "uploads" / "free_creation"
    uploads_path.mkdir(parents=True)
    first_id = "r_0123456789abcdef0123"
    second_id = "r_0123456789abcdef0124"
    first_path = uploads_path / f"{first_id}.mp4"
    second_path = uploads_path / f"{second_id}.mp4"
    _create_video(ffmpeg, first_path, size="320x240", frame_rate=24, with_audio=True)
    _create_video(ffmpeg, second_path, size="640x360", frame_rate=30, with_audio=False)
    uploads = [
        {"reference_id": first_id, "media_type": "video", "path": first_path.relative_to(tmp_path).as_posix()},
        {"reference_id": second_id, "media_type": "video", "path": second_path.relative_to(tmp_path).as_posix()},
    ]

    output, temporary_directory = await merge_video_creations(
        tmp_path,
        [first_id, second_id],
        [],
        uploads,
    )
    try:
        probe = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,width,height:format=duration",
                "-of",
                "json",
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        payload = json.loads(probe.stdout)
        video = next(stream for stream in payload["streams"] if stream["codec_type"] == "video")
        assert (video["width"], video["height"]) == (320, 240)
        assert any(stream["codec_type"] == "audio" for stream in payload["streams"])
        assert float(payload["format"]["duration"]) >= 0.9
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)
