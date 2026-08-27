"""Thumbnail extraction graceful-skip when ffmpeg is unavailable."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest

import lib.ffmpeg_runner as ffmpeg_runner
import lib.thumbnail as thumbnail_module

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _reset_ffmpeg_cache():
    thumbnail_module._reset_for_tests()
    yield
    thumbnail_module._reset_for_tests()


@pytest.mark.asyncio
async def test_returns_none_when_ffmpeg_missing(tmp_path: Path):
    """ffmpeg 不在 PATH 中时不应 spawn 子进程，直接返回 None。"""
    video = tmp_path / "fake.mp4"
    video.write_bytes(b"\x00")  # nominal file; we never actually decode
    out = tmp_path / "out.jpg"

    with patch("lib.thumbnail.shutil.which", return_value=None):
        with patch("lib.thumbnail.run_media_process") as spawn:
            result = await thumbnail_module.extract_video_thumbnail(video, out)

    assert result is None
    assert not out.exists()
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_returns_none_when_video_missing(tmp_path: Path):
    """video 文件不存在时直接返回 None，不检查 ffmpeg。"""
    nonexistent = tmp_path / "no-such-video.mp4"
    out = tmp_path / "out.jpg"

    with patch("lib.thumbnail.shutil.which") as which:
        result = await thumbnail_module.extract_video_thumbnail(nonexistent, out)

    assert result is None
    which.assert_not_called()


@pytest.mark.asyncio
async def test_thumbnail_extraction_does_not_require_asyncio_subprocess_transport(tmp_path: Path):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"source-video")
    out = tmp_path / "cover.jpg"

    async def unsupported_async_subprocess(*_args: object, **_kwargs: object) -> None:
        raise NotImplementedError

    class FakeProcess:
        returncode = 0

        def __init__(self, command: list[str], **_kwargs: object) -> None:
            Path(command[-1]).write_bytes(b"thumbnail")

        def communicate(self) -> tuple[bytes, bytes]:
            return b"", b""

        def kill(self) -> None:
            return None

    with patch("lib.thumbnail.shutil.which", return_value="ffmpeg"):
        with patch("asyncio.create_subprocess_exec", side_effect=unsupported_async_subprocess):
            with patch.object(ffmpeg_runner.subprocess, "Popen", FakeProcess):
                result = await thumbnail_module.extract_video_thumbnail(video, out)

    assert result == out
    assert out.read_bytes() == b"thumbnail"


@pytest.mark.asyncio
async def test_last_frame_extraction_does_not_require_asyncio_subprocess_transport(tmp_path: Path):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"source-video")
    out = tmp_path / "last-frame.png"

    async def unsupported_async_subprocess(*_args: object, **_kwargs: object) -> None:
        raise NotImplementedError

    class FakeProcess:
        returncode = 0

        def __init__(self, command: list[str], **_kwargs: object) -> None:
            self.command = command
            if command[0] == "ffmpeg":
                Path(command[-1]).write_bytes(b"last-frame")

        def communicate(self) -> tuple[bytes, bytes]:
            if self.command[0] == "ffprobe":
                return b"30\n", b""
            return b"", b""

        def kill(self) -> None:
            return None

    with patch("lib.thumbnail.shutil.which", side_effect=lambda name: name):
        with patch.object(asyncio, "create_subprocess_exec", side_effect=unsupported_async_subprocess):
            with patch.object(ffmpeg_runner.subprocess, "Popen", FakeProcess):
                result = await thumbnail_module.extract_video_last_frame(video, out)

    assert result == out
    assert out.read_bytes() == b"last-frame"


@pytest.mark.asyncio
async def test_ffmpeg_available_attempts_extraction(tmp_path: Path):
    """ffmpeg 在 PATH 时走原有 spawn 路径（spawn 被调用，returncode 非零仍返回 None）。"""
    video = tmp_path / "fake.mp4"
    video.write_bytes(b"\x00")
    out = tmp_path / "out.jpg"

    with patch("lib.thumbnail.shutil.which", return_value="/usr/bin/ffmpeg"):
        with patch(
            "lib.thumbnail.run_media_process",
            side_effect=ffmpeg_runner.MediaProcessError("media_process_failed"),
        ) as spawn:
            result = await thumbnail_module.extract_video_thumbnail(video, out)

    assert result is None
    spawn.assert_called_once()


def test_ffmpeg_available_is_cached():
    """_ffmpeg_available() 用 @functools.cache，多次调用 shutil.which 只一次。"""
    thumbnail_module._reset_for_tests()
    with patch("lib.thumbnail.shutil.which", return_value=None) as which:
        thumbnail_module._ffmpeg_available()
        thumbnail_module._ffmpeg_available()
        thumbnail_module._ffmpeg_available()
    assert which.call_count == 1


@pytest.mark.asyncio
async def test_last_frame_returns_none_when_ffmpeg_missing(tmp_path: Path):
    """ffmpeg 缺失时 extract_video_last_frame 直接返回 None，不 spawn 子进程。"""
    video = tmp_path / "fake.mp4"
    video.write_bytes(b"\x00")
    out = tmp_path / "out.png"

    with patch("lib.thumbnail.shutil.which", return_value=None):
        with patch("lib.thumbnail.run_media_process") as spawn:
            result = await thumbnail_module.extract_video_last_frame(video, out)

    assert result is None
    assert not out.exists()
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_last_frame_returns_none_when_only_ffprobe_missing(tmp_path: Path):
    """ffmpeg 在 PATH 但 ffprobe 缺失（精简容器场景）时也应短路。"""
    video = tmp_path / "fake.mp4"
    video.write_bytes(b"\x00")
    out = tmp_path / "out.png"

    def _which(name: str):
        return "/usr/bin/ffmpeg" if name == "ffmpeg" else None

    with patch("lib.thumbnail.shutil.which", side_effect=_which):
        with patch("lib.thumbnail.run_media_process") as spawn:
            result = await thumbnail_module.extract_video_last_frame(video, out)

    assert result is None
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_last_frame_returns_none_when_video_missing(tmp_path: Path):
    """video 不存在时直接返回 None，不检查 ffmpeg/ffprobe。"""
    nonexistent = tmp_path / "no-such-video.mp4"
    out = tmp_path / "out.png"

    with patch("lib.thumbnail.shutil.which") as which:
        result = await thumbnail_module.extract_video_last_frame(nonexistent, out)

    assert result is None
    which.assert_not_called()


@pytest.mark.asyncio
async def test_last_frame_falls_back_to_count_frames(tmp_path: Path):
    """容器 nb_frames 为 N/A 时回退到 -count_frames 路径。"""
    video = tmp_path / "fake.mp4"
    video.write_bytes(b"\x00")
    out = tmp_path / "out.png"

    call_log: list[list[str]] = []
    probe_payloads = [b"N/A\n", b"30\n"]

    async def _run(command: list[str], **_kwargs: object) -> tuple[bytes, bytes]:
        call_log.append(command)
        if command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"\x89PNG\r\n\x1a\n")
            return b"", b""
        return probe_payloads.pop(0), b""

    def _which(name: str):
        return f"/usr/bin/{name}"

    with patch("lib.thumbnail.shutil.which", side_effect=_which):
        with patch("lib.thumbnail.run_media_process", side_effect=_run):
            result = await thumbnail_module.extract_video_last_frame(video, out)

    assert result == out
    assert len(call_log) == 3
    assert call_log[0][0] == "ffprobe" and "-count_frames" not in call_log[0]
    assert call_log[1][0] == "ffprobe" and "-count_frames" in call_log[1]
    assert call_log[2][0] == "ffmpeg"


@pytest.mark.asyncio
async def test_last_frame_retries_precise_count_when_fast_extract_writes_nothing(
    tmp_path: Path,
):
    """nb_frames 有值但 select 无输出时，用 -count_frames 结果重试并替换旧文件。"""
    video = tmp_path / "fake.mp4"
    video.write_bytes(b"\x00")
    out = tmp_path / "out.png"
    out.write_bytes(b"stale")

    probe_payloads = [b"999\n", b"30\n"]
    ffmpeg_writes = [False, True]
    call_log: list[list[str]] = []

    async def _run(command: list[str], **_kwargs: object) -> tuple[bytes, bytes]:
        call_log.append(command)
        if command[0] == "ffprobe":
            return probe_payloads.pop(0), b""
        if ffmpeg_writes.pop(0):
            Path(command[-1]).write_bytes(b"fresh")
        return b"", b""

    def _which(name: str):
        return f"/usr/bin/{name}"

    with patch("lib.thumbnail.shutil.which", side_effect=_which):
        with patch("lib.thumbnail.run_media_process", side_effect=_run):
            result = await thumbnail_module.extract_video_last_frame(video, out)

    assert result == out
    assert out.read_bytes() == b"fresh"
    assert len(call_log) == 4
    assert call_log[0][0] == "ffprobe" and "-count_frames" not in call_log[0]
    assert call_log[1][0] == "ffmpeg"
    assert call_log[2][0] == "ffprobe" and "-count_frames" in call_log[2]
    assert call_log[3][0] == "ffmpeg"


def test_ffprobe_available_is_cached():
    """_ffprobe_available() 同样走 @functools.cache。"""
    thumbnail_module._reset_for_tests()
    with patch("lib.thumbnail.shutil.which", return_value=None) as which:
        thumbnail_module._ffprobe_available()
        thumbnail_module._ffprobe_available()
        thumbnail_module._ffprobe_available()
    assert which.call_count == 1
