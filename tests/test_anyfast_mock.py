"""Contract tests for the local AnyFast mock service."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import urlsplit

import httpx
import pytest

from lib.resource_paths import resource_relative_path
from lib.version_manager import VersionManager
from lib.video_backends.anyfast import AnyFastSeedanceBackend
from lib.video_backends.base import VideoGenerationRequest
from scripts.mock_anyfast import create_app
from server.services import free_creation_tasks as free_creation_tasks_module
from server.services.free_creation_tasks import execute_free_video_task, load_creation_metadata


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


@pytest.mark.unit
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
            json={"model": "seedream-5.0", "prompt": "a red kite", "n": 3},
        )
        assert image.status_code == 200
        assert len(image.json()["data"]) == 3
        assert image.json()["data"][0]["b64_json"].startswith("iVBORw0KGgo")

        audio = await client.post(
            "/v1/audio/speech",
            headers=headers,
            json={"model": "mock-tts", "input": "hello", "voice": "alloy", "response_format": "wav"},
        )
        assert audio.status_code == 200
        assert audio.headers["content-type"].startswith("audio/wav")
        assert audio.content.startswith(b"RIFF")


@pytest.mark.unit
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
        assert media.content[4:8] == b"ftyp"


@pytest.mark.integration
async def test_anyfast_video_adapter_can_run_against_the_mock_without_network(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    backend = AnyFastSeedanceBackend(
        api_key="mock-anyfast-key",
        base_url="http://testserver",
        model="seedance-2.0",
        transport=transport,
        poll_interval_seconds=0,
    )
    persist_job = AsyncMock()
    monkeypatch.setattr(backend, "_persist_provider_job_id", persist_job)
    request = VideoGenerationRequest(
        prompt="a character walks through rain",
        output_path=tmp_path / "mock.mp4",
        aspect_ratio="16:9",
        resolution="720p",
        duration_seconds=5,
    )

    result = await backend.generate(request)
    assert result.video_path == request.output_path
    assert request.output_path.read_bytes()[4:8] == b"ftyp"
    assert result.task_id is not None
    assert persist_job.await_args is not None
    assert persist_job.await_args.kwargs["endpoint"] == "http://testserver"


@pytest.mark.integration
async def test_free_creation_execution_preserves_roles_and_commits_mock_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = create_app()
    backend = AnyFastSeedanceBackend(
        api_key="mock-anyfast-key",
        base_url="http://testserver",
        model="seedance-2.0",
        transport=httpx.ASGITransport(app=app),
        poll_interval_seconds=0,
    )
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "frame.png").write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
    )
    (uploads / "voice.wav").write_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt ")

    class ProjectManager:
        def load_project(self, _project_name: str) -> dict[str, str]:
            return {"content_mode": "free", "aspect_ratio": "16:9"}

        def get_project_path(self, _project_name: str) -> Path:
            return tmp_path

    class AdapterGenerator:
        async def generate_video_async(self, **kwargs):
            output_path = tmp_path / resource_relative_path(kwargs["resource_type"], kwargs["resource_id"])
            result = await backend.generate(
                VideoGenerationRequest(
                    prompt=kwargs["prompt"],
                    output_path=output_path,
                    aspect_ratio=kwargs["aspect_ratio"],
                    duration_seconds=kwargs["duration_seconds"],
                    resolution=kwargs["resolution"],
                    start_image=kwargs["start_image"],
                    end_image=kwargs["end_image"],
                    reference_images=kwargs["reference_images"],
                    reference_videos=kwargs["reference_videos"],
                    reference_audio_files=kwargs["reference_audio_files"],
                )
            )
            version = VersionManager(tmp_path).add_version(
                kwargs["resource_type"],
                kwargs["resource_id"],
                kwargs["prompt"],
                source_file=output_path,
                aspect_ratio=kwargs["aspect_ratio"],
                duration_seconds=kwargs["duration_seconds"],
            )
            return output_path, version, None, result.video_uri

    async def resolve_context(*_args, **kwargs):
        assert kwargs.get("video") is not None
        return SimpleNamespace(
            generator=AdapterGenerator(),
            video=SimpleNamespace(
                provider_model=SimpleNamespace(provider_id="custom-anyfast"),
                backend_model="seedance-2.0",
                resolution="720p",
            ),
        )

    monkeypatch.setattr(free_creation_tasks_module, "get_project_manager", lambda: ProjectManager())
    monkeypatch.setattr(free_creation_tasks_module, "resolve_generation_context", resolve_context)

    first_frame_id = "c_0123456789abcdef0123"
    first_frame = await execute_free_video_task(
        "demo",
        first_frame_id,
        {
            "prompt": "A train arrives in rain",
            "references": ["uploads/frame.png"],
            "reference_claims": [{"role": "first_frame"}],
            "effective_mode": "first_frame",
            "aspect_ratio": "16:9",
            "resolution": "720p",
            "duration_seconds": 5,
        },
        user_id="user-1",
    )
    assert first_frame["version"] == 1
    assert load_creation_metadata(tmp_path, first_frame_id) == first_frame
    assert (tmp_path / first_frame["media_path"]).read_bytes()[4:8] == b"ftyp"

    reference_id = "c_0123456789abcdef0124"
    references = await execute_free_video_task(
        "demo",
        reference_id,
        {
            "prompt": "Keep the same character and voice",
            "references": ["uploads/frame.png", "uploads/voice.wav"],
            "reference_claims": [{"role": "reference_image"}, {"role": "reference_audio"}],
            "effective_mode": "reference_image",
            "aspect_ratio": "16:9",
            "resolution": "720p",
            "duration_seconds": 5,
        },
        user_id="user-1",
    )
    assert references["version"] == 1
    assert load_creation_metadata(tmp_path, reference_id) == references

    tasks = list(app.state.mock_state.tasks.values())
    assert [[item.get("role") for item in task.payload["content"] if item.get("role")] for task in tasks] == [
        ["first_frame"],
        ["reference_image", "reference_audio"],
    ]


@pytest.mark.unit
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


@pytest.mark.unit
async def test_seedance_rejects_unknown_roles_invalid_order_and_mixed_modes() -> None:
    app = create_app()
    headers = {"Authorization": "Bearer mock-anyfast-key"}
    async with _client(app) as client:
        unknown_role = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={
                "model": "seedance-2.0",
                "content": [{"type": "image_url", "image_url": {"url": "asset://one"}, "role": "thumbnail"}],
            },
        )
        assert unknown_role.status_code == 400

        invalid_order = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={
                "model": "seedance-2.0",
                "content": [
                    {"type": "audio_url", "audio_url": {"url": "asset://voice"}, "role": "reference_audio"},
                    {"type": "image_url", "image_url": {"url": "asset://one"}, "role": "reference_image"},
                ],
            },
        )
        assert invalid_order.status_code == 400

        mixed_modes = await client.post(
            "/v1/video/generations",
            headers=headers,
            json={
                "model": "seedance-2.0",
                "content": [
                    {"type": "image_url", "image_url": {"url": "asset://one"}, "role": "first_frame"},
                    {"type": "image_url", "image_url": {"url": "asset://two"}, "role": "reference_image"},
                ],
            },
        )
        assert mixed_modes.status_code == 400


@pytest.mark.unit
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


@pytest.mark.unit
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
        assert created.json()["data"]["task_id"] == task_id

        final = None
        for _ in range(3):
            final = await client.get(f"/kling/v1/videos/text2video/{task_id}", headers=headers)
        assert final is not None
        payload = final.json()
        assert payload["data"]["task_status"] == "succeed"
        assert payload["data"]["task_result"]["videos"][0]["url"].endswith(f"{task_id}.mp4")
