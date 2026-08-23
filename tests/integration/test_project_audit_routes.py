"""Project entry routes persist their privileged audit events."""

from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from lib.db.base import Base
from lib.db.models.audit import AuditEvent
from lib.db.models.user import User
from lib.project_manager import ProjectManager
from server.auth import CurrentUserInfo
from server.routers import free_creations, projects
from server.services import project_access
from server.services.audit import AuditAction

pytestmark = pytest.mark.integration


async def _database():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        async with session.begin():
            session.add(User(id="owner", username="owner", role="member", is_active=True))
    return factory, engine


@pytest.mark.asyncio
async def test_free_project_creation_records_project_audit_event(tmp_path, monkeypatch) -> None:
    factory, engine = await _database()
    manager = ProjectManager(tmp_path / "projects")
    user = CurrentUserInfo(id="owner", sub="owner", role="member")
    try:
        monkeypatch.setattr(free_creations, "get_project_manager", lambda: manager)
        monkeypatch.setattr(project_access, "get_project_manager", lambda: manager)
        monkeypatch.setattr(free_creations, "database_auth_initialized", lambda: True)
        monkeypatch.setattr(
            free_creations,
            "create_free_creation",
            AsyncMock(return_value={"success": True, "creation_id": "c_0123456789abcdef0123"}),
        )

        request = free_creations.CreateFreeProjectRequest(
            title="Audit canvas",
            creation=free_creations.FreeCreationRequest(output_type="video", prompt="A quiet station"),
        )
        async with factory() as session:
            result = await free_creations.create_free_project(request, user, session)

        async with factory() as session:
            event = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.PROJECT_CREATE.value,
                    AuditEvent.project_name == result["name"],
                )
            )
            assert event is not None
            assert event.actor_user_id == "owner"
            assert event.details == {"content_mode": "free"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_project_archive_import_records_project_audit_event(tmp_path, monkeypatch) -> None:
    factory, engine = await _database()
    manager = ProjectManager(tmp_path / "projects")
    user = CurrentUserInfo(id="owner", sub="owner", role="member")
    result = SimpleNamespace(
        project_name="imported-project",
        project={"title": "Imported"},
        warnings=[],
        conflict_resolution="renamed",
        diagnostics={},
    )
    archive_service = SimpleNamespace(import_project_archive=lambda *_args, **_kwargs: result)
    try:
        monkeypatch.setattr(projects, "get_project_manager", lambda: manager)
        monkeypatch.setattr(project_access, "get_project_manager", lambda: manager)
        monkeypatch.setattr(projects, "get_archive_service", lambda: archive_service)
        monkeypatch.setattr(projects, "database_auth_initialized", lambda: True)

        upload = UploadFile(file=BytesIO(b"archive"), filename="project.zip")
        async with factory() as session:
            response = await projects.import_project_archive(
                lambda key, **_kwargs: key,
                user,
                session,
                upload,
                conflict_policy="rename",
            )
        assert isinstance(response, dict)
        assert response["success"] is True

        async with factory() as session:
            event = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.action == AuditAction.PROJECT_IMPORT.value,
                    AuditEvent.project_name == "imported-project",
                )
            )
            assert event is not None
            assert event.actor_user_id == "owner"
            assert event.details == {"conflict_resolution": "renamed"}
    finally:
        await engine.dispose()
