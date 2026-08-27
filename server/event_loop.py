"""Event-loop factory for ASGI runtimes that launch local subprocesses."""

from __future__ import annotations

import asyncio
import sys


def subprocess_capable_event_loop_factory() -> asyncio.AbstractEventLoop:
    """Return an asyncio loop that supports subprocess transports on the host OS."""

    if sys.platform == "win32":
        from asyncio.windows_events import ProactorEventLoop

        return ProactorEventLoop()
    return asyncio.SelectorEventLoop()


def assert_subprocess_capable_event_loop(loop: asyncio.AbstractEventLoop | None = None) -> None:
    """Fail at startup when Windows is running a loop without subprocess support."""

    active_loop = loop or asyncio.get_running_loop()
    if sys.platform == "win32" and isinstance(active_loop, asyncio.SelectorEventLoop):
        raise RuntimeError(
            "Windows requires a subprocess-capable event loop. Start Uvicorn with "
            "--loop server.event_loop:subprocess_capable_event_loop_factory"
        )


__all__ = ["assert_subprocess_capable_event_loop", "subprocess_capable_event_loop_factory"]
