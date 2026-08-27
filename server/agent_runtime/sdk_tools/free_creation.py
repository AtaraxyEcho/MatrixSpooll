"""Project-bound SDK tools for direct free creation."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from claude_agent_sdk import tool

from server.agent_runtime.sdk_tools._context import ToolContext, tool_error
from server.services.free_creation_tasks import list_creation_metadata, load_creation_metadata
from server.services.free_creation_workspace import list_reference_uploads

_REFERENCE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["upload", "creation"]},
        "reference_id": {"type": "string"},
        "creation_id": {"type": "string"},
        "version": {"type": "integer", "minimum": 1},
        "role": {
            "type": "string",
            "enum": [
                "first_frame",
                "last_frame",
                "reference_image",
                "reference_video",
                "reference_audio",
                "prompt_context",
            ],
        },
    },
    "required": ["type", "role"],
}


def _require_free_project(ctx: ToolContext) -> None:
    project = ctx.pm.load_project(ctx.project_name)
    if project.get("content_mode") != "free":
        raise ValueError("free creation tools require a project with content_mode=free")


def get_free_creation_options_tool(ctx: ToolContext):
    @tool(
        "get_free_creation_options",
        "读取自由创作当前实际可用的模型能力。选模型、比例、分辨率或时长前调用；返回值是执行层的权威约束。",
        {
            "type": "object",
            "properties": {
                "output_type": {"type": "string", "enum": ["image", "video"]},
                "model": {"type": "string", "description": "可选 provider/model；省略时解析项目默认模型"},
                "reference_kind": {
                    "type": "string",
                    "enum": ["none", "frame", "image", "video", "audio"],
                    "default": "none",
                },
            },
            "required": ["output_type"],
        },
    )
    async def _handler(args: dict[str, Any]) -> dict[str, Any]:
        try:
            _require_free_project(ctx)
            output_type = args.get("output_type")
            if output_type not in {"image", "video"}:
                raise ValueError("output_type must be image or video")
            reference_kind = args.get("reference_kind", "none")
            if reference_kind not in {"none", "frame", "image", "video", "audio"}:
                raise ValueError("invalid reference_kind")
            model = args.get("model")
            if model is not None and not isinstance(model, str):
                raise ValueError("model must be a string")

            # The capability implementation is shared with the HTTP adapter;
            # importing at call time keeps router initialization acyclic.
            from server.routers.free_creations import _get_generation_capabilities

            options = await _get_generation_capabilities(
                output_type=output_type,
                model=model,
                reference_kind=reference_kind,
                project_name=ctx.project_name,
                validate_reference_mode=True,
            )
            return {
                "content": [{"type": "text", "text": json.dumps(options, ensure_ascii=False, indent=2)}],
                "is_error": False,
                "generation_options": options,
            }
        except Exception as exc:  # noqa: BLE001
            return tool_error("get_free_creation_options", exc)

    return _handler


def submit_free_creation_tool(ctx: ToolContext):
    @tool(
        "submit_free_creation",
        "在当前自由创作项目中直接创建图片、视频或图片编辑任务。参数必须来自用户约束与 get_free_creation_options。",
        {
            "type": "object",
            "properties": {
                "output_type": {"type": "string", "enum": ["image", "video", "edit"]},
                "prompt": {"type": "string", "minLength": 1, "maxLength": 10000},
                "references": {"type": "array", "items": _REFERENCE_SCHEMA, "maxItems": 32},
                "aspect_ratio": {"type": "string"},
                "resolution": {"type": "string"},
                "size": {"type": "string"},
                "model": {"type": "string"},
                "quantity": {"type": "integer", "minimum": 1, "maximum": 4, "default": 1},
                "duration_seconds": {"type": "integer", "minimum": 1},
                "parent_creation_id": {"type": "string"},
            },
            "required": ["output_type", "prompt"],
        },
    )
    async def _handler(args: dict[str, Any]) -> dict[str, Any]:
        try:
            _require_free_project(ctx)
            from server.routers.free_creations import FreeCreationRequest, submit_free_creation

            request = FreeCreationRequest.model_validate(args)
            result = await submit_free_creation(
                ctx.project_name,
                request,
                user_id=ctx.actor_user_id,
                source="agent",
            )
            payload = {**result, "status": "queued"}
            created = ", ".join(
                f"{item['creation_id']} (task {item['task_id']})" for item in result.get("creations", [])
            )
            return {
                "content": [{"type": "text", "text": f"已入队：{created}"}],
                "is_error": False,
                "free_creation": payload,
            }
        except Exception as exc:  # noqa: BLE001
            return tool_error("submit_free_creation", exc)

    return _handler


def inspect_free_creation_tool(ctx: ToolContext):
    @tool(
        "inspect_free_creation",
        "查看当前自由创作项目的上传素材与生成产物；可按 creation_id 查询单个任务的终态和失败原因。",
        {
            "type": "object",
            "properties": {
                "creation_id": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 40},
            },
        },
    )
    async def _handler(args: dict[str, Any]) -> dict[str, Any]:
        try:
            _require_free_project(ctx)
            creation_id = args.get("creation_id")
            if creation_id is not None and not isinstance(creation_id, str):
                raise ValueError("creation_id must be a string")
            limit = args.get("limit", 40)
            if not isinstance(limit, int) or not 1 <= limit <= 100:
                raise ValueError("limit must be between 1 and 100")

            if creation_id:
                creation = await asyncio.to_thread(load_creation_metadata, ctx.project_path, creation_id)
                if creation is None:
                    raise ValueError(f"creation not found: {creation_id}")
                payload: dict[str, Any] = {"creation": creation}
            else:
                creations, uploads = await asyncio.gather(
                    asyncio.to_thread(list_creation_metadata, ctx.project_path, limit),
                    asyncio.to_thread(list_reference_uploads, ctx.project_path),
                )
                payload = {"creations": creations, "references": uploads[:limit]}
            return {
                "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
                "is_error": False,
                "free_creation_workspace": payload,
            }
        except Exception as exc:  # noqa: BLE001
            return tool_error("inspect_free_creation", exc)

    return _handler


__all__ = [
    "get_free_creation_options_tool",
    "inspect_free_creation_tool",
    "submit_free_creation_tool",
]
