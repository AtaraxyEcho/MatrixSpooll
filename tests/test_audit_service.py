"""Audit event recording tests."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import server.auth as auth_module
from lib.db.base import Base
from lib.db.models.audit import AuditEvent
from lib.db.models.user import User
from lib.db.models.user_session import UserSession
from server.auth import CurrentUserInfo
from server.routers import admin
from server.services.audit import AuditAction, AuditResourceType, record_audit_event

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_record_audit_event_uses_callers_transaction() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            async with session.begin():
                session.add(User(id="admin", username="admin", role="admin", is_active=True))
            async with session.begin():
                event = record_audit_event(
                    session,
                    actor=CurrentUserInfo(id="admin", sub="admin", role="admin"),
                    action=AuditAction.USER_CREATE,
                    resource_type=AuditResourceType.USER,
                    resource_id="member-1",
                    details={"role": "member"},
                )
            stored = await session.get(AuditEvent, event.id)
            assert stored is not None
            assert stored.actor_username == "admin"
            assert stored.details == {"role": "member"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_session_revocation_rolls_back_when_audit_commit_fails(tmp_path, monkeypatch) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'audit.db'}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            async with session.begin():
                session.add_all(
                    [
                        User(id="admin", username="admin", role="admin", is_active=True),
                        User(id="member", username="member", role="member", is_active=True),
                        UserSession(
                            id="session-1",
                            user_id="member",
                            device_id="device-1",
                            token_id="token-1",
                            expires_at=datetime.now(UTC) + timedelta(days=1),
                        ),
                    ]
                )

        monkeypatch.setattr(auth_module, "async_session_factory", factory)
        async with factory() as session:

            async def fail_commit() -> None:
                await session.rollback()
                raise RuntimeError("audit commit failed")

            monkeypatch.setattr(session, "commit", fail_commit)
            with pytest.raises(RuntimeError, match="audit commit failed"):
                await admin.revoke_sessions(
                    "member",
                    CurrentUserInfo(id="admin", sub="admin", role="admin"),
                    lambda key, **_kwargs: key,
                    session,
                )

        async with factory() as session:
            stored = await session.get(UserSession, "session-1")
            assert stored is not None and stored.revoked_at is None
    finally:
        await engine.dispose()
