"""Bounded, lazy video proxies used by dense canvas cards."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from uuid import uuid4

from lib.path_safety import safe_join

_TRANSCODE_SLOTS = asyncio.Semaphore(2)
_proxy_locks: dict[str, asyncio.Lock] = {}


def _cache_limit_bytes() -> int:
    try:
        configured = int(os.getenv("MATRIXSPOOLL_PREVIEW_CACHE_MB", "4096"))
    except ValueError:
        configured = 4096
    return min(65_536, max(256, configured)) * 1024 * 1024


def _proxy_root(project_path: Path) -> Path:
    return safe_join(project_path, "free_creation", "proxies")


def _proxy_path(project_path: Path, namespace: str, media_id: str, source: Path) -> Path:
    stat = source.stat()
    return safe_join(
        _proxy_root(project_path),
        f"{namespace}_{media_id}_{stat.st_mtime_ns:x}_{stat.st_size:x}.mp4",
    )


def _access_path(proxy: Path) -> Path:
    return proxy.with_suffix(".access")


def touch_video_proxy(proxy: Path) -> None:
    access = _access_path(proxy)
    access.parent.mkdir(parents=True, exist_ok=True)
    access.touch(exist_ok=True)
    os.utime(access, None)


def find_video_proxy(project_path: Path, namespace: str, media_id: str, source: Path) -> Path | None:
    if not source.is_file():
        return None
    proxy = _proxy_path(project_path, namespace, media_id, source)
    if not proxy.is_file():
        return None
    touch_video_proxy(proxy)
    return proxy


def _prune_proxy_cache(project_path: Path, *, keep: Path) -> None:
    root = _proxy_root(project_path)
    files = [path for path in root.glob("*.mp4") if path.is_file() and ".tmp." not in path.name]
    total = sum(path.stat().st_size for path in files)
    if total <= _cache_limit_bytes():
        return
    files.sort(
        key=lambda path: (
            _access_path(path).stat().st_mtime_ns if _access_path(path).is_file() else path.stat().st_mtime_ns
        )
    )
    for path in files:
        if total <= _cache_limit_bytes():
            break
        if path == keep:
            continue
        size = path.stat().st_size
        path.unlink(missing_ok=True)
        _access_path(path).unlink(missing_ok=True)
        total -= size


async def ensure_video_proxy(project_path: Path, namespace: str, media_id: str, source: Path) -> Path | None:
    if not source.is_file() or shutil.which("ffmpeg") is None:
        return None
    destination = _proxy_path(project_path, namespace, media_id, source)
    if destination.is_file():
        touch_video_proxy(destination)
        return destination
    lock_key = str(destination.resolve(strict=False))
    lock = _proxy_locks.setdefault(lock_key, asyncio.Lock())
    async with lock, _TRANSCODE_SLOTS:
        if destination.is_file():
            touch_video_proxy(destination)
            return destination
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.stem}.{uuid4().hex}.tmp.mp4")
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-i",
                str(source),
                "-vf",
                "scale=-2:480:force_original_aspect_ratio=decrease",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "28",
                "-an",
                "-movflags",
                "+faststart",
                "-y",
                str(temporary),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await process.wait()
            if process.returncode != 0 or not temporary.is_file():
                return None
            temporary.replace(destination)
            touch_video_proxy(destination)
            prefix = f"{namespace}_{media_id}_"
            for obsolete in destination.parent.glob(f"{prefix}*.mp4"):
                if obsolete != destination and ".tmp." not in obsolete.name:
                    obsolete.unlink(missing_ok=True)
                    _access_path(obsolete).unlink(missing_ok=True)
            await asyncio.to_thread(_prune_proxy_cache, project_path, keep=destination)
            return destination
        finally:
            temporary.unlink(missing_ok=True)


__all__ = ["ensure_video_proxy", "find_video_proxy", "touch_video_proxy"]
