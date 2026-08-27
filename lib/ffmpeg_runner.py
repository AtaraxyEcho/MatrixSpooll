"""Cross-platform subprocess execution for local FFmpeg tools."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MediaProcessError(RuntimeError):
    """A bounded, user-safe error from FFmpeg or FFprobe."""

    code: str
    detail: str = ""

    def __str__(self) -> str:
        return self.detail or self.code


def find_media_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise MediaProcessError("media_tool_missing", f"{name} is not available")
    return path


async def run_media_process(
    command: Sequence[str],
    *,
    timeout: float,
    cwd: Path | None = None,
    stderr_limit: int = 2000,
) -> tuple[bytes, bytes]:
    """Run a local media process without relying on the event loop subprocess transport."""
    try:
        process = subprocess.Popen(
            list(command),
            cwd=str(cwd) if cwd is not None else None,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=os.name != "nt",
        )
    except OSError as exc:
        raise MediaProcessError("media_process_start_failed", str(exc)) from exc

    try:
        stdout, stderr = await asyncio.wait_for(
            asyncio.to_thread(process.communicate),
            timeout=timeout,
        )
    except asyncio.CancelledError:
        process.kill()
        await asyncio.to_thread(process.communicate)
        raise
    except TimeoutError as exc:
        process.kill()
        await asyncio.to_thread(process.communicate)
        raise MediaProcessError("media_process_timeout") from exc

    bounded_stderr = (stderr or b"")[-stderr_limit:]
    if process.returncode != 0:
        detail = bounded_stderr.decode("utf-8", errors="replace").strip()
        raise MediaProcessError("media_process_failed", detail)
    return stdout or b"", bounded_stderr


async def run_ffprobe_json(args: Sequence[str], *, timeout: float = 30.0) -> dict[str, object]:
    ffprobe = find_media_tool("ffprobe")
    stdout, _ = await run_media_process(
        [ffprobe, *args],
        timeout=timeout,
    )
    try:
        payload = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MediaProcessError("media_probe_invalid_output") from exc
    if not isinstance(payload, dict):
        raise MediaProcessError("media_probe_invalid_output")
    return payload


async def run_ffmpeg(
    args: Sequence[str],
    *,
    timeout: float = 30 * 60,
    cwd: Path | None = None,
) -> None:
    ffmpeg = find_media_tool("ffmpeg")
    await run_media_process([ffmpeg, *args], timeout=timeout, cwd=cwd)


__all__ = ["MediaProcessError", "find_media_tool", "run_ffmpeg", "run_ffprobe_json", "run_media_process"]
