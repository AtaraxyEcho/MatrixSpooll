"""Migrate persisted runtime files after an application identity rename."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from lib.artifact_manifest import HASH_ALGORITHM
from lib.artifact_manifest import MANIFEST_FILENAME as ARTIFACT_MANIFEST_FILENAME
from lib.json_io import atomic_write_json
from lib.profile_manifest import (
    EXPECTED_PROFILE_ID,
)
from lib.profile_manifest import (
    MANIFEST_FILENAME as PROFILE_MANIFEST_FILENAME,
)
from lib.profile_manifest import (
    MANIFEST_SCHEMA_VERSION as PROFILE_MANIFEST_SCHEMA_VERSION,
)

logger = logging.getLogger(__name__)

RUNTIME_DIRECTORY_NAME = ".matrixspooll"
LEGACY_RUNTIME_DIRECTORY_NAMES = frozenset({".arcreel", ".arcreel-runtime", ".arcreel-data"})


@dataclass(slots=True)
class RuntimeIdentityMigrationResult:
    artifact_manifests: int = 0
    profile_manifests: int = 0
    runtime_directories: int = 0


def _load_object(path: Path) -> dict[str, Any] | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _find_single_candidate(project_dir: Path, suffix: str, target: Path) -> tuple[Path, dict[str, Any]] | None:
    candidates: list[tuple[Path, dict[str, Any]]] = []
    for path in project_dir.glob(f".*{suffix}"):
        if path == target:
            continue
        payload = _load_object(path)
        if payload is not None:
            candidates.append((path, payload))
    if len(candidates) > 1:
        logger.warning("multiple runtime manifest candidates in %s for suffix %s", project_dir, suffix)
        return None
    return candidates[0] if candidates else None


def _migrate_artifact_manifest(project_dir: Path) -> bool:
    target = project_dir / ARTIFACT_MANIFEST_FILENAME
    candidate = _find_single_candidate(project_dir, "_artifacts.json", target)
    if candidate is None:
        return False
    source, payload = candidate
    if (
        payload.get("schema_version") != 1
        or payload.get("hash_algorithm") != HASH_ALGORITHM
        or not isinstance(payload.get("entries"), dict)
    ):
        return False
    if target.exists():
        target_payload = _load_object(target)
        if (
            target_payload is None
            or target_payload.get("schema_version") != 1
            or target_payload.get("hash_algorithm") != HASH_ALGORITHM
            or not isinstance(target_payload.get("entries"), dict)
        ):
            return False
        source_entries = payload["entries"]
        target_entries = target_payload["entries"]
        if any(key in target_entries and target_entries[key] != value for key, value in source_entries.items()):
            logger.warning("runtime artifact manifest conflicts in %s", project_dir)
            return False
        target_payload["entries"] = {**source_entries, **target_entries}
        atomic_write_json(target, target_payload)
        source.unlink()
    else:
        os.replace(source, target)
    return True


def _migrate_profile_manifest(project_dir: Path) -> bool:
    target = project_dir / PROFILE_MANIFEST_FILENAME
    candidate = _find_single_candidate(project_dir, "_profile_manifest.json", target)
    if candidate is None:
        return False
    source, payload = candidate
    profile_id = payload.get("profile_id")
    if (
        payload.get("schema_version") != PROFILE_MANIFEST_SCHEMA_VERSION
        or not isinstance(profile_id, str)
        or not profile_id.endswith("/builtin")
        or not isinstance(payload.get("entries"), dict)
    ):
        return False
    if not target.exists():
        payload["profile_id"] = EXPECTED_PROFILE_ID
        atomic_write_json(target, payload)
    else:
        target_payload = _load_object(target)
        if (
            target_payload is None
            or target_payload.get("schema_version") != PROFILE_MANIFEST_SCHEMA_VERSION
            or target_payload.get("profile_id") != EXPECTED_PROFILE_ID
            or not isinstance(target_payload.get("entries"), dict)
        ):
            return False
    source.unlink()
    return True


def _migrate_runtime_directory(project_dir: Path) -> bool:
    target = project_dir / RUNTIME_DIRECTORY_NAME
    candidates = [
        path
        for path in project_dir.iterdir()
        if path.name.startswith(".")
        and path.name != RUNTIME_DIRECTORY_NAME
        and path.is_dir()
        and not path.is_symlink()
        and path.name in LEGACY_RUNTIME_DIRECTORY_NAMES
        and (
            (path / "source_encoding_migrated").is_file()
            or (path / "migration_errors.log").is_file()
            or (path / "tasks").is_dir()
        )
    ]
    if len(candidates) > 1:
        logger.warning("multiple runtime directory candidates in %s", project_dir)
        return False
    if not candidates:
        return False
    source = candidates[0]
    _rewrite_checkpoint_locators(source)
    if target.exists():
        _rewrite_checkpoint_locators(target)
    if not target.exists():
        os.replace(source, target)
        return True

    _merge_runtime_directory(source, target)
    try:
        source.rmdir()
    except OSError:
        logger.warning("runtime directory contains conflicting entries in %s", project_dir)
        return False
    return True


def _rewrite_checkpoint_locators(runtime_root: Path) -> None:
    """Rewrite staged media paths before a legacy runtime tree is moved."""

    tasks_root = runtime_root / "tasks"
    if not tasks_root.is_dir():
        return
    old_prefixes = tuple(f"{name}/tasks/" for name in LEGACY_RUNTIME_DIRECTORY_NAMES)

    def rewrite(value: Any) -> tuple[Any, bool]:
        if isinstance(value, str):
            for prefix in old_prefixes:
                if value.startswith(prefix):
                    return f"{RUNTIME_DIRECTORY_NAME}/tasks/{value[len(prefix) :]}", True
            return value, False
        if isinstance(value, list):
            changed = False
            rewritten = []
            for item in value:
                item, item_changed = rewrite(item)
                rewritten.append(item)
                changed = changed or item_changed
            return rewritten, changed
        if isinstance(value, dict):
            changed = False
            rewritten_dict: dict[str, Any] = {}
            for key, item in value.items():
                item, item_changed = rewrite(item)
                rewritten_dict[key] = item
                changed = changed or item_changed
            return rewritten_dict, changed
        return value, False

    for checkpoint in tasks_root.rglob("*.json"):
        payload = _load_object(checkpoint)
        if payload is None:
            continue
        rewritten, changed = rewrite(payload)
        if changed:
            atomic_write_json(checkpoint, rewritten)


def _merge_runtime_directory(source: Path, target: Path) -> None:
    for child in source.iterdir():
        destination = target / child.name
        if child.is_symlink() or destination.is_symlink():
            continue
        if not destination.exists():
            os.replace(child, destination)
            continue
        if child.is_dir() and destination.is_dir():
            _merge_runtime_directory(child, destination)
            try:
                child.rmdir()
            except OSError:
                pass
            continue
        if child.is_file() and destination.is_file():
            try:
                if child.read_bytes() == destination.read_bytes():
                    child.unlink()
            except OSError:
                pass


def migrate_runtime_identity(projects_root: Path) -> RuntimeIdentityMigrationResult:
    """Migrate validated runtime files without embedding a retired product name."""
    result = RuntimeIdentityMigrationResult()
    if not projects_root.is_dir():
        return result

    for project_dir in projects_root.iterdir():
        if not project_dir.is_dir() or project_dir.is_symlink():
            continue
        if (project_dir / "project.json").is_file():
            result.artifact_manifests += int(_migrate_artifact_manifest(project_dir))
            result.profile_manifests += int(_migrate_profile_manifest(project_dir))
        result.runtime_directories += int(_migrate_runtime_directory(project_dir))

    if result.artifact_manifests or result.profile_manifests or result.runtime_directories:
        logger.info(
            "runtime identity migration: artifacts=%d profiles=%d directories=%d",
            result.artifact_manifests,
            result.profile_manifests,
            result.runtime_directories,
        )
    return result
