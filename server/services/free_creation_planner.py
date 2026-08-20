"""Translate explicit free-creation reference roles into execution inputs."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

FreeCreationMode = Literal[
    "t2v",
    "first_frame",
    "first_last_frame",
    "reference_image",
    "reference_video",
    "image",
    "edit",
]

_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_VIDEO_SUFFIXES = frozenset({".mp4", ".mov"})
_AUDIO_SUFFIXES = frozenset({".wav", ".mp3"})
_VIDEO_REFERENCE_ROLES = frozenset(
    {"first_frame", "last_frame", "reference_image", "reference_video", "reference_audio", "prompt_context"}
)


@dataclass(frozen=True)
class VideoReferencePlan:
    """Provider-neutral video inputs selected from ordered, role-bearing references."""

    start_image: Path | None
    end_image: Path | None
    reference_images: tuple[Path, ...]
    reference_videos: tuple[Path, ...]
    reference_audio: tuple[Path, ...]


def effective_free_creation_mode(output_type: str, claims: Sequence[dict[str, Any]]) -> FreeCreationMode:
    """Derive the user-visible mode from explicit roles without guessing from a file extension."""

    if output_type != "video":
        return "edit" if output_type == "edit" else "image"
    roles = {claim.get("role") for claim in claims if isinstance(claim.get("role"), str)}
    if "first_frame" in roles and "last_frame" in roles:
        return "first_last_frame"
    if "first_frame" in roles:
        return "first_frame"
    if "reference_video" in roles:
        return "reference_video"
    if "reference_image" in roles:
        return "reference_image"
    return "t2v"


def _legacy_video_reference_plan(references: Sequence[Path]) -> VideoReferencePlan:
    return VideoReferencePlan(
        start_image=None,
        end_image=None,
        reference_images=tuple(path for path in references if path.suffix.lower() in _IMAGE_SUFFIXES),
        reference_videos=tuple(path for path in references if path.suffix.lower() in _VIDEO_SUFFIXES),
        reference_audio=tuple(path for path in references if path.suffix.lower() in _AUDIO_SUFFIXES),
    )


def plan_video_references(
    references: Sequence[Path],
    claims: object,
) -> VideoReferencePlan:
    """Create a strict execution plan from references and their corresponding roles.

    Role-bearing requests must have one claim per path. This prevents a parent or
    a newly inserted reference from shifting every later role onto the wrong file.
    Older unclaimed queued requests retain suffix-based fallback behavior.
    """

    if claims is None or claims == []:
        return _legacy_video_reference_plan(references)
    if not isinstance(claims, list) or len(claims) != len(references):
        raise ValueError("reference paths and claims must align")

    start_image: Path | None = None
    end_image: Path | None = None
    reference_images: list[Path] = []
    reference_videos: list[Path] = []
    reference_audio: list[Path] = []
    for path, claim in zip(references, claims, strict=True):
        if not isinstance(claim, dict):
            raise ValueError("reference claims must be objects")
        role = claim.get("role")
        if role not in _VIDEO_REFERENCE_ROLES:
            raise ValueError("video reference role is invalid")
        if role == "first_frame":
            if start_image is not None:
                raise ValueError("only one first-frame reference is allowed")
            start_image = path
        elif role == "last_frame":
            if end_image is not None:
                raise ValueError("only one last-frame reference is allowed")
            end_image = path
        elif role == "reference_image":
            reference_images.append(path)
        elif role == "reference_video":
            reference_videos.append(path)
        elif role == "reference_audio":
            reference_audio.append(path)

    return VideoReferencePlan(
        start_image=start_image,
        end_image=end_image,
        reference_images=tuple(reference_images),
        reference_videos=tuple(reference_videos),
        reference_audio=tuple(reference_audio),
    )


__all__ = ["FreeCreationMode", "VideoReferencePlan", "effective_free_creation_mode", "plan_video_references"]
