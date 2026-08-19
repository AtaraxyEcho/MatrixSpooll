"""Local AnyFast-compatible mock service for cost-free development checks.

The mock intentionally mirrors the documented HTTP envelopes instead of the
internal ArcReel backend objects. It is safe to run locally and never calls an
external provider.

Run with::

    uv run uvicorn scripts.mock_anyfast:app --port 1242

Use ``create_app`` from tests to mount the same service through an ASGI
transport without opening a socket.
"""

from __future__ import annotations

import base64
import os
import struct
import time
from dataclasses import dataclass
from itertools import count
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

DEFAULT_API_KEY = "mock-anyfast-key"
DEFAULT_SCENARIO = "success"

# A valid 1x1 RGB PNG. Returning b64_json exercises the same branch as an
# OpenAI-compatible image response without requiring a second download call.
_PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00"
    b"\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00"
    b"\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
)

# A short PCM WAV payload for the OpenAI-compatible speech endpoint.
_WAV_PCM = b"\x00\x00" * 80
_WAV_BYTES = (
    b"RIFF"
    + struct.pack("<I", 36 + len(_WAV_PCM))
    + b"WAVEfmt "
    + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16)
    + b"data"
    + struct.pack("<I", len(_WAV_PCM))
    + _WAV_PCM
)

# The mock models transport and lifecycle behavior. Media consumers should
# treat this as an opaque deterministic fixture; production media validation
# remains the responsibility of the selected provider.
_VIDEO_BYTES = b"MOCK-ANYFAST-MP4\x00"


@dataclass
class _Task:
    task_id: str
    model: str
    kind: str
    payload: dict[str, Any]
    scenario: str
    polls: int = 0
    created_at: int = 0


class _MockState:
    def __init__(self, *, api_key: str, scenario: str) -> None:
        self.api_key = api_key
        self.scenario = scenario
        self.tasks: dict[str, _Task] = {}
        self._sequence = count(1)
        self._rate_limit_seen = False

    def task_scenario(self, payload: dict[str, Any]) -> str:
        explicit = payload.get("mock_scenario")
        if isinstance(explicit, str) and explicit:
            return explicit
        prompt = payload.get("prompt")
        if isinstance(prompt, str):
            for name in ("rate_limit_once", "failure", "server_error", "bad_request"):
                if f"[mock:{name}]" in prompt:
                    return name
        return self.scenario

    def controlled_error(self, payload: dict[str, Any]) -> JSONResponse | None:
        scenario = self.task_scenario(payload)
        if scenario == "rate_limit_once" and not self._rate_limit_seen:
            self._rate_limit_seen = True
            return _error_response(429, "rate_limited", "mock rate limit; retry the request")
        if scenario == "server_error":
            return _error_response(500, "mock_upstream_error", "mock upstream failure")
        if scenario == "bad_request":
            return _error_response(400, "invalid_request", "mock rejected the request")
        return None

    def create_task(self, *, model: str, kind: str, payload: dict[str, Any]) -> _Task:
        task_id = f"asynmock_{next(self._sequence):06d}"
        task = _Task(
            task_id=task_id,
            model=model,
            kind=kind,
            payload=payload,
            scenario=self.task_scenario(payload),
            created_at=int(time.time()),
        )
        self.tasks[task_id] = task
        return task


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"message": message, "type": "mock_error", "code": code}},
    )


def _auth_error(request: Request, state: _MockState) -> JSONResponse | None:
    expected = f"Bearer {state.api_key}"
    if request.headers.get("authorization") != expected:
        return _error_response(401, "invalid_api_key", "Invalid API key")
    return None


async def _json_body(request: Request) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    try:
        body = await request.json()
    except ValueError:
        return None, _error_response(400, "invalid_json", "Request body must be valid JSON")
    if not isinstance(body, dict):
        return None, _error_response(400, "invalid_request", "Request body must be a JSON object")
    return body, None


def _content_roles(body: dict[str, Any]) -> list[str]:
    roles: list[str] = []
    content = body.get("content")
    if not isinstance(content, list):
        return roles
    for item in content:
        if isinstance(item, dict) and isinstance(item.get("role"), str):
            roles.append(item["role"])
    return roles


