"""AnyFast Seedance 2.0 video backend.

This adapter follows AnyFast's role-bearing ``content`` contract. It is kept
separate from the generic NewAPI adapter because the two request shapes have
different capability and media-transport semantics.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from lib.data_uri import file_to_data_uri
from lib.providers import PROVIDER_ANYFAST
from lib.retry import DEFAULT_BACKOFF_SECONDS, DEFAULT_MAX_ATTEMPTS, with_retry_async
from lib.video_backends.base import (
    TERMINAL_PROVIDER_STATUSES,
    ProviderJobIdPersistenceMixin,
    ProviderJobStatus,
    ReferenceAudioMode,
    ResumeExpiredError,
    VideoCapabilities,
    VideoCapabilityError,
    VideoGenerationRequest,
    VideoGenerationResult,
    VideoProviderError,
    extract_provider_error_message,
    first_str_by_paths,
    normalize_provider_status,
    poll_with_retry,
    reference_audio_to_data_uri,
    should_retry_poll,
    should_retry_submit,
    submit_post,
)

logger = logging.getLogger(__name__)

_POLL_INTERVAL_SECONDS = 5.0
_MIN_POLL_TIMEOUT_SECONDS = 600
_POLL_TIMEOUT_PER_SECOND = 30

_STATUS_PATHS: tuple[tuple[str | int, ...], ...] = (("data", "status"), ("status",))
_VIDEO_URL_PATHS: tuple[tuple[str | int, ...], ...] = (
    ("data", "result_url"),
    ("data", "data", "content", "video_url"),
)
_SEED_PATHS: tuple[tuple[str | int, ...], ...] = (("data", "data", "seed"),)
_FAILURE_PATHS: tuple[tuple[str | int, ...], ...] = (("data", "fail_reason"),)
_SUPPORTED_RATIOS = ("16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive")
_REFERENCE_AUDIO_MIME_TYPES = {".wav": "audio/wav", ".mp3": "audio/mpeg"}
_REFERENCE_VIDEO_MIME_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime"}
_MAX_NESTED_ERROR_TEXT_LENGTH = 16_384
_CONTENT_POINTER_RE = re.compile(r"\bcontent\[(\d+)]")
_DOCUMENTED_CONTENT_REJECTION_CODES = (
    "InputImageSensitiveContentDetected",
    "InputTextSensitiveContentDetected",
    "OutputVideoSensitiveContentDetected",
)


@dataclass(frozen=True, slots=True)
class _AnyFastFailureDetail:
    code: str
    message: str
    param: str


def _as_json_object(value: object) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return {str(key): item for key, item in value.items()}
    if not isinstance(value, str) or len(value) > _MAX_NESTED_ERROR_TEXT_LENGTH:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, RecursionError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _failure_details(value: object, *, depth: int = 0) -> list[_AnyFastFailureDetail]:
    """Read both documented error envelopes and AnyFast's nested-message envelope."""

    if depth > 5:
        return []
    if isinstance(value, str):
        nested = _as_json_object(value)
        if nested is not None:
            return _failure_details(nested, depth=depth + 1)
        return [_AnyFastFailureDetail(code="", message=value, param="")]
    if not isinstance(value, Mapping):
        return []

    code = value.get("code")
    message = value.get("message")
    param = value.get("param")
    details = [
        _AnyFastFailureDetail(
            code=code.strip() if isinstance(code, str) else "",
            message=message.strip() if isinstance(message, str) else "",
            param=param.strip() if isinstance(param, str) else "",
        )
    ]
    for key in ("error", "data", "fail_reason", "message"):
        nested = value.get(key)
        if nested is not None:
            details.extend(_failure_details(nested, depth=depth + 1))
    return details


def _documented_rejection(payload: object) -> tuple[str, str] | None:
    for detail in _failure_details(payload):
        base_code = detail.code.split(".", 1)[0]
        if base_code in _DOCUMENTED_CONTENT_REJECTION_CODES:
            return base_code, " ".join(part for part in (detail.message, detail.param) if part)
        combined = " ".join(part for part in (detail.code, detail.message, detail.param) if part)
        for known_code in _DOCUMENTED_CONTENT_REJECTION_CODES:
            if known_code in combined:
                return known_code, combined
    return None


