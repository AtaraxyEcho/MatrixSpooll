import contextlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from lib.api_errors import BadRequestError, NotFoundError
from server.routers import project_events as project_events_router
from server.services.project_access import ProjectAccess

pytestmark = pytest.mark.unit


class _FakeRequest:
    def __init__(self, app, *, disconnect_after: int | None = None):
        """断线检测在循环顶部进行,每次 anext 前都会调用一次 is_disconnected。

        ``disconnect_after`` = None  → 永不断线
        ``disconnect_after`` = N     → 前 N 次返回 False,第 N+1 次起返回 True
        """
        self.app = app
        self._disconnect_after = disconnect_after
        self._calls = 0

    async def is_disconnected(self):
        self._calls += 1
        if self._disconnect_after is None:
            return False
        return self._calls > self._disconnect_after


class _FakePM:
    def get_project_path(self, project_name: str):
        return f"/projects/{project_name}"


class _FakeService:
    def __init__(self):
        self.unsubscribed = False
        self.pm = _FakePM()

    async def prepare_project(self, project_id: str, storage_key: str):
        self.pm.get_project_path(storage_key)

    @contextlib.asynccontextmanager
    async def stream_events(
        self,
        project_name: str,
        *,
        storage_key: str | None = None,
        idle_timeout: float = 1.0,
    ):
        async def _iter():
            yield (
                "snapshot",
                {
                    "project_name": project_name,
                    "fingerprint": "fp-0",
                    "generated_at": "2026-03-01T00:00:00Z",
                },
            )
            yield (
                "changes",
                {
                    "project_name": project_name,
                    "batch_id": "batch-1",
                    "fingerprint": "fp-1",
                    "generated_at": "2026-03-01T00:00:00Z",
                    "source": "filesystem",
                    "changes": [],
                },
            )
            # 之后进入空闲;消费方在 _idle 上轮询 is_disconnected。
            while True:
                yield {"type": "_idle"}

        try:
            yield _iter()
        finally:
            self.unsubscribed = True


def _project_access(project_id: str = "project-uuid", storage_key: str = "demo") -> ProjectAccess:
    return ProjectAccess(
        project_id=project_id,
        project_name="Demo",
        project_path=Path("/projects") / storage_key,
        content_mode="drama",
        generation_mode="storyboard",
        owner_id="owner-uuid",
        role="owner",
        storage_key=storage_key,
    )


@pytest.mark.asyncio
async def test_project_events_service_raises_not_found_when_project_missing():
    """项目不存在(FileNotFoundError)-> NotFoundError,须在流开始前抛出。"""

    class _MissingService:
        async def prepare_project(self, project_id: str, storage_key: str):
            raise FileNotFoundError(storage_key)

    service = _MissingService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    request = _FakeRequest(app)

    with pytest.raises(NotFoundError):
        await project_events_router._project_events_service(request, access=_project_access())


@pytest.mark.asyncio
async def test_project_events_service_raises_bad_request_for_invalid_project_name():
    """非法项目名(路径穿越等,ValueError)-> BadRequestError,而非「不存在」。"""

    class _InvalidIdentityService:
        async def prepare_project(self, project_id: str, storage_key: str):
            raise ValueError(project_id)

    service = _InvalidIdentityService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    request = _FakeRequest(app)

    with pytest.raises(BadRequestError):
        await project_events_router._project_events_service(request, access=_project_access())


@pytest.mark.asyncio
async def test_stream_project_events_emits_snapshot_and_changes():
    service = _FakeService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    request = _FakeRequest(app)

    resolved = await project_events_router._project_events_service(request, access=_project_access())
    assert resolved.service is service
    assert resolved.project_id == "project-uuid"
    assert resolved.storage_key == "demo"

    stream = project_events_router.stream_project_events(
        "project-uuid",
        request,
        _user={"sub": "testuser"},
        context=resolved,
    )

    snapshot_event = await anext(stream)
    changes_event = await anext(stream)
    await stream.aclose()

    assert snapshot_event.event == "snapshot"
    assert snapshot_event.data["fingerprint"] == "fp-0"

    assert changes_event.event == "changes"
    assert changes_event.data["batch_id"] == "batch-1"
    assert service.unsubscribed is True