def _validate_seedance_request(body: dict[str, Any]) -> str | None:
    model = body.get("model")
    content = body.get("content")
    if not isinstance(model, str) or not model:
        return "model is required"
    if not isinstance(content, list) or not content:
        # The generic /v1 endpoint also documents prompt-based model payloads
        # (for example Wan). Accept that shape so the mock can exercise both
        # AnyFast's Seedance contract and ArcReel's compatible video adapter.
        if not isinstance(body.get("prompt"), str) or not body["prompt"].strip():
            return "content must be a non-empty array"
        content = [{"type": "text", "text": body["prompt"]}]
    if not any(isinstance(item, dict) and item.get("type") == "text" for item in content):
        # AnyFast permits image/video-only requests for some models. The mock
        # accepts those as long as there is at least one typed content item.
        if not all(
            isinstance(item, dict) and item.get("type") in {"image_url", "video_url", "audio_url"} for item in content
        ):
            return "content contains an unsupported item"

    try:
        duration = int(body.get("duration", 5))
    except (TypeError, ValueError):
        return "duration must be an integer"
    maximum = 30 if "2.5" in model.lower() else 15
    if duration < 4 or duration > maximum:
        return f"duration must be between 4 and {maximum} seconds"

    ratio = body.get("ratio", "adaptive")
    if ratio not in {"adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"}:
        return "ratio is not supported"
    resolution = body.get("resolution", "720p")
    if resolution not in {"480p", "720p", "1080p", "2k", "4k"}:
        return "resolution is not supported"

    roles = _content_roles(body)
    for role in ("first_frame", "last_frame"):
        if roles.count(role) > 1:
            return f"only one {role} is allowed"
    return None


def _seedance_status(task: _Task) -> tuple[str, int, str]:
    task.polls += 1
    if task.scenario == "failure" and task.polls >= 2:
        return "FAILURE", 100, "mock moderation failure"
    if task.polls <= 1:
        return "NOT_START", 0, ""
    if task.polls == 2:
        return "IN_PROGRESS", 50, ""
    return "SUCCESS", 100, ""


def _seedance_result(task: _Task, request: Request, status: str, progress: int, fail_reason: str) -> dict[str, Any]:
    result_url = f"{str(request.base_url).rstrip('/')}/mock/media/{task.task_id}.mp4"
    data: dict[str, Any] = {
        "task_id": task.task_id,
        "action": "generate",
        "status": status,
        "result_url": result_url if status == "SUCCESS" else "",
        "fail_reason": fail_reason,
        "submit_time": task.created_at,
        "start_time": task.created_at if status != "NOT_START" else 0,
        "finish_time": int(time.time()) if status in {"SUCCESS", "FAILURE"} else 0,
        "progress": f"{progress}%",
        "request_id": f"mock-request-{task.task_id}",
        "data": {
            "content": {"video_url": result_url} if status == "SUCCESS" else {},
            "id": task.task_id,
            "model": task.model,
            "duration": int(task.payload.get("duration", 5)),
            "ratio": task.payload.get("ratio", "adaptive"),
            "resolution": task.payload.get("resolution", "720p"),
            "framespersecond": 24,
            "generate_audio": bool(task.payload.get("generate_audio", True)),
            "status": "succeeded" if status == "SUCCESS" else "failed" if status == "FAILURE" else "running",
            "usage": {"completion_tokens": 0, "total_tokens": 0},
        },
    }
    return {"code": "success", "message": "", "data": data}


