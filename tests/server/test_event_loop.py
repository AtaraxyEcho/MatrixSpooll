from __future__ import annotations

import asyncio
import sys

import pytest

from server.event_loop import assert_subprocess_capable_event_loop, subprocess_capable_event_loop_factory


@pytest.mark.unit
def test_server_event_loop_can_launch_subprocesses() -> None:
    loop = subprocess_capable_event_loop_factory()

    async def launch_child() -> tuple[int | None, bytes]:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "print('child-ok')",
            stdout=asyncio.subprocess.PIPE,
        )
        stdout, _ = await process.communicate()
        return process.returncode, stdout

    try:
        returncode, stdout = loop.run_until_complete(launch_child())
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()

    assert returncode == 0
    assert stdout.decode().strip() == "child-ok"
    if sys.platform == "win32":
        assert type(loop).__name__ == "ProactorEventLoop"


@pytest.mark.unit
def test_windows_selector_loop_is_rejected_with_actionable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    loop = asyncio.SelectorEventLoop()
    monkeypatch.setattr(sys, "platform", "win32")
    try:
        with pytest.raises(RuntimeError, match="server.event_loop:subprocess_capable_event_loop_factory"):
            assert_subprocess_capable_event_loop(loop)
    finally:
        loop.close()