@pytest.mark.asyncio
async def test_stream_project_events_breaks_on_disconnect_in_idle():
    """空闲期间断线:_idle 哨兵被路由查到断线后 break,流结束并注销。"""
    service = _FakeService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    # 前 2 次 is_disconnected(snapshot 与 changes 的迭代顶部)返回 False,
    # 之后第 3 次起(进入 _idle 阶段)返回 True。
    request = _FakeRequest(app, disconnect_after=2)

    context = project_events_router._ProjectEventContext(service, "project-uuid", "demo")
    stream = project_events_router.stream_project_events(
        "project-uuid", request, _user={"sub": "testuser"}, context=context
    )

    assert (await anext(stream)).event == "snapshot"
    assert (await anext(stream)).event == "changes"
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert service.unsubscribed is True


@pytest.mark.asyncio
async def test_stream_project_events_breaks_on_disconnect_during_continuous_events():
    """持续事件流(无 _idle)期间断线:循环顶部的检测也能立即触发 break。

    回归保护:旧实现把断线检测放在 _idle 分支里,持续 <idle_timeout 间隔的事件流
    会让 _idle 永不触发、断线发现被推迟到事件停歇。新实现每轮迭代顶部都查。
    """

    class _BusyService:
        def __init__(self):
            self.unsubscribed = False
            self.pm = _FakePM()

        @contextlib.asynccontextmanager
        async def stream_events(
            self,
            project_name: str,
            *,
            storage_key: str | None = None,
            idle_timeout: float = 1.0,
        ):
            async def _iter():
                yield ("snapshot", {"project_name": project_name, "fingerprint": "fp-0"})
                # 持续吐真事件,不吐 _idle。
                i = 0
                while True:
                    i += 1
                    yield ("changes", {"batch_id": f"b{i}", "fingerprint": f"fp-{i}"})

            try:
                yield _iter()
            finally:
                self.unsubscribed = True

    service = _BusyService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    # 第 1 次(snapshot 顶部)False,第 2 次(第一条 changes 顶部)起 True。
    request = _FakeRequest(app, disconnect_after=1)

    context = project_events_router._ProjectEventContext(service, "project-uuid", "demo")
    stream = project_events_router.stream_project_events(
        "project-uuid", request, _user={"sub": "testuser"}, context=context
    )

    # snapshot 通过(第 1 次 is_disconnected 返回 False)
    assert (await anext(stream)).event == "snapshot"
    # 下一轮迭代顶部的检测命中断线 → break,即使后面 _iter() 还在持续吐 changes。
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert service.unsubscribed is True


@pytest.mark.asyncio
async def test_stream_project_events_ends_naturally_after_project_deleted_event():
    """终止事件（project_deleted）之后流自然结束——非因客户端断线，路由层原样透传该事件。

    ``_FakeRequest`` 永不断线（``disconnect_after=None``），流的结束只能来自
    service 侧 ``_iter()`` 在终止事件后主动 return，验证路由层对该事件不作特殊拦截。
    """

    class _DeletedService:
        def __init__(self):
            self.unsubscribed = False
            self.pm = _FakePM()

        @contextlib.asynccontextmanager
        async def stream_events(
            self,
            project_name: str,
            *,
            storage_key: str | None = None,
            idle_timeout: float = 1.0,
        ):
            async def _iter():
                yield ("snapshot", {"project_name": project_name, "fingerprint": "fp-0"})
                yield ("project_deleted", {"project_name": project_name})

            try:
                yield _iter()
            finally:
                self.unsubscribed = True

    service = _DeletedService()
    app = SimpleNamespace(state=SimpleNamespace(project_event_service=service))
    request = _FakeRequest(app)

    context = project_events_router._ProjectEventContext(service, "project-uuid", "demo")
    stream = project_events_router.stream_project_events(
        "project-uuid", request, _user={"sub": "testuser"}, context=context
    )

    assert (await anext(stream)).event == "snapshot"
    deleted_event = await anext(stream)
    assert deleted_event.event == "project_deleted"
    assert deleted_event.data == {"project_name": "project-uuid"}

    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert service.unsubscribed is True
