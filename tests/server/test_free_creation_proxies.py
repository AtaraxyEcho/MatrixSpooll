from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

import lib.ffmpeg_runner as ffmpeg_runner
from server.services import free_creation_proxies


@pytest.mark.unit
async def test_video_proxy_transcoding_does_not_require_asyncio_subprocess_transport(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project_path = tmp_path / "project"
    source = project_path / "uploads" / "source.mov"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source-video")

    async def unsupported_async_subprocess(*_args: object, **_kwargs: object) -> None:
        raise NotImplementedError

    class FakeProcess:
        returncode = 0

        def __init__(self, command: list[str], **_kwargs: object) -> None:
            Path(command[-1]).write_bytes(b"proxy-video")

        def communicate(self) -> tuple[bytes, bytes]:
            return b"", b""

        def kill(self) -> None:
            return None

    monkeypatch.setattr(free_creation_proxies.shutil, "which", lambda _name: "ffmpeg")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", unsupported_async_subprocess)
    monkeypatch.setattr(ffmpeg_runner.subprocess, "Popen", FakeProcess)

    result = await free_creation_proxies.ensure_video_proxy(project_path, "reference", "r_test", source)

    assert result is not None
    assert result.read_bytes() == b"proxy-video"
