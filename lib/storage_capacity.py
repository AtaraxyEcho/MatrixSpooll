"""Shared disk-capacity admission checks for media-producing operations."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from lib.api_errors import ApiError
from lib.app_data_dir import app_data_dir

_MIN_FREE_GB_ENV = "MATRIXSPOOLL_MIN_FREE_GB"
_BYTES_PER_GIB = 1024**3
_BYTES_PER_MIB = 1024**2


@dataclass(frozen=True, slots=True)
class StorageCapacity:
    free_bytes: int
    total_bytes: int
    reserve_bytes: int
    required_bytes: int

    @property
    def available(self) -> bool:
        return self.free_bytes >= self.reserve_bytes + self.required_bytes


def configured_reserve_bytes() -> int:
    """Return the deployment reserve, disabled by default for isolated tests."""

    raw = os.environ.get(_MIN_FREE_GB_ENV, "").strip()
    if not raw:
        if os.environ.get("TESTING", "").strip().lower() in {"1", "true", "yes", "on"}:
            return 0
        raw = "2"
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{_MIN_FREE_GB_ENV} must be a non-negative number") from exc
    if value < 0:
        raise RuntimeError(f"{_MIN_FREE_GB_ENV} must be a non-negative number")
    return int(value * _BYTES_PER_GIB)


def _existing_disk_path(path: Path) -> Path:
    candidate = path.resolve()
    if candidate.is_file():
        candidate = candidate.parent
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate


def storage_capacity(
    path: Path | None = None,
    *,
    required_bytes: int = 0,
) -> StorageCapacity:
    if required_bytes < 0:
        raise ValueError("required_bytes must be non-negative")
    usage = shutil.disk_usage(_existing_disk_path(path or app_data_dir()))
    return StorageCapacity(
        free_bytes=usage.free,
        total_bytes=usage.total,
        reserve_bytes=configured_reserve_bytes(),
        required_bytes=required_bytes,
    )


def ensure_storage_capacity(path: Path | None = None, *, required_bytes: int = 0) -> StorageCapacity:
    """Reject a write before it consumes the deployment's safety reserve."""

    capacity = storage_capacity(path, required_bytes=required_bytes)
    if capacity.available:
        return capacity
    raise ApiError(
        "storage_capacity_low",
        status_code=507,
        free_mb=capacity.free_bytes // _BYTES_PER_MIB,
        required_mb=(capacity.reserve_bytes + capacity.required_bytes + _BYTES_PER_MIB - 1) // _BYTES_PER_MIB,
    )
