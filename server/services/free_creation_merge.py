"""FFmpeg-backed post-production helpers for free-creation artifacts."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from lib.artifact_manifest import ArtifactKey, ProjectArtifactManifestAdapter
from lib.path_safety import safe_join
from lib.thumbnail import extract_video_thumbnail
from lib.version_manager import VersionManager
from server.services.free_creation_tasks import commit_free_creation_state, creation_media_path
from server.services.free_creation_workspace import subtitle_track_webvtt

_FFMPEG_TIMEOUT_SECONDS = 30 * 60


def _now() -> str:
    return datetime.now(UTC).isoformat()


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


def resolve_audio_composite_paths(
    project_path: Path,
    video_creation_id: str,
    audio_creation_id: str,
    creations: list[dict[str, Any]],
) -> tuple[dict[str, Any], Path, dict[str, Any], Path]:
    creations_by_id = {str(item["creation_id"]): item for item in creations if isinstance(item.get("creation_id"), str)}
    video = creations_by_id.get(video_creation_id)
    audio = creations_by_id.get(audio_creation_id)
    if not isinstance(video, dict) or not isinstance(audio, dict):
        raise FileNotFoundError(video_creation_id if not isinstance(video, dict) else audio_creation_id)
    if video.get("status") != "succeeded" or (
        video.get("media_type") != "video" and video.get("output_type") != "video"
    ):
        raise ValueError("a succeeded video creation is required")
    if audio.get("status") != "succeeded" or (
        audio.get("media_type") != "audio" and audio.get("output_type") != "audio"
    ):
        raise ValueError("a succeeded audio creation is required")
    manifest = ProjectArtifactManifestAdapter(project_path)

    def _path_for(creation: dict[str, Any]) -> Path:
        creation_id = str(creation["creation_id"])
        media_path = creation.get("media_path")
        if not isinstance(media_path, str):
            raise FileNotFoundError(creation_id)
        entry = manifest.get_entry(ArtifactKey.free_creation(creation_id))
        path = safe_join(project_path, media_path)
        if entry is None or entry.artifact_path != media_path or not path.is_file():
            raise FileNotFoundError(creation_id)
        return path

    return video, _path_for(video), audio, _path_for(audio)


async def composite_creation_audio(
    project_path: Path,
    *,
    video_creation_id: str,
    audio_creation_id: str,
    output_creation_id: str,
    creations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Replace a video's soundtrack with a voice creation and persist a derived video."""

    video, video_path, audio, audio_path = resolve_audio_composite_paths(
        project_path,
        video_creation_id,
        audio_creation_id,
        creations,
    )
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not available")

    temporary_directory = Path(tempfile.mkdtemp(prefix="arcreel-free-audio-composite-"))
    staged_file = temporary_directory / "composite.mp4"
    cover_path = project_path / "free_creation" / "covers" / f"{output_creation_id}.jpg"
    process: asyncio.subprocess.Process | None = None
    committed = False
    try:
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-i",
            str(audio_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-af",
            "apad",
            "-shortest",
            "-movflags",
            "+faststart",
            "-y",
            str(staged_file),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=_FFMPEG_TIMEOUT_SECONDS)
        if process.returncode != 0:
            detail = (stderr or b"").decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"ffmpeg audio composite failed: {detail[:500]}")
        if not staged_file.is_file() or staged_file.stat().st_size <= 0:
            raise RuntimeError("ffmpeg audio composite produced no output")

        extracted_cover = await extract_video_thumbnail(staged_file, cover_path)
        output_path = creation_media_path(project_path, output_creation_id, "video")
        video_version = video.get("version") if isinstance(video.get("version"), int) else None
        audio_version = audio.get("version") if isinstance(audio.get("version"), int) else None
        metadata = {
            "creation_id": output_creation_id,
            "status": "succeeded",
            "output_type": "video",
            "media_type": "video",
            "prompt": str(video.get("prompt") or ""),
            "prompt_mode": "original",
            "model": "local/ffmpeg",
            "references": [
                video_path.relative_to(project_path).as_posix(),
                audio_path.relative_to(project_path).as_posix(),
            ],
            "reference_claims": [
                {
                    "type": "creation",
                    "creation_id": video_creation_id,
                    "version": video_version,
                    "role": "reference_video",
                },
                {
                    "type": "creation",
                    "creation_id": audio_creation_id,
                    "version": audio_version,
                    "role": "reference_audio",
                },
            ],
            "effective_mode": "audio_composite",
            "aspect_ratio": video.get("aspect_ratio"),
            "resolution": video.get("resolution"),
            "duration_seconds": video.get("duration_seconds"),
            "quantity": 1,
            "parent_creation_id": video_creation_id,
            "media_path": output_path.relative_to(project_path).as_posix(),
            "cover_path": extracted_cover.relative_to(project_path).as_posix() if extracted_cover else None,
            "version": 1,
            "updated_at": _now(),
        }
        VersionManager(project_path).commit_staged_version(
            "free_videos",
            output_creation_id,
            str(metadata["prompt"]),
            staged_file=staged_file,
            current_file=output_path,
            on_commit=lambda: commit_free_creation_state(project_path, metadata),
            source="free_creation_audio_composite",
            parent_creation_id=video_creation_id,
            audio_creation_id=audio_creation_id,
        )
        committed = True
        return metadata
    except TimeoutError as exc:
        if process is not None:
            process.kill()
            await process.wait()
        raise RuntimeError("ffmpeg audio composite timed out") from exc
    except OSError as exc:
        raise RuntimeError("ffmpeg audio composite could not start") from exc
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        if not committed:
            cover_path.unlink(missing_ok=True)


