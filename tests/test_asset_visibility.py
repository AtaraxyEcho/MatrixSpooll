"""全局资产库可见性测试：列表、详情、复制、文件直链四层同一判定。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from lib.db import get_async_session
from lib.db.base import Base, utc_now
from lib.db.models.asset import ASSET_VISIBILITY_PRIVATE, ASSET_VISIBILITY_SHARED, Asset
from lib.db.models.project import ProjectRegistry
from lib.project_manager import ProjectManager
from server.auth import CurrentUserInfo, get_current_user
from server.error_handlers import register_error_handlers
from server.routers import assets, files
from tests.auth_deps import AUTH_DEPENDENCIES

pytestmark = pytest.mark.unit

USER_A = CurrentUserInfo(id="user-a", sub="alice", role="member")
USER_B = CurrentUserInfo(id="user-b", sub="bob", role="member")
ADMIN = CurrentUserInfo(id="admin-1", sub="root", role="admin", is_superadmin=True)


@pytest_asyncio.fixture
async def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[dict]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    pm = ProjectManager(tmp_path / "projects")
    monkeypatch.setattr(assets, "async_session_factory", factory)
    monkeypatch.setattr(files, "async_session_factory", factory)
    monkeypatch.setattr(assets, "get_project_manager", lambda: pm)
    monkeypatch.setattr(files, "get_project_manager", lambda: pm)
    # project_access / files 里各自 import 了 get_project_manager，直接换掉单例本体，
    # 否则项目路径校验会落到真实 data 目录上，测试里的临时项目一律 404。
    monkeypatch.setattr("lib.project_manager._project_manager", pm)

    current: dict[str, CurrentUserInfo] = {"user": USER_A}

    async def _session():
        async with factory() as session:
            yield session
            await session.commit()

    app = FastAPI()
    register_error_handlers(app)
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    app.dependency_overrides[files._get_project_file_user] = lambda: current["user"]
    app.dependency_overrides[get_async_session] = _session
    app.include_router(assets.router, prefix="/api/v1", dependencies=AUTH_DEPENDENCIES)
    app.include_router(files.public_router, prefix="/api/v1", tags=["files"])

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield {"client": client, "factory": factory, "pm": pm, "current": current}
    await engine.dispose()


async def _seed_asset(
    factory,
    *,
    asset_id: str,
    name: str,
    owner_id: str | None,
    visibility: str = ASSET_VISIBILITY_SHARED,
    image_path: str | None = None,
    source_project_id: str | None = None,
) -> str:
    async with factory() as session:
        session.add(
            Asset(
                id=asset_id,
                type="character",
                name=name,
                description=f"{name} 的描述",
                voice_style="",
                image_path=image_path,
                source_project_id=source_project_id,
                owner_user_id=owner_id,
                visibility=visibility,
            )
        )
        await session.commit()
    return asset_id


async def _seed_registry(factory, *, project_id: str, name: str, storage_key: str, owner_id: str) -> None:
    async with factory() as session:
        now = utc_now()
        session.add(
            ProjectRegistry(
                id=project_id,
                name=name,
                storage_key=storage_key,
                owner_id=owner_id,
                created_at=now,
                updated_at=now,
            )
        )
        await session.commit()


async def test_list_hides_other_users_private_assets(env) -> None:
    client = env["client"]
    await _seed_asset(
        env["factory"],
        asset_id="a-private-b",
        name="私有角色",
        owner_id=USER_B.id,
        visibility=ASSET_VISIBILITY_PRIVATE,
    )
    await _seed_asset(
        env["factory"],
        asset_id="a-shared-b",
        name="共享角色",
        owner_id=USER_B.id,
        visibility=ASSET_VISIBILITY_SHARED,
    )
    await _seed_asset(
        env["factory"],
        asset_id="a-mine",
        name="我的角色",
        owner_id=USER_A.id,
        visibility=ASSET_VISIBILITY_PRIVATE,
    )

    env["current"]["user"] = USER_A
    resp = await client.get("/api/v1/assets", params={"type": "character"})
    assert resp.status_code == 200
    names = {item["name"] for item in resp.json()["items"]}
    assert names == {"共享角色", "我的角色"}


async def test_get_invisible_asset_returns_404(env) -> None:
    await _seed_asset(
        env["factory"],
        asset_id="a-private-b",
        name="他人私有",
        owner_id=USER_B.id,
        visibility=ASSET_VISIBILITY_PRIVATE,
    )
    env["current"]["user"] = USER_A
    resp = await env["client"].get("/api/v1/assets/a-private-b")
    assert resp.status_code == 404


async def test_scope_filter_splits_mine_and_shared(env) -> None:
    await _seed_asset(env["factory"], asset_id="a-shared-b", name="共享", owner_id=USER_B.id)
    await _seed_asset(
        env["factory"],
        asset_id="a-mine",
        name="我的",
        owner_id=USER_A.id,
        visibility=ASSET_VISIBILITY_PRIVATE,
    )
    env["current"]["user"] = USER_A

    mine = await env["client"].get("/api/v1/assets", params={"scope": "mine"})
    shared = await env["client"].get("/api/v1/assets", params={"scope": "shared"})
    assert {i["name"] for i in mine.json()["items"]} == {"我的"}
    assert {i["name"] for i in shared.json()["items"]} == {"共享"}


async def test_legacy_asset_without_owner_is_visible(env) -> None:
    await _seed_asset(
        env["factory"],
        asset_id="a-legacy",
        name="存量素材",
        owner_id=None,
        visibility=ASSET_VISIBILITY_PRIVATE,
    )
    env["current"]["user"] = USER_A
    resp = await env["client"].get("/api/v1/assets/a-legacy")
    assert resp.status_code == 200


async def test_admin_sees_private_assets_of_others(env) -> None:
    await _seed_asset(
        env["factory"],
        asset_id="a-private-b",
        name="他人私有",
        owner_id=USER_B.id,
        visibility=ASSET_VISIBILITY_PRIVATE,
    )
    env["current"]["user"] = ADMIN
    resp = await env["client"].get("/api/v1/assets/a-private-b")
    assert resp.status_code == 200


async def test_apply_to_project_refuses_invisible_asset(env) -> None:
    """知道 asset id 也不能把他人私有资产拷进自己的项目。"""

    pm: ProjectManager = env["pm"]
    pm.create_project("target")
    pm.create_project_metadata("target", "Target")
    await _seed_registry(
        env["factory"],
        project_id="proj-target",
        name="target",
        storage_key="target",
        owner_id=USER_A.id,
    )
    await _seed_asset(
        env["factory"],
        asset_id="a-private-b",
        name="他人私有",
        owner_id=USER_B.id,
        visibility=ASSET_VISIBILITY_PRIVATE,
    )

    env["current"]["user"] = USER_A
    resp = await env["client"].post(
        "/api/v1/assets/apply-to-project",
        json={
            "asset_ids": ["a-private-b"],
            "target_project": "target",
            "conflict_policy": "skip",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["succeeded"] == []
    assert [item["id"] for item in body["failed"]] == ["a-private-b"]
    assert pm.load_project("target").get("characters", {}) == {}


async def test_create_asset_rejects_invalid_visibility(env) -> None:
    env["current"]["user"] = USER_A
    resp = await env["client"].post(
        "/api/v1/assets",
        data={"type": "character", "name": "非法可见性", "visibility": "everyone"},
    )
    assert resp.status_code == 400


async def test_create_asset_defaults_to_shared(env) -> None:
    env["current"]["user"] = USER_A
    created = await env["client"].post("/api/v1/assets", data={"type": "character", "name": "默认共享"})
    assert created.status_code == 200, created.text
    asset_id = created.json()["asset"]["id"]

    env["current"]["user"] = USER_B
    resp = await env["client"].get(f"/api/v1/assets/{asset_id}")
    assert resp.status_code == 200


async def test_global_asset_file_requires_visibility(env) -> None:
    """过滤了元数据却放开文件直链等于没隔离。"""

    pm: ProjectManager = env["pm"]
    root = pm.get_global_assets_root() / "character"
    root.mkdir(parents=True, exist_ok=True)
    filename = "deadbeef.png"
    (root / filename).write_bytes(b"\x89PNG\r\n\x1a\n")

    await _seed_asset(
        env["factory"],
        asset_id="a-private-b",
        name="他人私有",
        owner_id=USER_B.id,
        visibility=ASSET_VISIBILITY_PRIVATE,
        image_path=f"_global_assets/character/{filename}",
    )

    env["current"]["user"] = USER_A
    denied = await env["client"].get(f"/api/v1/global-assets/character/{filename}")
    assert denied.status_code == 404

    env["current"]["user"] = USER_B
    allowed = await env["client"].get(f"/api/v1/global-assets/character/{filename}")
    assert allowed.status_code == 200
