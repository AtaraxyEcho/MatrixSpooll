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


@pytest.mark.parametrize(
    ("username", "expected_detail"),
    [
        ("abc", "用户名长度必须为 4–32 位"),
        ("1alice", "用户名必须以英文字母开头"),
        ("_alice", "用户名必须以英文字母开头"),
        ("张三alice", "用户名必须以英文字母开头"),
        ("alice smith", "用户名仅支持英文字母、数字及 . _ -"),
        ("alice!", "用户名仅支持英文字母、数字及 . _ -"),
        ("alice..smith", "用户名不能以符号结尾或连续使用符号"),
        ("alice-", "用户名不能以符号结尾或连续使用符号"),
    ],
)
async def test_admin_rejects_invalid_usernames(db_factory, username: str, expected_detail: str) -> None:
    async with _client(db_factory) as client:
        response = await client.post(
            "/api/v1/admin/users",
            headers={"Accept-Language": "zh"},
            json={"username": username, "password": "valid-password-123", "role": "member"},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == expected_detail


async def test_admin_accepts_valid_username_and_normalizes_email(db_factory) -> None:
    async with db_factory() as session:
        session.add(
            User(
                id="admin-user",
                username="admin",
                password_hash="hash",
                role="admin",
                is_active=True,
                is_superadmin=True,
            )
        )
        await session.commit()

    async with _client(db_factory) as client:
        response = await client.post(
            "/api/v1/admin/users",
            json={
                "username": "Alice.dev-1",
                "email": "  ALICE@example.com ",
                "password": "valid-password-123",
                "role": "member",
            },
        )

    assert response.status_code == 201
    payload = response.json()
    assert payload["user"]["username"] == "Alice.dev-1"
    assert payload["user"]["email"] == "alice@example.com"


async def test_admin_rejects_username_that_differs_only_by_case(db_factory) -> None:
    async with db_factory() as session:
        session.add_all(
            [
                User(
                    id="admin-user",
                    username="admin",
                    password_hash="hash",
                    role="admin",
                    is_active=True,
                    is_superadmin=True,
                ),
                User(
                    id="existing-user",
                    username="Alice",
                    password_hash="hash",
                    role="member",
                    is_active=True,
                    is_superadmin=False,
                ),
            ]
        )
        await session.commit()

    async with _client(db_factory) as client:
        response = await client.post(
            "/api/v1/admin/users",
            json={"username": "alice", "password": "valid-password-123", "role": "member"},
        )

    assert response.status_code == 409


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


async def test_admin_can_search_users_by_email_and_view_login_metadata(db_factory) -> None:
    last_login_at = datetime(2026, 8, 23, 9, 30, tzinfo=UTC)
    async with db_factory() as session:
        session.add(
            User(
                id="user-contact",
                username="alice",
                password_hash="hash",
                email="alice@example.com",
                last_login_at=last_login_at,
                last_login_ip="2001:db8::10",
                role="member",
                is_active=True,
                is_superadmin=False,
            )
        )
        await session.commit()

    async with _client(db_factory) as client:
        response = await client.get("/api/v1/admin/users", params={"username": "EXAMPLE"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["users"][0]["email"] == "alice@example.com"
    assert payload["users"][0]["last_login_ip"] == "2001:db8::10"
    assert payload["users"][0]["last_login_at"].startswith("2026-08-23T09:30:00")
