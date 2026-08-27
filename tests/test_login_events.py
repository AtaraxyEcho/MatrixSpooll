"""Login event persistence through the public authentication endpoints."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from lib.db.models.login_event import LoginEvent
from lib.db.models.user import User
from server.routers import auth as auth_router
from server.security.login_throttle import reset_login_throttles

pytestmark = pytest.mark.integration


async def test_login_attempts_are_recorded_without_credentials(db_factory, monkeypatch) -> None:
    user = User(
        id="00000000000040008000000000000001",
        username="alice",
        password_hash="unused",
        role="member",
        is_active=True,
        is_superadmin=False,
    )
    async with db_factory() as session:
        session.add(user)
        await session.commit()

    async def authenticate(username: str, password: str):
        return user if username == "alice" and password == "correct-password" else None

    async def user_exists(username: str) -> bool:
        return username == "alice"

    async def create_session(*_args, **_kwargs):
        return SimpleNamespace(id="session-alice")

    monkeypatch.setattr(auth_router, "async_session_factory", db_factory)
    monkeypatch.setattr(auth_router, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(auth_router, "database_auth_initialized", lambda: True)
    monkeypatch.setattr(auth_router, "authenticate_database_user", authenticate)
    monkeypatch.setattr(auth_router, "database_user_exists", user_exists)
    monkeypatch.setattr(auth_router, "create_user_session", create_session)
    monkeypatch.setattr(auth_router, "create_token", lambda *_args, **_kwargs: "signed-token")
    reset_login_throttles()

    app = FastAPI()
    app.include_router(auth_router.public_router, prefix="/api/v1")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        success = await client.post(
            "/api/v1/auth/session",
            data={"username": "alice", "password": "correct-password", "device_id": "browser-a"},
        )
        failure = await client.post(
            "/api/v1/auth/session",
            data={"username": "alice", "password": "wrong-password", "device_id": "browser-a"},
        )
        empty = await client.post("/api/v1/auth/session", data={"username": "", "password": ""})

    assert success.status_code == 200
    assert failure.status_code == 401
    assert empty.status_code == 422
    async with db_factory() as session:
        events = list((await session.scalars(select(LoginEvent).order_by(LoginEvent.created_at.asc()))).all())
    assert [event.outcome for event in events] == ["success", "failure", "failure"]
    assert [event.reason for event in events] == [None, "invalid_credentials", "missing_username_and_password"]
    assert events[0].session_id == "session-alice"
    assert events[0].device_id == "browser-a"
    assert "password" not in LoginEvent.__table__.columns
    assert "token" not in LoginEvent.__table__.columns
