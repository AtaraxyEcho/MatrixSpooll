"""
SSE stream for project data changes inside the workspace.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

from fastapi import APIRouter, Depends, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent
from sqlalchemy.ext.asyncio import AsyncSession

from lib.api_errors import BadRequestError, NotFoundError
from lib.db import get_async_session
from server.auth import CurrentUserFlexible
from server.services.project_access import ProjectAccess, resolve_project_access_by_id
from server.services.project_events import ProjectEventService

logger = logging.getLogger(__name__)

# 自带认证端点：本 router 只有项目事件 SSE，EventSource 是浏览器直发请求，
# 浏览器原生 EventSource 带不了 Authorization header，端点内声明 CurrentUserFlexible
# 读取同源 HttpOnly Cookie。
self_auth_router = APIRouter()

PROJECT_EVENTS_SSE_POLL_SECONDS = 1.0


def get_project_event_service(request: Request) -> ProjectEventService:
    return request.app.state.project_event_service


async def _project_event_access(
    project_id: str,
    user: CurrentUserFlexible,
    session: AsyncSession = Depends(get_async_session),
) -> ProjectAccess:
    return await resolve_project_access_by_id(project_id, user, session, required_role="viewer")


@dataclass(frozen=True, slots=True)
class _ProjectEventContext:
    service: ProjectEventService
    project_id: str
    storage_key: str


async def _project_events_service(
    request: Request,
    access: ProjectAccess | None = Depends(_project_event_access),
) -> _ProjectEventContext:
    """Resolve the service and validate the project exists before streaming starts.

    The 404 must be raised here (before the EventSourceResponse begins) — once the
    stream is open, no HTTP status can be returned.
    """
    service = get_project_event_service(request)
    if access is None:
        raise NotFoundError("project_not_found")
    storage_key = access.storage_key or access.project_name
    try:
        await service.prepare_project(access.project_id, storage_key)
    except FileNotFoundError as exc:
        raise NotFoundError("project_not_found", id=access.project_id) from exc
    except ValueError as exc:
        raise BadRequestError("invalid_project_id", id=access.project_id) from exc
    return _ProjectEventContext(service=service, project_id=access.project_id, storage_key=storage_key)


@self_auth_router.get(
    "/projects/{project_id}/events/stream",
    response_class=EventSourceResponse,
)
async def stream_project_events(
    project_id: str,
    request: Request,
    _user: CurrentUserFlexible,
    context: _ProjectEventContext = Depends(_project_events_service),
) -> AsyncIterator[ServerSentEvent]:
    try:
        async with context.service.stream_events(
            context.project_id,
            storage_key=context.storage_key,
            idle_timeout=PROJECT_EVENTS_SSE_POLL_SECONDS,
        ) as stream:
            async for item in stream:
                # 每轮迭代顶部都查断线;_idle 仅作为「队列空闲时也要醒一次」的唤醒兜底,
                # 不再独占断线检测的时机——持续高频事件流下断线一样能立刻发现。
                if await request.is_disconnected():
                    break
                if isinstance(item, dict) and item.get("type") == "_idle":
                    continue
                event_name, payload = item
                yield ServerSentEvent(event=event_name, data=payload)
    except FileNotFoundError:
        # Race: project deleted between the Depends check and stream start. The
        # EventSourceResponse has already begun, so we cannot raise HTTP — log and
        # close the stream cleanly.
        logger.info("项目在订阅前被删除，关闭事件流: %s", project_id)
        return
