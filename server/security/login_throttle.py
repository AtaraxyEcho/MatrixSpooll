"""Bounded in-process login throttling for small single-instance deployments."""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field


@dataclass
class _AttemptState:
    failures: deque[float] = field(default_factory=deque)
    locked_until: float = 0.0


class LoginThrottle:
    def __init__(self, *, max_failures: int, window_seconds: int, lock_seconds: int, max_entries: int = 10_000):
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.lock_seconds = lock_seconds
        self.max_entries = max_entries
        self._states: dict[str, _AttemptState] = {}
        self._lock = threading.Lock()

    def retry_after(self, key: str, *, now: float | None = None) -> int:
        current = time.monotonic() if now is None else now
        with self._lock:
            state = self._states.get(key)
            if state is None:
                return 0
            self._prune(state, current)
            if state.locked_until <= current:
                state.locked_until = 0.0
                if not state.failures:
                    self._states.pop(key, None)
                return 0
            return max(1, math.ceil(state.locked_until - current))

    def record_failure(self, key: str, *, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        with self._lock:
            self._evict_if_needed(current)
            state = self._states.setdefault(key, _AttemptState())
            self._prune(state, current)
            state.failures.append(current)
            if len(state.failures) >= self.max_failures:
                state.locked_until = current + self.lock_seconds

    def clear(self, key: str) -> None:
        with self._lock:
            self._states.pop(key, None)

    def reset(self) -> None:
        with self._lock:
            self._states.clear()

    def _prune(self, state: _AttemptState, now: float) -> None:
        cutoff = now - self.window_seconds
        while state.failures and state.failures[0] <= cutoff:
            state.failures.popleft()

    def _evict_if_needed(self, now: float) -> None:
        if len(self._states) < self.max_entries:
            return
        stale = [key for key, state in self._states.items() if state.locked_until <= now and not state.failures]
        for key in stale:
            self._states.pop(key, None)
        if len(self._states) >= self.max_entries:
            self._states.pop(next(iter(self._states)))


ACCOUNT_LOGIN_THROTTLE = LoginThrottle(max_failures=5, window_seconds=10 * 60, lock_seconds=15 * 60)
IP_LOGIN_THROTTLE = LoginThrottle(max_failures=20, window_seconds=10 * 60, lock_seconds=15 * 60)


def reset_login_throttles() -> None:
    ACCOUNT_LOGIN_THROTTLE.reset()
    IP_LOGIN_THROTTLE.reset()