def _content_role(content: Sequence[object], index: int) -> tuple[str | None, int | None]:
    if index < 0 or index >= len(content):
        return None, None
    item = content[index]
    if not isinstance(item, Mapping):
        return None, None
    role = item.get("role")
    if role != "reference_image":
        return role if isinstance(role, str) else None, None
    number = sum(
        1
        for candidate in content[: index + 1]
        if isinstance(candidate, Mapping) and candidate.get("role") == "reference_image"
    )
    return role, number


def _provider_error_from_payload(payload: object, content: Sequence[object]) -> VideoProviderError | None:
    rejection = _documented_rejection(payload)
    if rejection is None:
        return None
    provider_code, detail = rejection
    if provider_code == "InputTextSensitiveContentDetected":
        return VideoProviderError("video_input_text_content_rejected")
    if provider_code == "OutputVideoSensitiveContentDetected":
        return VideoProviderError("video_output_content_rejected")

    pointer = _CONTENT_POINTER_RE.search(detail)
    role, number = _content_role(content, int(pointer.group(1))) if pointer is not None else (None, None)
    if role == "first_frame":
        return VideoProviderError("video_first_frame_content_rejected")
    if role == "last_frame":
        return VideoProviderError("video_last_frame_content_rejected")
    if role == "reference_image" and number is not None:
        return VideoProviderError("video_reference_image_content_rejected", number=number)
    return VideoProviderError("video_input_image_content_rejected")


def _response_provider_error(response: httpx.Response, content: Sequence[object]) -> VideoProviderError | None:
    try:
        payload = response.json()
    except (TypeError, ValueError):
        return None
    return _provider_error_from_payload(payload, content)


def _request_content_descriptors(request: VideoGenerationRequest) -> list[dict[str, str]]:
    content: list[dict[str, str]] = []
    if request.prompt.strip():
        content.append({"type": "text"})
    if request.start_image is not None:
        content.append({"type": "image_url", "role": "first_frame"})
    if request.end_image is not None:
        content.append({"type": "image_url", "role": "last_frame"})
    content.extend({"type": "image_url", "role": "reference_image"} for _ in request.reference_images or [])
    content.extend({"type": "video_url", "role": "reference_video"} for _ in request.reference_videos or [])
    content.extend({"type": "audio_url", "role": "reference_audio"} for _ in request.reference_audio_files or [])
    return content


@dataclass(frozen=True, slots=True)
class _SeedanceModelProfile:
    """Capabilities verified against one AnyFast Seedance model document.

    Reference media is transported as provider-compatible data URIs. The model
    profile remains the single source for the per-model count and duration
    limits exposed to the UI and enforced before submission.
    """

    resolutions: tuple[str, ...]
    max_duration: int
    min_duration: int = 4
    max_reference_images: int = 0
    max_reference_videos: int = 0
    min_reference_video_seconds: float | None = None
    max_reference_video_seconds: float | None = None
    max_reference_video_total_seconds: float | None = None
    max_reference_audio: int = 0
    max_reference_audio_total_seconds: float | None = None
    text_to_video: bool = True
    first_frame: bool = True
    last_frame: bool = True
    reference_images: bool = False
    reference_audio: bool = False
    generate_audio: bool = True
    text_adaptive_ratio: bool = True
    frame_adaptive_ratio_only: bool = False
    requires_resolution: bool = False


