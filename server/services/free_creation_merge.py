"""FFmpeg-backed post-production helpers for free-creation artifacts."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path
from typing import Any

from lib.artifact_manifest import ArtifactKey, ProjectArtifactManifestAdapter
from lib.ffmpeg_runner import MediaProcessError, find_media_tool, run_ffmpeg, run_ffprobe_json
from lib.path_safety import safe_join
from lib.thumbnail import extract_video_thumbnail
from lib.version_manager import VersionManager
from server.services.free_creation_tasks import commit_free_creation_state, creation_media_path
from server.services.free_creation_workspace import subtitle_track_webvtt

_FFMPEG_TIMEOUT_SECONDS = 30 * 60
_FFPROBE_TIMEOUT_SECONDS = 30
_MAX_MERGE_INPUT_BYTES = int(os.environ.get("MATRIXSPOOLL_MERGE_MAX_INPUT_BYTES", str(2 * 1024**3)))
_MAX_MERGE_DURATION_SECONDS = int(os.environ.get("MATRIXSPOOLL_MERGE_MAX_DURATION_SECONDS", str(30 * 60)))
_MERGE_SLOT = asyncio.Semaphore(1)
logger = logging.getLogger(__name__)


class FreeCreationMergeError(RuntimeError):
    """Stable failure reason for a local video merge task."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
        self.params: dict[str, Any] = {}


@dataclass(frozen=True)
class _VideoStreamInfo:
    width: int
    height: int
    frame_rate: str
    duration: float
    has_audio: bool


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _project_temp_directory(project_path: Path, prefix: str) -> Path:
    temporary_root = project_path / "tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(temporary_root)))


def resolve_merge_video_paths(
    project_path: Path,
    item_ids: list[str],
    creations: list[dict[str, Any]],
    uploads: list[dict[str, Any]] | None = None,
) -> list[Path]:
    """Resolve ordered generated or uploaded video files selected on the canvas."""

    if len(item_ids) < 2:
        raise ValueError("at least two video items are required")
    if len(set(item_ids)) != len(item_ids):
        raise ValueError("video item ids must be unique")

    creations_by_id = {str(item["creation_id"]): item for item in creations if isinstance(item.get("creation_id"), str)}
    uploads_by_id = {
        str(item["reference_id"]): item for item in uploads or [] if isinstance(item.get("reference_id"), str)
    }
    manifest = ProjectArtifactManifestAdapter(project_path)
    paths: list[Path] = []
    for item_id in item_ids:
        if item_id.startswith("c_"):
            creation = creations_by_id.get(item_id)
            if not isinstance(creation, dict):
                raise FileNotFoundError(item_id)
            if creation.get("status") != "succeeded":
                raise ValueError("all selected creations must be succeeded")
            if creation.get("media_type") != "video" and creation.get("output_type") != "video":
                raise ValueError("only video items can be merged")
            media_path = creation.get("media_path")
            if not isinstance(media_path, str):
                raise FileNotFoundError(item_id)
            entry = manifest.get_entry(ArtifactKey.free_creation(item_id))
            path = safe_join(project_path, media_path)
            if entry is None or entry.artifact_path != media_path or not path.is_file():
                raise FileNotFoundError(item_id)
        elif item_id.startswith("r_"):
            upload = uploads_by_id.get(item_id)
            if not isinstance(upload, dict):
                raise FileNotFoundError(item_id)
            if upload.get("media_type") != "video":
                raise ValueError("only video items can be merged")
            media_path = upload.get("path")
            if not isinstance(media_path, str):
                raise FileNotFoundError(item_id)
            path = safe_join(project_path, media_path)
            if not path.is_file():
                raise FileNotFoundError(item_id)
        else:
            raise ValueError("video item ids must identify creations or uploads")
        paths.append(path)
    return paths


def _positive_float(value: object) -> float | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _frame_rate(value: object) -> str:
    if not isinstance(value, str):
        return "30"
    try:
        parsed = Fraction(value)
    except (ValueError, ZeroDivisionError):
        return "30"
    if parsed <= 0 or parsed > 120:
        return "30"
    return f"{parsed.numerator}/{parsed.denominator}"


async def _probe_video(path: Path) -> _VideoStreamInfo:
    try:
        payload = await run_ffprobe_json(
            [
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,width,height,r_frame_rate,duration:format=duration",
                "-of",
                "json",
                str(path),
            ],
            timeout=_FFPROBE_TIMEOUT_SECONDS,
        )
    except MediaProcessError as exc:
        detail = f": {exc.detail[:300]}" if exc.detail else ""
        raise RuntimeError(f"ffprobe failed for {path.name}{detail}") from exc
    try:
        streams = payload.get("streams") if isinstance(payload, dict) else None
        if not isinstance(streams, list):
            raise ValueError("streams are missing")
        video = next(
            (stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "video"),
            None,
        )
        if not isinstance(video, dict):
            raise ValueError("video stream is missing")
        width = int(video.get("width") or 0)
        height = int(video.get("height") or 0)
        format_data = payload.get("format")
        format_duration = format_data.get("duration") if isinstance(format_data, dict) else None
        duration = _positive_float(video.get("duration")) or _positive_float(format_duration)
        if width <= 0 or height <= 0 or duration is None:
            raise ValueError("video dimensions or duration are invalid")
        return _VideoStreamInfo(
            width=width,
            height=height,
            frame_rate=_frame_rate(video.get("r_frame_rate")),
            duration=duration,
            has_audio=any(isinstance(stream, dict) and stream.get("codec_type") == "audio" for stream in streams),
        )
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"ffprobe returned invalid metadata for {path.name}") from exc


