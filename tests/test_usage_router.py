from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from lib.db.base import Base
from lib.db.models.project import ProjectRegistry
from lib.db.models.user import User
from lib.db.repositories.usage_repo import SettlementInput, UsageRepository
from lib.project_manager import get_project_manager
from server.auth import CurrentUserInfo, get_current_user
from server.routers import usage
from tests.auth_deps import AUTH_DEPENDENCIES

pytestmark = pytest.mark.unit


@pytest.fixture
async def _usage_env(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    user_id = str(uuid4())
    project_specs = [("demo", str(uuid4()), uuid4().hex), ("demo2", str(uuid4()), uuid4().hex)]
    manager = get_project_manager()
    for _name, _project_id, storage_key in project_specs:
        manager.create_project(storage_key)

    async with factory() as session:
        session.add(User(id=user_id, username="testuser", role="admin", is_active=True))
        session.add_all(
            ProjectRegistry(id=project_id, name=name, storage_key=storage_key, owner_id=user_id)
            for name, project_id, storage_key in project_specs
        )
        await session.commit()
        repo = UsageRepository(session)
        cid1 = await repo.start_call(project_name="demo", call_type="image", model="gemini-3.1-flash-image-preview")
        await repo.finish_call(cid1, status="success", settlement=SettlementInput())
        cid2 = await repo.start_call(project_name="demo", call_type="video", model="veo-3")
        await repo.finish_call(cid2, status="success", settlement=SettlementInput())
        cid3 = await repo.start_call(project_name="demo", call_type="video", model="veo-3")
        await repo.finish_call(cid3, status="success", settlement=SettlementInput())
        cid4 = await repo.start_call(project_name="demo2", call_type="image", model="gemini-3.1-flash-image-preview")
        await repo.finish_call(cid4, status="success", settlement=SettlementInput())

    monkeypatch.setattr(usage, "async_session_factory", factory)
    monkeypatch.setattr(usage, "database_auth_initialized", lambda: True)

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id=user_id, sub="testuser", role="admin")
    app.include_router(usage.router, prefix="/api/v1", dependencies=AUTH_DEPENDENCIES)

    yield TestClient(app)
    await engine.dispose()


class TestUsageRouter:
    def test_usage_endpoints(self, _usage_env):
        client = _usage_env
        stats = client.get("/api/v1/usage/stats?project_name=demo")
        assert stats.status_code == 200
        assert stats.json()["total_count"] == 3

        calls = client.get("/api/v1/usage/calls?page=1&page_size=10")
        assert calls.status_code == 200
        assert calls.json()["page"] == 1
        assert calls.json()["page_size"] == 10
        assert calls.json()["total"] == 4

        projects = client.get("/api/v1/usage/projects")
        assert projects.status_code == 200
        assert set(projects.json()["projects"]) == {"demo", "demo2"}
