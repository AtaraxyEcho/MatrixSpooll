"""Contract tests for the local AnyFast mock service."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

import httpx
import pytest

from lib.video_backends.base import VideoGenerationRequest
from lib.video_backends.newapi import NewAPIVideoBackend
from scripts.mock_anyfast import create_app

pytestmark = pytest.mark.unit


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


async def test_openai_compatible_chat_image_and_audio_endpoints() -> None:
    app = create_app()
    async with _client(app) as client:
        unauthorized = await client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})
        assert unauthorized.status_code == 401
        assert unauthorized.json()["error"]["code"] == "invalid_api_key"

        headers = {"Authorization": "Bearer mock-anyfast-key"}
        chat = await client.post(
            "/v1/chat/completions",
            headers=headers,
            json={"model": "mock-chat", "messages": [{"role": "user", "content": "hello"}]},
        )
        assert chat.status_code == 200
        assert chat.json()["choices"][0]["message"]["content"] == "Mock response: hello"
        assert chat.json()["usage"]["total_tokens"] > 0

        image = await client.post(
            "/v1/images/generations",
            headers=headers,
            json={"model": "seedream-5.0", "prompt": "a red kite"},
        )
        assert image.status_code == 200
        assert image.json()["data"][0]["b64_json"].startswith("iVBORw0KGgo")

        audio = await client.post(
            "/v1/audio/speech",
            headers=headers,
            json={"model": "mock-tts", "input": "hello", "voice": "alloy", "response_format": "wav"},
        )
        assert audio.status_code == 200
        assert audio.headers["content-type"].startswith("audio/wav")
        assert audio.content.startswith(b"RIFF")


async def test_seedance_task_progression_and_result_download() -> None:
    app = create_app()
    headers = {"Authorization": "Bearer mock-anyfast-key"}
    async with _client(app) as client:
        created = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={
                "model": "seedance-2.0",
                "content": [
                    {"type": "text", "text": "a character walks through rain"},
                    {"type": "image_url", "image_url": {"url": "asset://character"}, "role": "first_frame"},
                    {"type": "image_url", "image_url": {"url": "asset://scene"}, "role": "last_frame"},
                ],
                "ratio": "16:9",
                "resolution": "720p",
                "duration": 10,
                "generate_audio": True,
            },
        )
        assert created.status_code == 200
        task_id = created.json()["task_id"]
        assert task_id.startswith("asynmock_")

        statuses = []
        final = None
        for _ in range(3):
            response = await client.get(f"/v1/video/generations/{task_id}", headers=headers)
            assert response.status_code == 200
            final = response.json()
            statuses.append(final["data"]["status"])
        assert statuses == ["NOT_START", "IN_PROGRESS", "SUCCESS"]
        assert final is not None
        result_url = final["data"]["result_url"]
        media = await client.get(urlsplit(result_url).path)
        assert media.status_code == 200
        assert media.headers["content-type"].startswith("video/mp4")
        assert media.content.startswith(b"MOCK-ANYFAST-MP4")


async def test_newapi_video_adapter_can_run_against_the_mock_without_network(tmp_path: Path) -> None:
    """Exercise ArcReel's existing /v1 video adapter through the local HTTP contract."""

    app = create_app()
    transport = httpx.ASGITransport(app=app)
    real_async_client = httpx.AsyncClient
    client = real_async_client(transport=transport, base_url="http://testserver")

    def download_client(*args, **kwargs):
        return real_async_client(transport=transport, base_url="http://testserver")

    backend = NewAPIVideoBackend(api_key="mock-anyfast-key", base_url="http://testserver/v1", model="seedance-2.0")
    request = VideoGenerationRequest(
        prompt="a character walks through rain",
        output_path=tmp_path / "mock.mp4",
        aspect_ratio="16:9",
        resolution="720p",
        duration_seconds=5,
    )

    with (
        patch("lib.video_backends.newapi.httpx.AsyncClient", return_value=client),
        patch("lib.video_backends.base.httpx.AsyncClient", side_effect=download_client),
        patch("lib.video_backends.base.asyncio.sleep", new_callable=AsyncMock),
    ):
        result = await backend.generate(request)

    await client.aclose()
    assert result.video_path == request.output_path
    assert request.output_path.read_bytes().startswith(b"MOCK-ANYFAST-MP4")
    assert result.task_id is not None


async def test_seedance_validation_failure_and_model_specific_duration_limit() -> None:
    app = create_app()
    headers = {"Authorization": "Bearer mock-anyfast-key"}
    async with _client(app) as client:
        too_short = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={"model": "seedance-2.0", "content": [{"type": "text", "text": "x"}], "duration": 3},
        )
        assert too_short.status_code == 400
        assert too_short.json()["error"]["code"] == "invalid_parameter"

        duplicate_first = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={
                "model": "seedance-2.0",
                "content": [
                    {"type": "image_url", "image_url": {"url": "asset://one"}, "role": "first_frame"},
                    {"type": "image_url", "image_url": {"url": "asset://two"}, "role": "first_frame"},
                ],
                "duration": 5,
            },
        )
        assert duplicate_first.status_code == 400
        assert "first_frame" in duplicate_first.json()["error"]["message"]

        seedance_25 = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={"model": "seedance-2.5", "content": [{"type": "text", "text": "x"}], "duration": 30},
        )
        assert seedance_25.status_code == 200


async def test_mock_failure_and_transient_rate_limit_scenarios() -> None:
    failure_app = create_app(scenario="failure")
    headers = {"Authorization": "Bearer mock-anyfast-key"}
    async with _client(failure_app) as client:
        created = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={"model": "seedance-2.0", "content": [{"type": "text", "text": "blocked"}], "duration": 5},
        )
        task_id = created.json()["task_id"]
        await client.get(f"/v1/video/generations/{task_id}", headers=headers)
        failed = await client.get(f"/v1/video/generations/{task_id}", headers=headers)
        assert failed.json()["data"]["status"] == "FAILURE"
        assert failed.json()["data"]["fail_reason"]

    rate_limit_app = create_app(scenario="rate_limit_once")
    async with _client(rate_limit_app) as client:
        payload = {"model": "seedream-5.0", "prompt": "retry me"}
        first = await client.post("/v1/images/generations", headers=headers, json=payload)
        second = await client.post("/v1/images/generations", headers=headers, json=payload)
        assert first.status_code == 429
        assert first.json()["error"]["code"] == "rate_limited"
        assert second.status_code == 200


async def test_kling_legacy_task_shape_is_available() -> None:
    app = create_app()
    headers = {"Authorization": "Bearer mock-anyfast-key"}
    async with _client(app) as client:
        created = await client.post(
            "/kling/v1/videos/text2video",
            headers=headers,
            json={"model_name": "kling-3.0", "prompt": "a cat runs", "duration": "5", "aspect_ratio": "16:9"},
        )
        assert created.status_code == 200
        task_id = created.json()["task_id"]

        final = None
        for _ in range(3):
            final = await client.get(f"/kling/v1/videos/text2video/{task_id}", headers=headers)
        assert final is not None
        payload = final.json()
        assert payload["data"]["task_status"] == "succeed"
        assert payload["data"]["task_result"]["videos"][0]["url"].endswith(f"{task_id}.mp4")
