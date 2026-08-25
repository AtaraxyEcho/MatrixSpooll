from __future__ import annotations

from collections import namedtuple

import pytest

from lib.api_errors import ApiError
from lib.storage_capacity import configured_reserve_bytes, ensure_storage_capacity, storage_capacity

pytestmark = pytest.mark.unit

DiskUsage = namedtuple("DiskUsage", "total used free")


def test_testing_defaults_to_no_capacity_reserve(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TESTING", "true")
    monkeypatch.delenv("MATRIXSPOOLL_MIN_FREE_GB", raising=False)
    assert configured_reserve_bytes() == 0


def test_configured_capacity_reserve_accepts_fractional_gib(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MATRIXSPOOLL_MIN_FREE_GB", "1.5")
    assert configured_reserve_bytes() == int(1.5 * 1024**3)


def test_capacity_rejects_invalid_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MATRIXSPOOLL_MIN_FREE_GB", "many")
    with pytest.raises(RuntimeError, match="MATRIXSPOOLL_MIN_FREE_GB"):
        configured_reserve_bytes()


def test_capacity_accounts_for_pending_write(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MATRIXSPOOLL_MIN_FREE_GB", "1")
    monkeypatch.setattr("lib.storage_capacity.shutil.disk_usage", lambda _path: DiskUsage(10_000, 0, 2 * 1024**3))
    result = storage_capacity(tmp_path / "future" / "media.mp4", required_bytes=512 * 1024**2)
    assert result.available is True


def test_capacity_raises_localized_api_error_before_write(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MATRIXSPOOLL_MIN_FREE_GB", "2")
    monkeypatch.setattr("lib.storage_capacity.shutil.disk_usage", lambda _path: DiskUsage(10_000, 0, 1024**3))
    with pytest.raises(ApiError) as raised:
        ensure_storage_capacity(tmp_path)
    assert raised.value.status_code == 507
    assert raised.value.key == "storage_capacity_low"
    assert raised.value.params == {"free_mb": 1024, "required_mb": 2048}
