from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from lib.api_errors import BadRequestError, ConflictError, ForbiddenError, NotFoundError
from lib.db.base import Base, utc_now
from lib.db.models.asset import Asset
from lib.db.models.audit import AuditEvent
from lib.db.models.project import ProjectMember, ProjectRegistry
from lib.db.models.task import Task
from lib.db.models.user import User
from server.auth import CurrentUserInfo, get_current_user
from server.error_handlers import register_error_handlers
from server.routers import admin, agent_chat, assets, projects
from server.services import project_access
from server.services.audit import AuditAction

pytestmark = pytest.mark.integration


class _ProjectManager:
    def __init__(self, root: Path):
        self.projects_root = root

    @staticmethod
    def normalize_project_name(name: str) -> str:
        if not name or "/" in name or "\\" in name or name in {".", ".."}:
            raise ValueError("invalid project name")
        return name

    def get_project_path(self, name: str) -> Path:
        path = self.projects_root / name
        if not path.exists():
            raise FileNotFoundError(name)
        return path

    def load_project(self, name: str) -> dict[str, str | None]:
        return {"content_mode": "free", "generation_mode": None}


async def _make_database() -> tuple[async_sessionmaker[AsyncSession], AsyncEngine]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    return factory, engine


async def _seed_project(factory: async_sessionmaker[AsyncSession]) -> None:
    now = utc_now()
    async with factory() as session:
        async with session.begin():
            session.add_all(
                [
                    User(id="default", username="admin", role="admin", is_active=True),
                    User(id="editor", username="editor", role="member", is_active=True),
                    User(id="viewer", username="viewer", role="member", is_active=True),
                    ProjectRegistry(
                        id="project-1",
                        name="shared-project",
                        owner_id="default",
                        created_at=now,
                        updated_at=now,
                    ),
                    ProjectRegistry(
                        id="project-2",
                        name="private-project",
                        owner_id="default",
                        created_at=now,
                        updated_at=now,
                    ),
                    ProjectMember(
                        project_id="project-1",
                        user_id="editor",
                        role="editor",
                        created_at=now,
                        updated_at=now,
                    ),
                    ProjectMember(
                        project_id="project-1",
                        user_id="viewer",
                        role="viewer",
                        created_at=now,
                        updated_at=now,
                    ),
                ]
            )