async def render_creation_subtitles(
    project_path: Path,
    *,
    track: dict[str, Any],
    output_creation_id: str,
    creations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Burn a subtitle track into its source video and persist a derived video."""

    source_creation_id = track.get("creation_id")
    subtitle_id = track.get("subtitle_id")
    if not isinstance(source_creation_id, str) or not isinstance(subtitle_id, str):
        raise ValueError("subtitle track has no source video")
    creations_by_id = {str(item["creation_id"]): item for item in creations if isinstance(item.get("creation_id"), str)}
    source = creations_by_id.get(source_creation_id)
    if not isinstance(source, dict):
        raise FileNotFoundError(source_creation_id)
    if source.get("status") != "succeeded" or (
        source.get("media_type") != "video" and source.get("output_type") != "video"
    ):
        raise ValueError("a succeeded video creation is required")
    media_path = source.get("media_path")
    if not isinstance(media_path, str):
        raise FileNotFoundError(source_creation_id)
    source_path = safe_join(project_path, media_path)
    manifest_entry = ProjectArtifactManifestAdapter(project_path).get_entry(
        ArtifactKey.free_creation(source_creation_id)
    )
    if manifest_entry is None or manifest_entry.artifact_path != media_path or not source_path.is_file():
        raise FileNotFoundError(source_creation_id)

    webvtt = subtitle_track_webvtt(track)
    if "-->" not in webvtt:
        raise ValueError("subtitle track has no valid cues")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not available")

    temporary_directory = Path(tempfile.mkdtemp(prefix="arcreel-free-subtitles-"))
    subtitle_file = temporary_directory / "subtitles.vtt"
    subtitle_file.write_text(webvtt, encoding="utf-8")
    staged_file = temporary_directory / "subtitled.mp4"
    cover_path = project_path / "free_creation" / "covers" / f"{output_creation_id}.jpg"
    process: asyncio.subprocess.Process | None = None
    committed = False
    try:
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source_path),
            "-vf",
            "subtitles=subtitles.vtt",
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
            str(staged_file),
            cwd=str(temporary_directory),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=_FFMPEG_TIMEOUT_SECONDS)
        if process.returncode != 0:
            detail = (stderr or b"").decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"ffmpeg subtitle render failed: {detail[:500]}")
        if not staged_file.is_file() or staged_file.stat().st_size <= 0:
            raise RuntimeError("ffmpeg subtitle render produced no output")

        extracted_cover = await extract_video_thumbnail(staged_file, cover_path)
        output_path = creation_media_path(project_path, output_creation_id, "video")
        source_version = source.get("version") if isinstance(source.get("version"), int) else None
        metadata = {
            "creation_id": output_creation_id,
            "status": "succeeded",
            "output_type": "video",
            "media_type": "video",
            "prompt": str(source.get("prompt") or ""),
            "prompt_mode": "original",
            "model": "local/ffmpeg",
            "references": [source_path.relative_to(project_path).as_posix()],
            "reference_claims": [
                {
                    "type": "creation",
                    "creation_id": source_creation_id,
                    "version": source_version,
                    "role": "reference_video",
                }
            ],
            "effective_mode": "subtitle_burn",
            "aspect_ratio": source.get("aspect_ratio"),
            "resolution": source.get("resolution"),
            "duration_seconds": source.get("duration_seconds"),
            "quantity": 1,
            "parent_creation_id": source_creation_id,
            "subtitle_id": subtitle_id,
            "subtitle_revision": track.get("revision"),
            "media_path": output_path.relative_to(project_path).as_posix(),
            "cover_path": extracted_cover.relative_to(project_path).as_posix() if extracted_cover else None,
            "version": 1,
            "updated_at": _now(),
        }
        VersionManager(project_path).commit_staged_version(
            "free_videos",
            output_creation_id,
            str(metadata["prompt"]),
            staged_file=staged_file,
            current_file=output_path,
            on_commit=lambda: commit_free_creation_state(project_path, metadata),
            source="free_creation_subtitle_render",
            parent_creation_id=source_creation_id,
            subtitle_id=subtitle_id,
            subtitle_revision=track.get("revision"),
        )
        committed = True
        return metadata
    except TimeoutError as exc:
        if process is not None:
            process.kill()
            await process.wait()
        raise RuntimeError("ffmpeg subtitle render timed out") from exc
    except OSError as exc:
        raise RuntimeError("ffmpeg subtitle render could not start") from exc
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        if not committed:
            cover_path.unlink(missing_ok=True)


__all__ = [
    "composite_creation_audio",
    "merge_video_creations",
    "render_creation_subtitles",
    "resolve_audio_composite_paths",
    "resolve_merge_video_paths",
]