def create_app(*, api_key: str = DEFAULT_API_KEY, scenario: str | None = None) -> FastAPI:
    """Create an isolated mock app for a local process or ASGI tests."""

    state = _MockState(api_key=api_key, scenario=scenario or DEFAULT_SCENARIO)
    app = FastAPI(title="AnyFast local mock", docs_url="/docs")
    app.state.mock_state = state

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request) -> Response:
        if (error := _auth_error(request, state)) is not None:
            return error
        body, error = await _json_body(request)
        if error is not None or body is None:
            return error or _error_response(400, "invalid_request", "invalid body")
        if (error := state.controlled_error(body)) is not None:
            return error
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return _error_response(400, "invalid_request", "messages is required")
        last = messages[-1] if isinstance(messages[-1], dict) else {}
        prompt = last.get("content", "")
        if not isinstance(prompt, str):
            prompt = "multimodal request"
        model = str(body.get("model") or "mock-chat")
        return JSONResponse(
            {
                "id": "chatcmpl-mock-000001",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": f"Mock response: {prompt}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": len(prompt), "completion_tokens": 4, "total_tokens": len(prompt) + 4},
            }
        )

    @app.post("/v1/images/generations")
    async def image_generations(request: Request) -> Response:
        if (error := _auth_error(request, state)) is not None:
            return error
        body, error = await _json_body(request)
        if error is not None or body is None:
            return error or _error_response(400, "invalid_request", "invalid body")
        if (error := state.controlled_error(body)) is not None:
            return error
        if not isinstance(body.get("prompt"), str) or not body["prompt"].strip():
            return _error_response(400, "invalid_request", "prompt is required")
        return JSONResponse(
            {
                "created": int(time.time()),
                "data": [{"b64_json": base64.b64encode(_PNG_BYTES).decode("ascii")}],
            }
        )

    @app.post("/v1/audio/speech")
    async def audio_speech(request: Request) -> Response:
        if (error := _auth_error(request, state)) is not None:
            return error
        body, error = await _json_body(request)
        if error is not None or body is None:
            return error or _error_response(400, "invalid_request", "invalid body")
        if (error := state.controlled_error(body)) is not None:
            return error
        if not isinstance(body.get("input"), str) or not body["input"].strip():
            return _error_response(400, "invalid_request", "input is required")
        return Response(content=_WAV_BYTES, media_type="audio/wav")

    @app.post("/v1/video/generations")
    async def video_generations(request: Request) -> Response:
        if (error := _auth_error(request, state)) is not None:
            return error
        body, error = await _json_body(request)
        if error is not None or body is None:
            return error or _error_response(400, "invalid_request", "invalid body")
        if (error := state.controlled_error(body)) is not None:
            return error
        validation_error = _validate_seedance_request(body)
        if validation_error:
            return _error_response(400, "invalid_parameter", validation_error)
        task = state.create_task(model=str(body["model"]), kind="seedance", payload=body)
        return JSONResponse(
            {
                "id": task.task_id,
                "task_id": task.task_id,
                "object": "video",
                "model": task.model,
                "status": "",
                "progress": 0,
                "created_at": task.created_at,
            }
        )

    @app.get("/v1/video/generations/{task_id}")
    async def video_generation_status(task_id: str, request: Request) -> Response:
        if (error := _auth_error(request, state)) is not None:
            return error
        task = state.tasks.get(task_id)
        if task is None:
            return _error_response(404, "task_not_found", "video generation task not found")
        status, progress, fail_reason = _seedance_status(task)
        return JSONResponse(_seedance_result(task, request, status, progress, fail_reason))

    async def kling_create(request: Request, endpoint: str) -> Response:
        if (error := _auth_error(request, state)) is not None:
            return error
        body, error = await _json_body(request)
        if error is not None or body is None:
            return error or _error_response(400, "invalid_request", "invalid body")
        if (error := state.controlled_error(body)) is not None:
            return error
        if not isinstance(body.get("prompt"), str) or not body["prompt"].strip():
            return _error_response(400, "invalid_request", "prompt is required")
        task = state.create_task(
            model=str(body.get("model_name") or "kling-3.0"), kind=f"kling:{endpoint}", payload=body
        )
        return JSONResponse(
            {
                "id": task.task_id,
                "task_id": task.task_id,
                "object": "video",
                "model": task.model,
                "status": "",
                "progress": 0,
                "created_at": task.created_at,
            }
        )

    def _kling_handler(endpoint: str):
        async def handler(request: Request) -> Response:
            return await kling_create(request, endpoint)

        return handler

    for _endpoint in ("text2video", "image2video", "multi-image2video"):
        app.add_api_route(
            f"/kling/v1/videos/{_endpoint}",
            _kling_handler(_endpoint),
            methods=["POST"],
        )

    @app.get("/kling/v1/videos/{endpoint}/{task_id}")
    async def kling_status(endpoint: str, task_id: str, request: Request) -> Response:
        if (error := _auth_error(request, state)) is not None:
            return error
        task = state.tasks.get(task_id)
        if task is None or task.kind != f"kling:{endpoint}":
            return _error_response(404, "task_not_found", "video generation task not found")
        task.polls += 1
        failed = task.scenario == "failure" and task.polls >= 2
        terminal = task.polls >= 3 or failed
        url = f"{str(request.base_url).rstrip('/')}/mock/media/{task.task_id}.mp4"
        data: dict[str, Any] = {
            "task_id": task.task_id,
            "task_status": "failed" if failed else "succeed" if terminal else "processing",
            "task_status_msg": "mock failure" if failed else "",
        }
        if terminal and not failed:
            data["task_result"] = {"videos": [{"url": url}]}
        return JSONResponse({"code": 0, "message": "", "data": data})

    @app.get("/mock/media/{media_name}")
    async def media(media_name: str) -> Response:
        if media_name.endswith(".png"):
            return Response(content=_PNG_BYTES, media_type="image/png")
        if media_name.endswith(".wav"):
            return Response(content=_WAV_BYTES, media_type="audio/wav")
        if media_name.endswith(".mp4"):
            return Response(content=_VIDEO_BYTES, media_type="video/mp4")
        return _error_response(404, "media_not_found", "mock media not found")

    return app


app = create_app(
    api_key=os.getenv("ARCREEL_MOCK_ANYFAST_API_KEY", DEFAULT_API_KEY),
    scenario=os.getenv("ARCREEL_MOCK_ANYFAST_SCENARIO", DEFAULT_SCENARIO),
)