def _profile(
    *,
    resolutions: tuple[str, ...],
    max_duration: int,
    min_duration: int = 4,
    max_reference_images: int = 0,
    max_reference_videos: int = 0,
    min_reference_video_seconds: float | None = None,
    max_reference_video_seconds: float | None = None,
    max_reference_video_total_seconds: float | None = None,
    max_reference_audio: int = 0,
    max_reference_audio_total_seconds: float | None = None,
    text_to_video: bool = True,
    first_frame: bool = True,
    last_frame: bool = True,
    reference_images: bool = False,
    reference_audio: bool = False,
    generate_audio: bool = True,
    text_adaptive_ratio: bool = True,
    frame_adaptive_ratio_only: bool = False,
    requires_resolution: bool = False,
) -> _SeedanceModelProfile:
    return _SeedanceModelProfile(
        resolutions=resolutions,
        max_duration=max_duration,
        min_duration=min_duration,
        max_reference_images=max_reference_images,
        max_reference_videos=max_reference_videos,
        min_reference_video_seconds=min_reference_video_seconds,
        max_reference_video_seconds=max_reference_video_seconds,
        max_reference_video_total_seconds=max_reference_video_total_seconds,
        max_reference_audio=max_reference_audio,
        max_reference_audio_total_seconds=max_reference_audio_total_seconds,
        text_to_video=text_to_video,
        first_frame=first_frame,
        last_frame=last_frame,
        reference_images=reference_images,
        reference_audio=reference_audio,
        generate_audio=generate_audio,
        text_adaptive_ratio=text_adaptive_ratio,
        frame_adaptive_ratio_only=frame_adaptive_ratio_only,
        requires_resolution=requires_resolution,
    )


