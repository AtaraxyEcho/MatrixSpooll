"""Lazy preview artifacts for uploaded free-creation media."""

from __future__ import annotations

import asyncio
from pathlib import Path

from lib.path_safety import safe_join
from lib.thumbnail import extract_video_thumbnail
from server.services.free_creation_workspace import load_reference_upload

_cover_locks: dict[tuple[str, str], asyncio.Lock] = {}


async def ensure_reference_video_cover(project_path: Path, reference_id: str) -> Path | None:
    record = load_reference_upload(project_path, reference_id)
    if not record or record.get("media_type") != "video" or not isinstance(record.get("path"), str):
        return None
    source = safe_join(project_path, record["path"])
    if not source.is_file():
        return None
    cover = safe_join(project_path, "free_creation", "previews", f"{reference_id}.jpg")
    if cover.is_file() and cover.stat().st_mtime_ns >= source.stat().st_mtime_ns:
        return cover

    key = (str(project_path.resolve(strict=False)), reference_id)
    lock = _cover_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if cover.is_file() and cover.stat().st_mtime_ns >= source.stat().st_mtime_ns:
            return cover
        return await extract_video_thumbnail(source, cover)


__all__ = ["ensure_reference_video_cover"]
