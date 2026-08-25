"""Smoke tests for task router endpoints against a real generation queue."""

from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from lib.db import get_async_session
from lib.db.models.project import ProjectRegistry
from lib.db.models.user import User
from lib.project_manager import get_project_manager
from server.auth import CurrentUserInfo, get_current_user, get_current_user_flexible
from server.routers import tasks as tasks_router
from tests.auth_deps import AUTH_DEPENDENCIES

pytestmark = pytest.mark.unit


def _build_app(session_factory, *, user_id: str):
    app = FastAPI()
    current_user = CurrentUserInfo(id=user_id, sub="testuser", role="admin")
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_current_user_flexible] = lambda: CurrentUserInfo(
        id=user_id, sub="testuser", role="admin"
    )

    async def _get_test_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_async_session] = _get_test_session
    app.include_router(tasks_router.router, prefix="/api/v1", dependencies=AUTH_DEPENDENCIES)
    return app


class TestTaskRouterEndpoints:
    async def test_task_router_endpoints_after_enqueue_claim_fail(self, generation_queue):
        queue = generation_queue
        session_factory = queue._session_factory  # noqa: SLF001 - queue fixture owns the shared in-memory database
        user_id = str(uuid4())
        project_id = str(uuid4())
        storage_key = uuid4().hex
        get_project_manager().create_project(storage_key)
        async with session_factory() as session:
            session.add(User(id=user_id, username="testuser", role="admin", is_active=True))
            session.add(
                ProjectRegistry(
                    id=project_id,
                    name="demo",
                    storage_key=storage_key,
                    owner_id=user_id,
                )
            )
            await session.commit()

        task = await queue.enqueue_task(
            project_name="demo",
            task_type="storyboard",
            media_type="image",
            resource_id="E1S01",
            payload={"prompt": "p"},
            script_file="episode_01.json",
            source="webui",
        )
        await queue.claim_next_task(media_type="image")
        await queue.mark_task_failed(task["task_id"], "mock fail")

        app = _build_app(session_factory, user_id=user_id)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            task_resp = await client.get(f"/api/v1/tasks/{task['task_id']}")
            assert task_resp.status_code == 200
            assert task_resp.json()["task"]["status"] == "failed"

            list_resp = await client.get("/api/v1/tasks?project_name=demo")
            assert list_resp.status_code == 200
            assert list_resp.json()["total"] >= 1

            stats_resp = await client.get("/api/v1/tasks/stats?project_name=demo")
            assert stats_resp.status_code == 200
            stats = stats_resp.json()["stats"]
            assert stats["failed"] == 1