_SEEDANCE_MODEL_PROFILES: dict[str, _SeedanceModelProfile] = {
    # AnyFast Seedance 2.x model pages.
    "seedance-2.0": _profile(
        resolutions=("480p", "720p", "1080p", "4k"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
    ),
    "seedance-2.0-nsfw": _profile(
        resolutions=("480p", "720p", "1080p", "4k"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
    ),
    "seedance-fast": _profile(
        resolutions=("480p", "720p"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
    ),
    "seedance-2.0-fast": _profile(
        resolutions=("480p", "720p"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
    ),
    "seedance-2.0-fast-nsfw": _profile(
        resolutions=("480p", "720p"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
    ),
    "seedance-2.0-mini": _profile(
        resolutions=("480p", "720p"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
    ),
    "seedance-2.0-mini-nsfw": _profile(
        resolutions=("480p", "720p"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
    ),
    "seedance-2.0-ultra": _profile(
        resolutions=("720p", "1080p", "2k"),
        max_duration=15,
        max_reference_images=9,
        max_reference_videos=3,
        min_reference_video_seconds=2,
        max_reference_video_seconds=15,
        max_reference_video_total_seconds=15,
        max_reference_audio=3,
        max_reference_audio_total_seconds=15,
        reference_images=True,
        reference_audio=True,
        requires_resolution=True,
    ),
    "seedance-2.5": _profile(
        resolutions=("480p", "720p", "1080p"),
        max_duration=30,
        max_reference_images=30,
        max_reference_videos=10,
        min_reference_video_seconds=2,
        max_reference_video_seconds=30,
        max_reference_video_total_seconds=30,
        max_reference_audio=10,
        max_reference_audio_total_seconds=30,
        reference_images=True,
        reference_audio=True,
        frame_adaptive_ratio_only=True,
    ),
    "seedance-2.5-nsfw": _profile(
        resolutions=("480p", "720p", "1080p"),
        max_duration=30,
        max_reference_images=30,
        max_reference_videos=10,
        min_reference_video_seconds=2,
        max_reference_video_seconds=30,
        max_reference_video_total_seconds=30,
        max_reference_audio=10,
        max_reference_audio_total_seconds=30,
        reference_images=True,
        reference_audio=True,
        frame_adaptive_ratio_only=True,
    ),
    # Legacy Seedance pages expose the same content contract but do not expose
    # multimodal reference-image/audio roles in their request schema.
    "doubao-seedance-1-5-pro-251215": _profile(
        resolutions=("480p", "720p", "1080p"),
        max_duration=12,
        last_frame=True,
        generate_audio=True,
        text_adaptive_ratio=False,
    ),
    "doubao-seedance-1-0-pro-250528": _profile(
        resolutions=("480p", "720p", "1080p"),
        max_duration=12,
        min_duration=2,
        last_frame=True,
        generate_audio=False,
        text_adaptive_ratio=False,
    ),
    "doubao-seedance-1-0-pro-fast-251015": _profile(
        resolutions=("480p", "720p", "1080p"),
        max_duration=12,
        min_duration=2,
        last_frame=True,
        generate_audio=False,
        text_adaptive_ratio=False,
    ),
    "doubao-seedance-1-0-lite-t2v-250428": _profile(
        resolutions=("480p", "720p", "1080p"),
        max_duration=12,
        min_duration=2,
        first_frame=False,
        last_frame=False,
        generate_audio=False,
        text_adaptive_ratio=False,
    ),
    "doubao-seedance-1-0-lite-i2v-250428": _profile(
        resolutions=("480p", "720p", "1080p"),
        max_duration=12,
        min_duration=2,
        text_to_video=False,
        last_frame=True,
        generate_audio=False,
    ),
}


def _normalize_seedance_model(model: str) -> str:
    normalized = model.strip().lower().replace("_", "-")
    match = re.fullmatch(r"seedance-?(\d)[-.](\d)(.*)", normalized)
    if match:
        return f"seedance-{match.group(1)}.{match.group(2)}{match.group(3)}"
    return normalized


def _model_profile(model: str) -> _SeedanceModelProfile | None:
    return _SEEDANCE_MODEL_PROFILES.get(_normalize_seedance_model(model))


def _normalize_root(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    if value and "://" not in value:
        value = f"https://{value}"
    return re.sub(r"/v1$", "", value)


def _image_content(path: Path, *, role: str, model: str) -> dict[str, Any]:
    if not path.is_file():
        if role == "reference_image":
            raise VideoCapabilityError(
                "video_reference_images_unreadable",
                model=model,
                names=path.name or str(path),
            )
        if role == "last_frame":
            raise VideoCapabilityError("video_end_image_unreadable", model=model, name=path.name or str(path))
        raise VideoCapabilityError("video_start_image_unreadable", model=model, name=path.name or str(path))
    from lib.image_backends.base import image_to_base64_data_uri

    return {
        "type": "image_url",
        "image_url": {"url": image_to_base64_data_uri(path)},
        "role": role,
    }


def _video_content(path: Path, *, role: str, model: str) -> dict[str, Any]:
    """Encode a local reference clip using AnyFast's ``video_url`` contract."""

    if not path.is_file():
        raise VideoCapabilityError("video_reference_videos_unreadable", model=model, names=path.name or str(path))
    mime = _REFERENCE_VIDEO_MIME_TYPES.get(path.suffix.lower())
    if mime is None:
        raise VideoCapabilityError("video_reference_videos_unreadable", model=model, names=path.name or str(path))
    try:
        url = file_to_data_uri(path, mime)
    except OSError as exc:
        raise VideoCapabilityError("video_reference_videos_unreadable", model=model, names=path.name) from exc
    return {"type": "video_url", "video_url": {"url": url}, "role": role}


def build_seedance_request_body(model: str, request: VideoGenerationRequest) -> dict[str, Any]:
    """Map MatrixSpooll's normalized request to AnyFast's role-bearing contract."""

    profile = _model_profile(model)
    if profile is None:
        raise VideoCapabilityError("video_model_unsupported", provider=PROVIDER_ANYFAST, model=model)
    if request.end_image is not None and request.start_image is None:
        raise VideoCapabilityError("video_end_image_requires_start_image", model=model)

    has_frames = request.start_image is not None or request.end_image is not None
    has_references = bool(request.reference_images or request.reference_videos or request.reference_audio_files)
    if request.start_image is not None and not profile.first_frame:
        raise VideoCapabilityError("video_start_image_unsupported", model=model)
    if request.end_image is not None and not profile.last_frame:
        raise VideoCapabilityError("video_end_image_unsupported", model=model)
    if has_frames and has_references:
        raise VideoCapabilityError("free_creation_input_combination_unsupported", model=model)
    reference_video_count = len(request.reference_videos or [])
    if reference_video_count and not profile.max_reference_videos:
        raise VideoCapabilityError("video_reference_videos_unsupported", model=model)
    if reference_video_count > profile.max_reference_videos:
        raise VideoCapabilityError(
            "video_reference_videos_exceeded",
            model=model,
            limit=profile.max_reference_videos,
            count=reference_video_count,
        )
    reference_image_count = len(request.reference_images or [])
    if reference_image_count and not profile.reference_images:
        raise VideoCapabilityError("video_reference_images_unsupported", model=model)
    if reference_image_count > profile.max_reference_images:
        raise VideoCapabilityError(
            "video_reference_images_exceeded",
            model=model,
            limit=profile.max_reference_images,
            count=reference_image_count,
        )
    reference_audio_count = len(request.reference_audio_files or [])
    if reference_audio_count and not profile.reference_audio:
        raise VideoCapabilityError("video_reference_audio_unsupported", provider=PROVIDER_ANYFAST, model=model)
    if reference_audio_count > profile.max_reference_audio:
        raise VideoCapabilityError(
            "video_reference_audio_exceeded",
            model=model,
            limit=profile.max_reference_audio,
            count=reference_audio_count,
        )
    if not has_frames and not has_references and not profile.text_to_video:
        raise VideoCapabilityError("video_t2v_unsupported", model=model)
    if request.aspect_ratio not in _SUPPORTED_RATIOS:
        raise VideoCapabilityError("video_aspect_ratio_unsupported", model=model, ratio=request.aspect_ratio)
    if request.aspect_ratio == "adaptive" and not has_frames and not has_references and not profile.text_adaptive_ratio:
        raise VideoCapabilityError("video_aspect_ratio_unsupported", model=model, ratio=request.aspect_ratio)
    if request.resolution is None and profile.requires_resolution:
        raise VideoCapabilityError("video_resolution_required", model=model)
    if request.resolution is not None and request.resolution not in profile.resolutions:
        raise VideoCapabilityError("video_resolution_unsupported", model=model, resolution=request.resolution)
    if request.duration_seconds < max(4, profile.min_duration) or request.duration_seconds > profile.max_duration:
        raise VideoCapabilityError("video_duration_unsupported", model=model, duration=request.duration_seconds)
    if profile.frame_adaptive_ratio_only and has_frames and request.aspect_ratio != "adaptive":
        raise VideoCapabilityError("video_aspect_ratio_unsupported", model=model, ratio=request.aspect_ratio)

    content: list[dict[str, Any]] = []
    if request.prompt.strip():
        content.append({"type": "text", "text": request.prompt})

    if request.start_image is not None:
        content.append(_image_content(Path(request.start_image), role="first_frame", model=model))
    if request.end_image is not None:
        content.append(_image_content(Path(request.end_image), role="last_frame", model=model))

    for image in request.reference_images or []:
        content.append(_image_content(Path(image), role="reference_image", model=model))
    for video in request.reference_videos or []:
        content.append(_video_content(Path(video), role="reference_video", model=model))
    for audio in request.reference_audio_files or []:
        audio_path = Path(audio)
        content.append(
            {
                "type": "audio_url",
                "audio_url": {
                    "url": reference_audio_to_data_uri(
                        audio_path,
                        model=model,
                        mime_types=_REFERENCE_AUDIO_MIME_TYPES,
                    )
                },
                "role": "reference_audio",
            }
        )

    if not content:
        raise VideoCapabilityError("video_prompt_required", model=model)

    body: dict[str, Any] = {
        "model": model,
        "content": content,
        "ratio": request.aspect_ratio,
        "duration": request.duration_seconds,
        "watermark": False,
        "return_last_frame": False,
    }
    if profile.generate_audio:
        body["generate_audio"] = request.generate_audio
    if request.resolution is not None:
        body["resolution"] = request.resolution
    if request.seed is not None:
        body["seed"] = request.seed
    return body


class AnyFastSeedanceBackend(ProviderJobIdPersistenceMixin):
    """AnyFast ``/v1/video/generations`` Seedance adapter."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        http_timeout: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
        poll_interval_seconds: float = _POLL_INTERVAL_SECONDS,
    ) -> None:
        if not api_key:
            raise ValueError("AnyFast Seedance backend requires api_key")
        if not base_url:
            raise ValueError("AnyFast Seedance backend requires base_url")
        self._api_key = api_key
        self._root = _normalize_root(base_url)
        self._model = model
        self._http_timeout = http_timeout
        self._transport = transport
        self._poll_interval_seconds = poll_interval_seconds

    @property
    def name(self) -> str:
        return PROVIDER_ANYFAST

    @property
    def model(self) -> str:
        return self._model

    @staticmethod
    def video_capabilities_for_model(model: str) -> VideoCapabilities:
        profile = _model_profile(model)
        if profile is None:
            return VideoCapabilities(
                text_to_video=False,
                first_frame=False,
                last_frame=False,
                supported_aspect_ratios=_SUPPORTED_RATIOS,
            )
        supported_aspect_ratios = tuple(
            ratio for ratio in _SUPPORTED_RATIOS if profile.text_adaptive_ratio or ratio != "adaptive"
        )
        return VideoCapabilities(
            text_to_video=profile.text_to_video,
            first_frame=profile.first_frame,
            last_frame=profile.last_frame,
            max_reference_images=profile.max_reference_images if profile.reference_images else 0,
            max_reference_videos=profile.max_reference_videos,
            min_reference_video_seconds=profile.min_reference_video_seconds,
            max_reference_video_seconds=profile.max_reference_video_seconds,
            max_reference_video_total_seconds=profile.max_reference_video_total_seconds,
            supported_aspect_ratios=supported_aspect_ratios,
            supported_resolutions=profile.resolutions,
            supported_durations=tuple(range(max(4, profile.min_duration), profile.max_duration + 1)),
            reference_audio_mode=ReferenceAudioMode.DIRECT if profile.reference_audio else ReferenceAudioMode.NONE,
            max_reference_audio_count=profile.max_reference_audio if profile.reference_audio else 0,
            max_reference_audio_total_seconds=(
                profile.max_reference_audio_total_seconds if profile.reference_audio else None
            ),
            first_frame_ratio_adaptive_only=profile.frame_adaptive_ratio_only,
        )

    @property
    def video_capabilities(self) -> VideoCapabilities:
        return self.video_capabilities_for_model(self._model)

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self._http_timeout, transport=self._transport)

    def _api_root(self, request: VideoGenerationRequest) -> str:
        if request.submitted_base_url:
            return _normalize_root(request.submitted_base_url)
        return self._root

    async def generate(self, request: VideoGenerationRequest) -> VideoGenerationResult:
        body = build_seedance_request_body(self._model, request)
        root = self._api_root(request)
        async with self._client() as client:
            task_id = await self._create_task(client, root, body)
            await self._persist_provider_job_id(request, task_id, provider=PROVIDER_ANYFAST, endpoint=root)
            return await self._poll_and_build(
                client,
                task_id,
                request,
                is_resume=False,
                content=body.get("content", []),
            )

    async def resume_video(self, job_id: str, request: VideoGenerationRequest) -> VideoGenerationResult:
        async with self._client() as client:
            return await self._poll_and_build(
                client,
                job_id,
                request,
                is_resume=True,
                content=_request_content_descriptors(request),
            )

    @with_retry_async(
        max_attempts=DEFAULT_MAX_ATTEMPTS,
        backoff_seconds=DEFAULT_BACKOFF_SECONDS,
        retry_if=should_retry_submit,
    )
    async def _create_task(self, client: httpx.AsyncClient, root: str, body: dict[str, Any]) -> str:
        content = body.get("content")
        content_items = content if isinstance(content, list) else []
        try:
            response = await submit_post(
                lambda: client.post(f"{root}/v1/video/generations", json=body, headers=self._headers()),
                provider=PROVIDER_ANYFAST,
            )
        except httpx.HTTPStatusError as exc:
            provider_error = _response_provider_error(exc.response, content_items)
            if provider_error is not None:
                raise provider_error from exc
            raise
        payload = response.json()
        task_id = first_str_by_paths(payload, (("task_id",), ("id",)))
        if not task_id:
            raise RuntimeError(f"AnyFast task response is missing task_id: {payload}")
        return task_id

    async def _poll_once(self, client: httpx.AsyncClient, root: str, task_id: str) -> dict[str, Any]:
        response = await client.get(f"{root}/v1/video/generations/{task_id}", headers=self._headers())
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("AnyFast task response must be a JSON object")
        return payload

    async def _poll_and_build(
        self,
        client: httpx.AsyncClient,
        task_id: str,
        request: VideoGenerationRequest,
        *,
        is_resume: bool,
        content: Sequence[object] | None = None,
    ) -> VideoGenerationResult:
        root = self._api_root(request)
        content_items = content if content is not None else _request_content_descriptors(request)

        async def poll() -> dict[str, Any]:
            try:
                state = await self._poll_once(client, root, task_id)
            except httpx.HTTPStatusError as exc:
                provider_error = _response_provider_error(exc.response, content_items)
                if provider_error is not None:
                    raise provider_error from exc
                if is_resume and exc.response.status_code == 404:
                    raise ResumeExpiredError(job_id=task_id, provider=PROVIDER_ANYFAST) from exc
                raise
            if self._status(state) is ProviderJobStatus.FAILED:
                provider_error = _provider_error_from_payload(state, content_items)
                if provider_error is not None:
                    raise provider_error
            return state

        final = await poll_with_retry(
            poll_fn=poll,
            is_done=lambda state: self._status(state) in TERMINAL_PROVIDER_STATUSES,
            is_failed=self._failure,
            poll_interval=self._poll_interval_seconds,
            max_wait=max(_MIN_POLL_TIMEOUT_SECONDS, request.duration_seconds * _POLL_TIMEOUT_PER_SECOND),
            retry_if=should_retry_poll,
            label="AnyFast",
        )
        if self._status(final) is ProviderJobStatus.EXPIRED:
            if is_resume:
                raise ResumeExpiredError(job_id=task_id, provider=PROVIDER_ANYFAST)
            raise RuntimeError(f"AnyFast task expired during generation: {task_id}")

        video_url = first_str_by_paths(final, _VIDEO_URL_PATHS)
        if not video_url:
            raise RuntimeError(f"AnyFast task succeeded without a video URL: {final}")
        await self._download(client, video_url, request.output_path)

        seed_text = first_str_by_paths(final, _SEED_PATHS)
        seed = int(seed_text) if seed_text is not None else request.seed
        return VideoGenerationResult(
            video_path=request.output_path,
            provider=PROVIDER_ANYFAST,
            model=self._model,
            duration_seconds=request.duration_seconds,
            video_uri=video_url,
            seed=seed,
            task_id=task_id,
            generate_audio=request.generate_audio,
        )

    async def _download(self, client: httpx.AsyncClient, url: str, output_path: Path) -> None:
        await asyncio.to_thread(output_path.parent.mkdir, parents=True, exist_ok=True)
        async with client.stream("GET", url) as response:
            if response.status_code >= 400:
                await response.aread()
            response.raise_for_status()
            chunks = [chunk async for chunk in response.aiter_bytes(chunk_size=65536)]

        def write() -> None:
            with open(output_path, "wb") as file:
                for chunk in chunks:
                    file.write(chunk)

        await asyncio.to_thread(write)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    @staticmethod
    def _status(state: dict[str, Any]) -> ProviderJobStatus:
        return normalize_provider_status(first_str_by_paths(state, _STATUS_PATHS))

    @classmethod
    def _failure(cls, state: dict[str, Any]) -> str | None:
        if cls._status(state) is not ProviderJobStatus.FAILED:
            return None
        message = first_str_by_paths(state, _FAILURE_PATHS) or extract_provider_error_message(state)
        return f"AnyFast video generation failed: {message}"
