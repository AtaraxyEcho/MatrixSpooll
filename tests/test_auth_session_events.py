"""Realtime browser-session termination events."""

from __future__ import annotations

import pytest

from server.auth import CurrentUserInfo
from server.routers import auth as auth_router

pytestmark = pytest.mark.unit


class _ConnectedRequest:
    async def is_disconnected(self) -> bool:
        return False


async def test_session_event_stream_reports_replacement(monkeypatch) -> None:
    states = iter(["active", "replaced"])

    async def get_state(_user_id: str, _session_id: str) -> str:
        return next(states)

    async def no_wait(_seconds: float) -> None:
        return None

    monkeypatch.setattr(auth_router, "get_user_session_state", get_state)
    monkeypatch.setattr(auth_router.asyncio, "sleep", no_wait)

    stream = auth_router.stream_session_events(
        _ConnectedRequest(),
        CurrentUserInfo(
            id="00000000000040008000000000000014",
            sub="alice",
            role="member",
            session_id="old-session",
        ),
    )

    ready = await anext(stream)
    ended = await anext(stream)
    await stream.aclose()

    assert ready.event == "ready"
    assert ended.event == "session_ended"
    assert ended.data == {"reason": "replaced"}
