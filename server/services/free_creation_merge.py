"""FFmpeg-backed export helpers for selected free-creation video clips."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Any

from lib.artifact_manifest import ArtifactKey, ProjectArtifactManifestAdapter
from lib.path_safety import safe_join

_FFMPEG_TIMEOUT_SECONDS = 30 * 60


def resolve_merge_video_paths(
    project_path: Path,
    creation_ids: list[str],
    creations: list[dict[str, Any]],
) -> list[Path]:
    """Resolve an ordered, manifest-backed list of succeeded video files."""

    if len(creation_ids) < 2:
        raise ValueError("at least two video creations are required")
    if len(set(creation_ids)) != len(creation_ids):
        raise ValueError("creation ids must be unique")

    creations_by_id = {str(item["creation_id"]): item for item in creations if isinstance(item.get("creation_id"), str)}
    manifest = ProjectArtifactManifestAdapter(project_path)
    paths: list[Path] = []
    for creation_id in creation_ids:
        creation = creations_by_id.get(creation_id)
        if not isinstance(creation, dict):
            raise FileNotFoundError(creation_id)
        if creation.get("status") != "succeeded":
            raise ValueError("all selected creations must be succeeded")
        if creation.get("media_type") != "video" and creation.get("output_type") != "video":
            raise ValueError("only video creations can be merged")
        media_path = creation.get("media_path")
        if not isinstance(media_path, str):
            raise FileNotFoundError(creation_id)
        entry = manifest.get_entry(ArtifactKey.free_creation(creation_id))
        path = safe_join(project_path, media_path)
        if entry is None or entry.artifact_path != media_path or not path.is_file():
            raise FileNotFoundError(creation_id)
        paths.append(path)
    return paths


def _concat_file_path(path: Path) -> str:
    # FFmpeg concat files use single-quoted paths; normalize Windows separators
    # so the same manifest works on Windows and POSIX workers.
    value = path.resolve().as_posix()
    return value.replace("\\", "\\\\").replace("'", "'\\''")


async def merge_video_creations(
    project_path: Path,
    creation_ids: list[str],
    creations: list[dict[str, Any]],
) -> tuple[Path, Path]:
    """Merge selected clips and return ``(output_path, temporary_directory)``.

    The caller owns the temporary directory and should remove it after the
    response has finished streaming the output file.
    """

    paths = resolve_merge_video_paths(project_path, creation_ids, creations)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not available")

    temporary_directory = Path(tempfile.mkdtemp(prefix="arcreel-free-merge-"))
    concat_file = temporary_directory / "inputs.txt"
    output_file = temporary_directory / "merged.mp4"
    concat_file.write_text("".join(f"file '{_concat_file_path(path)}'\n" for path in paths), encoding="utf-8")
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-y",
            str(output_file),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=_FFMPEG_TIMEOUT_SECONDS)
    except TimeoutError as exc:
        if process is not None:
            process.kill()
            await process.wait()
        shutil.rmtree(temporary_directory, ignore_errors=True)
        raise RuntimeError("ffmpeg merge timed out") from exc
    except OSError as exc:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        raise RuntimeError("ffmpeg merge could not start") from exc

    if process.returncode != 0:
        detail = (stderr or b"").decode("utf-8", errors="replace").strip()
        shutil.rmtree(temporary_directory, ignore_errors=True)
        raise RuntimeError(f"ffmpeg merge failed: {detail[:500]}")
    if not output_file.is_file() or output_file.stat().st_size <= 0:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        raise RuntimeError("ffmpeg merge produced no output")
    return output_file, temporary_directory


__all__ = ["merge_video_creations", "resolve_merge_video_paths"]
