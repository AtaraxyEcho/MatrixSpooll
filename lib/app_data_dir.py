"""Application data root resolution.

Centralizes where MatrixSpooll stores per-deployment data (projects, SQLite DB,
generated assets, system config). Decoupling this from the repository layout
lets the same backend code run under varied deployment shapes that don't keep
data alongside the source tree.

Resolution order:
    1. ``MATRIXSPOOLL_DATA_DIR`` — explicit override
    2. ``AI_ANIME_PROJECTS`` — legacy alias kept for backward compatibility
    3. ``ARCREEL_DATA_DIR`` — pre-branding deployment alias
    4. ``PROJECT_ROOT / "projects"`` — default

Relative paths resolve against :data:`lib.env_init.PROJECT_ROOT`. The directory
is created on first call.
"""

from __future__ import annotations

import functools
import os
from pathlib import Path

from lib.env_init import PROJECT_ROOT

_ENV_KEYS: tuple[str, ...] = ("MATRIXSPOOLL_DATA_DIR", "AI_ANIME_PROJECTS", "ARCREEL_DATA_DIR")


@functools.cache
def app_data_dir() -> Path:
    """Return the configured application data root (cached)."""
    for env_key in _ENV_KEYS:
        raw = os.environ.get(env_key, "").strip()
        if not raw:
            continue
        path = Path(raw)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        path.mkdir(parents=True, exist_ok=True)
        return path.resolve()
    default = (PROJECT_ROOT / "projects").resolve()
    default.mkdir(parents=True, exist_ok=True)
    return default


def _reset_for_tests() -> None:
    """Clear the cached value so tests can monkeypatch env between cases."""
    app_data_dir.cache_clear()
