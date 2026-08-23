"""Administrator audit-log read endpoint tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from lib.db import get_async_session
from lib.db.models.audit import AuditEvent
from lib.db.models.user import User
from lib.db.models.user_session import UserSession
from server.auth import CurrentUserInfo, get_current_user
from server.routers import admin

pytestmark = pytest.mark.integration


def _client(db_factory, *, role: Literal["admin", "member"] = "admin") -> AsyncClient:
    app = FastAPI()
    app.include_router(admin.router, prefix="/api/v1")

    async def override_session():
        async with db_factory() as session:
            yield session

    app.dependency_overrides[get_async_session] = override_session
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(
        id="admin-user",
        sub="admin",
        role=role,
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_admin_can_filter_and_page_audit_events(db_factory) -> None:
    async with db_factory() as session:
        session.add_all(
            [
                AuditEvent(
                    actor_username="alice",
                    action="project.member.add",
                    resource_type="project",
                    project_name="Demo",
                    details={"role": "viewer"},
                ),
                AuditEvent(
                    actor_username="bob",
                    action="user.update",
                    resource_type="user",
                    details={"to_role": "admin"},
                ),
                AuditEvent(
                    actor_username="alice",
                    action="project.member.add",
                    resource_type="project",
                    project_name="Other",
                    details={"role": "editor"},
                ),
            ]
        )
        await session.commit()

    async with _client(db_factory) as client:
        response = await client.get(
            "/api/v1/admin/audit-events",
            params={"action": "project.member.add", "page": 1, "page_size": 1},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 2
    assert payload["page"] == 1
    assert payload["page_size"] == 1
    assert len(payload["events"]) == 1
    assert payload["events"][0]["action"] == "project.member.add"


async def test_member_cannot_read_audit_events(db_factory) -> None:
    async with _client(db_factory, role="member") as client:
        response = await client.get("/api/v1/admin/audit-events")

    assert response.status_code == 403


async def test_admin_can_list_and_filter_login_sessions(db_factory) -> None:
    now = datetime.now(UTC)
    async with db_factory() as session:
        user = User(
            id="user-1",
            username="alice",
            password_hash="hash",
            role="member",
            is_active=True,
            is_superadmin=False,
        )
        session.add(user)
        session.add_all(
            [
                UserSession(
                    id="session-active",
                    user_id=user.id,
                    device_id="browser-a",
                    token_id="token-active",
                    ip_address="192.0.2.10",
                    expires_at=now + timedelta(hours=1),
                ),
                UserSession(
                    id="session-revoked",
                    user_id=user.id,
                    device_id="browser-b",
                    token_id="token-revoked",
                    expires_at=now + timedelta(hours=1),
                    revoked_at=now,
                ),
            ]
        )
        await session.commit()

    async with _client(db_factory) as client:
        response = await client.get("/api/v1/admin/sessions", params={"status": "active", "username": "ali"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["sessions"][0]["id"] == "session-active"
    assert payload["sessions"][0]["status"] == "active"
    assert "token_id" not in payload["sessions"][0]
