"""AnyFast Seedance 2.0 video backend.

This adapter follows AnyFast's role-bearing ``content`` contract. It is kept
separate from the generic NewAPI adapter because the two request shapes have
different capability and media-transport semantics.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

import httpx

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


def _model_generation_limits(model: str) -> tuple[int, set[str], int, int] | None:
    if model in {"seedance-2.0", "seedance-2.0-nsfw"}:
        return 15, {"480p", "720p", "1080p", "4k"}, 9, 3
    if model in {"seedance-2.5", "seedance-2.5-nsfw"}:
        return 30, {"480p", "720p", "1080p"}, 30, 10
    return None


def _normalize_root(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    if value and "://" not in value:
        value = f"https://{value}"
    return re.sub(r"/v1$", "", value)


def _image_content(path: Path, *, role: str, model: str) -> dict[str, Any]:
    if not path.is_file():
        code = "video_end_image_unreadable" if role == "last_frame" else "video_start_image_unreadable"
        if role == "reference_image":
            code = "video_reference_images_unreadable"
            raise VideoCapabilityError(code, model=model, names=path.name or str(path))
        raise VideoCapabilityError(code, model=model, name=path.name or str(path))
    from lib.image_backends.base import image_to_base64_data_uri

    return {
        "type": "image_url",
        "image_url": {"url": image_to_base64_data_uri(path)},
        "role": role,
    }


def build_seedance_request_body(model: str, request: VideoGenerationRequest) -> dict[str, Any]:
    """Map ArcReel's normalized request to AnyFast's role-bearing contract."""

    limits = _model_generation_limits(model)
    if limits is None:
        raise VideoCapabilityError("video_model_unsupported", provider=PROVIDER_ANYFAST, model=model)
    max_duration, supported_resolutions, max_reference_images, max_reference_audio_count = limits
    if request.end_image is not None and request.start_image is None:
        raise VideoCapabilityError("video_end_image_requires_start_image", model=model)

    has_frames = request.start_image is not None or request.end_image is not None
    has_references = bool(request.reference_images or request.reference_videos or request.reference_audio_files)
    if has_frames and has_references:
        raise VideoCapabilityError("free_creation_input_combination_unsupported", model=model)
    if request.reference_videos:
        # AnyFast accepts remote URLs or asset:// IDs for videos. The normalized
        # ArcReel request currently carries only local Paths, so pretending these
        # paths are uploadable would silently create an invalid paid request.
        raise VideoCapabilityError("video_reference_videos_unsupported", model=model)
    reference_image_count = len(request.reference_images or [])
    if reference_image_count > max_reference_images:
        raise VideoCapabilityError(
            "video_reference_images_exceeded",
            model=model,
            limit=max_reference_images,
            count=reference_image_count,
        )
    reference_audio_count = len(request.reference_audio_files or [])
    if reference_audio_count > max_reference_audio_count:
        raise VideoCapabilityError(
            "video_reference_audio_exceeded",
            model=model,
            limit=max_reference_audio_count,
            count=reference_audio_count,
        )
    if request.aspect_ratio not in _SUPPORTED_RATIOS:
        raise VideoCapabilityError("video_aspect_ratio_unsupported", model=model, ratio=request.aspect_ratio)
    if request.resolution is not None and request.resolution not in supported_resolutions:
        raise VideoCapabilityError("video_resolution_unsupported", model=model, resolution=request.resolution)
    if request.duration_seconds < 4 or request.duration_seconds > max_duration:
        raise VideoCapabilityError("video_duration_unsupported", model=model, duration=request.duration_seconds)
    if model.startswith("seedance-2.5") and has_frames and request.aspect_ratio != "adaptive":
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
        "generate_audio": request.generate_audio,
        "ratio": request.aspect_ratio,
        "duration": request.duration_seconds,
        "watermark": False,
        "return_last_frame": False,
    }
    if request.resolution is not None:
        body["resolution"] = request.resolution
    if request.seed is not None:
        body["seed"] = request.seed
    return body


class AnyFastSeedanceBackend(ProviderJobIdPersistenceMixin):
    """AnyFast ``/v1/video/generations`` Seedance 2.0 adapter."""

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
        limits = _model_generation_limits(model)
        if limits is None:
            return VideoCapabilities(
                text_to_video=False,
                first_frame=False,
                last_frame=False,
                supported_aspect_ratios=_SUPPORTED_RATIOS,
            )
        _, _, max_reference_images, max_reference_audio_count = limits
        return VideoCapabilities(
            text_to_video=True,
            first_frame=True,
            last_frame=True,
            max_reference_images=max_reference_images,
            # The provider supports remote reference videos, but ArcReel's
            # normalized request has no remote URL/asset-id transport yet.
            max_reference_videos=0,
            supported_aspect_ratios=_SUPPORTED_RATIOS,
            reference_audio_mode=ReferenceAudioMode.DIRECT,
            max_reference_audio_count=max_reference_audio_count,
            first_frame_ratio_adaptive_only=model.startswith("seedance-2.5"),
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
            return await self._poll_and_build(client, task_id, request, is_resume=False)

    async def resume_video(self, job_id: str, request: VideoGenerationRequest) -> VideoGenerationResult:
        async with self._client() as client:
            return await self._poll_and_build(client, job_id, request, is_resume=True)

    @with_retry_async(
        max_attempts=DEFAULT_MAX_ATTEMPTS,
        backoff_seconds=DEFAULT_BACKOFF_SECONDS,
        retry_if=should_retry_submit,
    )
    async def _create_task(self, client: httpx.AsyncClient, root: str, body: dict[str, Any]) -> str:
        response = await submit_post(
            lambda: client.post(f"{root}/v1/video/generations", json=body, headers=self._headers()),
            provider=PROVIDER_ANYFAST,
        )
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
    ) -> VideoGenerationResult:
        root = self._api_root(request)

        async def poll() -> dict[str, Any]:
            try:
                return await self._poll_once(client, root, task_id)
            except httpx.HTTPStatusError as exc:
                if is_resume and exc.response.status_code == 404:
                    raise ResumeExpiredError(job_id=task_id, provider=PROVIDER_ANYFAST) from exc
                raise

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