@pytest.mark.asyncio
async def test_project_access_enforces_roles_and_project_boundaries(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        project_dir = tmp_path / "shared-project"
        project_dir.mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        await _seed_project(factory)

        async with factory() as session:
            owner = await project_access.resolve_project_access(
                "shared-project",
                CurrentUserInfo(id="default", sub="admin", role="admin"),
                session,
                required_role="owner",
            )
            assert owner.role == "owner"
            editor = await project_access.resolve_project_access(
                "shared-project",
                CurrentUserInfo(id="editor", sub="editor", role="member"),
                session,
                required_role="editor",
            )
            assert editor.content_mode == "free"

            with pytest.raises(ForbiddenError):
                await project_access.resolve_project_access(
                    "shared-project",
                    CurrentUserInfo(id="viewer", sub="viewer", role="member"),
                    session,
                    required_role="editor",
                )
            with pytest.raises(NotFoundError):
                await project_access.resolve_project_access(
                    "missing-project",
                    CurrentUserInfo(id="editor", sub="editor", role="member"),
                    session,
                )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_accessible_projects_only_returns_memberships(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        (tmp_path / "shared-project").mkdir()
        (tmp_path / "private-project").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        await _seed_project(factory)

        async with factory() as session:
            visible = await project_access.list_accessible_projects("editor", session)
            assert [project.name for project in visible] == ["shared-project"]
            owned = await project_access.list_accessible_projects("default", session)
            assert {project.name for project in owned} == {"shared-project", "private-project"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_duplicate_project_names_resolve_within_the_current_users_access(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        now = utc_now()
        (tmp_path / "storage-a").mkdir()
        (tmp_path / "storage-b").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        async with factory() as session:
            async with session.begin():
                session.add_all(
                    [
                        User(id="owner-a", username="owner-a", role="member", is_active=True),
                        User(id="owner-b", username="owner-b", role="member", is_active=True),
                        User(id="admin", username="admin", role="admin", is_active=True),
                        ProjectRegistry(
                            id="project-a",
                            name="same-name",
                            storage_key="storage-a",
                            owner_id="owner-a",
                            created_at=now,
                            updated_at=now,
                        ),
                        ProjectRegistry(
                            id="project-b",
                            name="same-name",
                            storage_key="storage-b",
                            owner_id="owner-b",
                            created_at=now,
                            updated_at=now,
                        ),
                    ]
                )

        async with factory() as session:
            access_a = await project_access.resolve_project_access(
                "same-name",
                CurrentUserInfo(id="owner-a", sub="owner-a", role="member"),
                session,
            )
            access_b = await project_access.resolve_project_access(
                "same-name",
                CurrentUserInfo(id="owner-b", sub="owner-b", role="member"),
                session,
            )
            assert access_a.project_id == "project-a"
            assert access_b.project_id == "project-b"

            with pytest.raises(BadRequestError) as raised:
                await project_access.resolve_project_access(
                    "same-name",
                    CurrentUserInfo(id="admin", sub="admin", role="admin"),
                    session,
                )
            assert raised.value.key == "project_identifier_ambiguous"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_project_with_active_generation_task_cannot_be_deleted(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        now = utc_now()
        (tmp_path / "shared-project").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        monkeypatch.setattr(projects, "get_project_manager", lambda: _ProjectManager(tmp_path))
        monkeypatch.setattr(projects, "database_auth_initialized", lambda: True)
        await _seed_project(factory)
        async with factory() as session:
            async with session.begin():
                session.add(
                    Task(
                        task_id="active-task",
                        project_id="project-1",
                        project_name="shared-project",
                        task_type="free_video",
                        media_type="video",
                        resource_id="artifact-1",
                        status="running",
                        source="webui",
                        queued_at=now,
                        updated_at=now,
                        user_id="default",
                    )
                )

        async with factory() as session:
            with pytest.raises(ConflictError) as raised:
                await projects.delete_project(
                    "project-1",
                    lambda key, **_kwargs: key,
                    CurrentUserInfo(id="default", sub="admin", role="admin"),
                    session,
                )
            assert raised.value.key == "project_delete_active_tasks"
            assert raised.value.params == {"count": 1}
            assert (tmp_path / "shared-project").is_dir()
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_membership_routes_allow_owner_to_manage_roles(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        (tmp_path / "shared-project").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        await _seed_project(factory)

        async def override_session():
            async with factory() as session:
                yield session

        app = FastAPI()
        register_error_handlers(app)
        app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="default", sub="admin", role="admin")
        app.dependency_overrides[projects.get_async_session] = override_session
        app.include_router(projects.router, prefix="/api/v1")

        with TestClient(app) as client:
            listed = client.get("/api/v1/projects/shared-project/members")
            assert listed.status_code == 200
            assert {item["username"] for item in listed.json()["members"]} == {"admin", "editor", "viewer"}

            added = client.post(
                "/api/v1/projects/shared-project/members",
                json={"username": "viewer", "role": "editor"},
            )
            assert added.status_code == 409

            updated = client.patch(
                "/api/v1/projects/shared-project/members/editor",
                json={"role": "viewer"},
            )
            assert updated.status_code == 200
            assert updated.json()["role"] == "viewer"

            removed = client.delete("/api/v1/projects/shared-project/members/viewer")
            assert removed.status_code == 200

            transferred = client.post(
                "/api/v1/projects/shared-project/owner-transfer",
                json={"username": "editor"},
            )
            assert transferred.status_code == 200
            assert transferred.json()["role"] == "owner"

        async with factory() as session:
            registry = await session.get(ProjectRegistry, "project-1")
            old_owner = await session.get(ProjectMember, ("project-1", "default"))
            new_owner = await session.get(ProjectMember, ("project-1", "editor"))
            assert registry is not None and registry.owner_id == "editor"
            assert old_owner is not None and old_owner.role == "editor"
            assert new_owner is None
            actions = set(
                (await session.scalars(select(AuditEvent.action).where(AuditEvent.project_id == "project-1"))).all()
            )
            assert actions == {
                AuditAction.PROJECT_MEMBER_UPDATE.value,
                AuditAction.PROJECT_MEMBER_REMOVE.value,
                AuditAction.PROJECT_TRANSFER.value,
            }
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_owner_transfer_rechecks_current_owner_after_lock(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        await _seed_project(factory)
        async with factory() as session:
            registry = await session.get(ProjectRegistry, "project-1")
            editor_member = await session.get(ProjectMember, ("project-1", "editor"))
            assert registry is not None and editor_member is not None
            registry.owner_id = "editor"
            await session.delete(editor_member)
            session.add(ProjectMember(project_id="project-1", user_id="default", role="editor"))
            await session.commit()

        stale_access = project_access.ProjectAccess(
            project_id="project-1",
            project_name="shared-project",
            project_path=tmp_path / "shared-project",
            content_mode="free",
            generation_mode=None,
            owner_id="default",
            role="owner",
        )
        monkeypatch.setattr(projects, "resolve_project_access", AsyncMock(return_value=stale_access))

        async with factory() as session:
            with pytest.raises(ForbiddenError):
                await projects.transfer_project_owner(
                    "shared-project",
                    projects.ProjectOwnerTransferRequest(username="viewer"),
                    CurrentUserInfo(id="default", sub="former-owner", role="member"),
                    session,
                )
            await session.rollback()

        async with factory() as session:
            registry = await session.get(ProjectRegistry, "project-1")
            assert registry is not None and registry.owner_id == "editor"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_request_dependency_allows_viewer_reads_and_rejects_writes(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        (tmp_path / "shared-project").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        await _seed_project(factory)

        async def override_session():
            async with factory() as session:
                yield session

        scoped = APIRouter(dependencies=[Depends(project_access.require_project_request_access)])

        @scoped.get("/projects/{project_name}/resource")
        async def read_resource(project_name: str):
            return {"project": project_name}

        @scoped.post("/projects/{project_name}/resource")
        async def write_resource(project_name: str):
            return {"project": project_name}

        app = FastAPI()
        register_error_handlers(app)
        app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="viewer", sub="viewer", role="member")
        app.dependency_overrides[project_access.get_async_session] = override_session
        app.include_router(scoped)

        with TestClient(app) as client:
            assert client.get("/projects/shared-project/resource").status_code == 200
            denied = client.post("/projects/shared-project/resource")
            assert denied.status_code == 403
            assert "shared-project" in denied.json()["detail"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_request_dependency_allows_editor_settings_but_reserves_administration_for_owner(
    tmp_path,
    monkeypatch,
):
    factory, engine = await _make_database()
    try:
        (tmp_path / "shared-project").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        await _seed_project(factory)

        async def override_session():
            async with factory() as session:
                yield session

        scoped = APIRouter(dependencies=[Depends(project_access.require_project_request_access)])

        @scoped.patch("/projects/{project_name}")
        async def update_settings(project_name: str):
            return {"project": project_name}

        @scoped.delete("/projects/{project_name}")
        async def delete_project(project_name: str):
            return {"project": project_name}

        @scoped.post("/projects/{project_name}/members/{user_id}")
        async def update_members(project_name: str, user_id: str):
            return {"project": project_name, "user": user_id}

        app = FastAPI()
        register_error_handlers(app)
        app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(
            id="editor",
            sub="editor",
            role="member",
        )
        app.dependency_overrides[project_access.get_async_session] = override_session
        app.include_router(scoped)

        with TestClient(app) as client:
            assert client.patch("/projects/shared-project").status_code == 200
            assert client.delete("/projects/shared-project").status_code == 403
            assert client.post("/projects/shared-project/members/viewer").status_code == 403

            app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(
                id="viewer",
                sub="viewer",
                role="member",
            )
            assert client.patch("/projects/shared-project").status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_body_scoped_project_endpoints_reject_non_members(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        (tmp_path / "shared-project").mkdir()
        (tmp_path / "private-project").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        await _seed_project(factory)

        async def override_session():
            async with factory() as session:
                yield session

        app = FastAPI()
        register_error_handlers(app)
        app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="viewer", sub="viewer", role="member")
        app.dependency_overrides[agent_chat.get_async_session] = override_session
        app.include_router(agent_chat.router, prefix="/api/v1")
        app.include_router(assets.router, prefix="/api/v1")

        with TestClient(app) as client:
            chat = client.post(
                "/api/v1/agent/chat",
                json={"project_name": "private-project", "message": "hello"},
            )
            assert chat.status_code == 403

            imported = client.post(
                "/api/v1/assets/from-project",
                json={
                    "project_name": "private-project",
                    "resource_type": "character",
                    "resource_id": "hero",
                },
            )
            assert imported.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_project_owner_cannot_be_deactivated_before_transfer():
    factory, engine = await _make_database()
    try:
        await _seed_project(factory)
        async with factory() as session:
            registry = await session.get(ProjectRegistry, "project-1")
            next_owner = await session.get(ProjectMember, ("project-1", "editor"))
            assert registry is not None and next_owner is not None
            registry.owner_id = "editor"
            await session.delete(next_owner)
            session.add(ProjectMember(project_id="project-1", user_id="default", role="editor"))
            await session.commit()

            with pytest.raises(HTTPException) as raised:
                await admin.update_user(
                    "editor",
                    admin.UpdateUserRequest(is_active=False),
                    CurrentUserInfo(id="default", sub="admin", role="admin"),
                    lambda key, **_kwargs: key,
                    session,
                )
            assert raised.value.status_code == 400
            assert raised.value.detail == "admin_project_owner_deactivate_forbidden"

            owner = await session.get(User, "editor")
            assert owner is not None and owner.is_active
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_global_asset_mutations_require_creator_or_admin(monkeypatch):
    factory, engine = await _make_database()
    try:
        await _seed_project(factory)
        async with factory() as session:
            async with session.begin():
                session.add(
                    Asset(
                        id="asset-1",
                        type="character",
                        name="Hero",
                        description="",
                        voice_style="",
                        owner_user_id="editor",
                    )
                )
        monkeypatch.setattr(assets, "async_session_factory", factory)

        def translate(key, **_kwargs):
            return key

        with pytest.raises(HTTPException) as denied:
            await assets.update_asset(
                "asset-1",
                assets.UpdateAssetRequest(description="changed"),
                CurrentUserInfo(id="viewer", sub="viewer", role="member"),
                translate,
            )
        assert denied.value.status_code == 403
        assert denied.value.detail == "asset_owner_required"

        updated = await assets.update_asset(
            "asset-1",
            assets.UpdateAssetRequest(description="owned"),
            CurrentUserInfo(id="editor", sub="editor", role="member"),
            translate,
        )
        assert updated["asset"]["description"] == "owned"

        await assets.delete_asset(
            "asset-1",
            CurrentUserInfo(id="default", sub="admin", role="admin"),
            translate,
        )
        async with factory() as session:
            assert await session.get(Asset, "asset-1") is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_viewer_cannot_export_project_asset_to_global_library(tmp_path, monkeypatch):
    factory, engine = await _make_database()
    try:
        (tmp_path / "shared-project").mkdir()
        monkeypatch.setattr(project_access, "get_project_manager", lambda: _ProjectManager(tmp_path))
        await _seed_project(factory)
        async with factory() as session:
            with pytest.raises(ForbiddenError):
                await assets.from_project(
                    assets.FromProjectRequest(
                        project_name="shared-project",
                        resource_type="character",
                        resource_id="hero",
                    ),
                    lambda key, **_kwargs: key,
                    CurrentUserInfo(id="viewer", sub="viewer", role="member"),
                    session,
                )
    finally:
        await engine.dispose()
