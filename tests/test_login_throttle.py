import pytest

from server.security.login_throttle import LoginThrottle

pytestmark = pytest.mark.unit


def test_throttle_locks_at_threshold_and_expires() -> None:
    throttle = LoginThrottle(max_failures=3, window_seconds=10, lock_seconds=30)

    for now in (1.0, 2.0, 3.0):
        throttle.record_failure("user", now=now)

    assert throttle.retry_after("user", now=3.0) == 30
    assert throttle.retry_after("user", now=34.0) == 0


def test_throttle_clear_removes_account_failures() -> None:
    throttle = LoginThrottle(max_failures=1, window_seconds=10, lock_seconds=30)
    throttle.record_failure("user", now=1.0)

    throttle.clear("user")

    assert throttle.retry_after("user", now=1.0) == 0
