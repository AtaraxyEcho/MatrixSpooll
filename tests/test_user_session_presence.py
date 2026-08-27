"""Authentication-session presence and same-client exclusion behavior."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

import server.auth as auth
from lib.db.base import utc_now
from lib.db.models.user import User
from lib.db.models.user_session import UserSession

pytestmark = pytest.mark.integration


async def test_same_ip_login_revokes_other_browser_but_keeps_other_ip(db_factory, monkeypatch) -> None:
    monkeypatch.setattr(auth, "async_session_factory", db_factory)
    user = User(
        id="00000000000040008000000000000011",
        username="alice",
        password_hash="unused",
        role="member",
        is_active=True,
        is_superadmin=False,
    )
    async with db_factory() as session:
        session.add(user)
        await session.commit()

    first = await auth.create_user_session(
        user,
        device_id="chrome",
        ip_address="192.0.2.10",
        user_agent="Chrome",
    )
    remote = await auth.create_user_session(
        user,
        device_id="remote-device",
        ip_address="198.51.100.20",
        user_agent="Remote Browser",
    )
    edge = await auth.create_user_session(
        user,
        device_id="edge",
        ip_address="192.0.2.10",
        user_agent="Edge",
    )

    async with db_factory() as session:
        rows = {row.id: row for row in (await session.scalars(select(UserSession))).all()}

    assert rows[first.id].revoked_at is not None
    assert rows[remote.id].revoked_at is None
    assert rows[edge.id].revoked_at is None
    assert rows[edge.id].last_seen_at is not None
    assert await auth.get_user_session_state(user.id, first.id) == "replaced"
    assert await auth.get_user_session_state(user.id, remote.id) == "active"
    assert await auth.get_user_session_state(user.id, edge.id) == "active"


async def test_explicitly_revoked_session_is_not_reported_as_replaced(db_factory, monkeypatch) -> None:
    monkeypatch.setattr(auth, "async_session_factory", db_factory)
    user = User(
        id="00000000000040008000000000000013",
        username="carol",
        password_hash="unused",
        role="member",
        is_active=True,
        is_superadmin=False,
    )
    async with db_factory() as session:
        session.add(user)
        await session.commit()

    browser_session = await auth.create_user_session(
        user,
        device_id="carol-browser",
        ip_address="203.0.113.30",
        user_agent="Chrome",
    )
    assert await auth.revoke_user_session(browser_session.id, user.id) is True

    assert await auth.get_user_session_state(user.id, browser_session.id) == "revoked"


async def test_online_session_query_excludes_stale_successful_login(db_factory) -> None:
    now = utc_now()
    user = User(
        id="00000000000040008000000000000012",
        username="bob",
        password_hash="unused",
        role="member",
        is_active=True,
        is_superadmin=False,
    )
    async with db_factory() as session:
        session.add(user)
        session.add_all(
            [
                UserSession(
                    id="online-session",
                    user_id=user.id,
                    device_id="online-device",
                    token_id="online-token",
                    last_seen_at=now,
                    expires_at=now + timedelta(days=1),
                ),
                UserSession(
                    id="stale-session",
                    user_id=user.id,
                    device_id="stale-device",
                    token_id="stale-token",
                    last_seen_at=now - timedelta(minutes=10),
                    expires_at=now + timedelta(days=1),
                ),
            ]
        )
        await session.commit()

    async with db_factory() as session:
        cutoff = now - timedelta(seconds=auth.SESSION_ONLINE_WINDOW_SECONDS)
        rows = list(
            (
                await session.scalars(
                    select(UserSession).where(
                        UserSession.revoked_at.is_(None),
                        UserSession.expires_at > now,
                        UserSession.last_seen_at >= cutoff,
                    )
                )
            ).all()
        )

    assert [row.id for row in rows] == ["online-session"]