def _merge_filter(infos: list[_VideoStreamInfo]) -> str:
    first = infos[0]
    target_width = max(2, first.width - (first.width % 2))
    target_height = max(2, first.height - (first.height % 2))
    filters: list[str] = []
    for index, info in enumerate(infos):
        duration = f"{info.duration:.6f}"
        filters.append(
            f"[{index}:v:0]scale={target_width}:{target_height}:force_original_aspect_ratio=decrease:"
            f"force_divisible_by=2,pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,fps={first.frame_rate},format=yuv420p,setpts=PTS-STARTPTS[v{index}]"
        )
        if info.has_audio:
            filters.append(
                f"[{index}:a:0]aresample=48000:async=1:first_pts=0,"
                f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,"
                f"atrim=duration={duration},asetpts=PTS-STARTPTS[a{index}]"
            )
        else:
            filters.append(
                "anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={duration},asetpts=PTS-STARTPTS[a{index}]"
            )
    inputs = "".join(f"[v{index}][a{index}]" for index in range(len(infos)))
    filters.append(f"{inputs}concat=n={len(infos)}:v=1:a=1[outv][outa]")
    return ";".join(filters)


async def merge_video_creations(
    project_path: Path,
    item_ids: list[str],
    creations: list[dict[str, Any]],
    uploads: list[dict[str, Any]] | None = None,
) -> tuple[Path, Path]:
    """Merge selected clips and return ``(output_path, temporary_directory)``.

    The caller owns the temporary directory and should remove it after the
    response has finished streaming the output file.
    """

    paths = resolve_merge_video_paths(project_path, item_ids, creations, uploads)
    try:
        find_media_tool("ffmpeg")
        find_media_tool("ffprobe")
    except MediaProcessError as exc:
        raise FreeCreationMergeError("free_creation_merge_tools_missing") from exc

    try:
        infos = await asyncio.gather(*(_probe_video(path) for path in paths))
    except (MediaProcessError, RuntimeError) as exc:
        raise FreeCreationMergeError("free_creation_merge_input_unreadable") from exc
    total_bytes = sum(path.stat().st_size for path in paths)
    total_duration = sum(info.duration for info in infos)
    if total_bytes > _MAX_MERGE_INPUT_BYTES or total_duration > _MAX_MERGE_DURATION_SECONDS:
        raise FreeCreationMergeError("free_creation_merge_limits_exceeded")

    temporary_directory = _project_temp_directory(project_path, "matrixspooll-free-merge-")
    output_file = temporary_directory / "merged.mp4"
    try:
        async with _MERGE_SLOT:
            command = ["-hide_banner", "-loglevel", "error"]
            for path in paths:
                command.extend(["-i", str(path)])
            command.extend(
                [
                    "-filter_complex",
                    _merge_filter(infos),
                    "-map",
                    "[outv]",
                    "-map",
                    "[outa]",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                    "-max_muxing_queue_size",
                    "2048",
                    "-shortest",
                    "-y",
                    str(output_file),
                ]
            )
            await run_ffmpeg(command, timeout=_FFMPEG_TIMEOUT_SECONDS)
    except MediaProcessError as exc:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        logger.warning("FFmpeg video merge failed code=%s detail=%s", exc.code, exc.detail[:2000])
        raise FreeCreationMergeError("free_creation_merge_unavailable") from exc
    if not output_file.is_file() or output_file.stat().st_size <= 0:
        shutil.rmtree(temporary_directory, ignore_errors=True)
        raise FreeCreationMergeError("free_creation_merge_unavailable")
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
    find_media_tool("ffmpeg")

    temporary_directory = _project_temp_directory(project_path, "matrixspooll-free-audio-composite-")
    staged_file = temporary_directory / "composite.mp4"
    cover_path = project_path / "free_creation" / "covers" / f"{output_creation_id}.jpg"
    committed = False
    try:
        await run_ffmpeg(
            [
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
            ],
            timeout=_FFMPEG_TIMEOUT_SECONDS,
        )
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
    except MediaProcessError as exc:
        raise RuntimeError(f"ffmpeg audio composite failed: {exc.detail[:500]}") from exc
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
    find_media_tool("ffmpeg")

    temporary_directory = _project_temp_directory(project_path, "matrixspooll-free-subtitles-")
    subtitle_file = temporary_directory / "subtitles.vtt"
    subtitle_file.write_text(webvtt, encoding="utf-8")
    staged_file = temporary_directory / "subtitled.mp4"
    cover_path = project_path / "free_creation" / "covers" / f"{output_creation_id}.jpg"
    committed = False
    try:
        await run_ffmpeg(
            [
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
            ],
            timeout=_FFMPEG_TIMEOUT_SECONDS,
            cwd=temporary_directory,
        )
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
    except MediaProcessError as exc:
        raise RuntimeError(f"ffmpeg subtitle render failed: {exc.detail[:500]}") from exc
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
