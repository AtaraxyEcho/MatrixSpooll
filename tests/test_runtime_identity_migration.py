from __future__ import annotations

import json
from pathlib import Path

import pytest

from lib.artifact_manifest import HASH_ALGORITHM
from lib.artifact_manifest import MANIFEST_FILENAME as ARTIFACT_MANIFEST_FILENAME
from lib.profile_manifest import EXPECTED_PROFILE_ID
from lib.profile_manifest import MANIFEST_FILENAME as PROFILE_MANIFEST_FILENAME
from lib.runtime_identity_migration import RUNTIME_DIRECTORY_NAME, migrate_runtime_identity

pytestmark = pytest.mark.unit


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_migrates_validated_runtime_files_without_retired_name_literal(tmp_path: Path) -> None:
    project = tmp_path / "demo"
    project.mkdir()
    _write_json(project / "project.json", {"title": "Demo"})
    artifact_source = project / ".legacy_artifacts.json"
    _write_json(
        artifact_source,
        {"schema_version": 1, "hash_algorithm": HASH_ALGORITHM, "entries": {}},
    )
    profile_source = project / ".legacy_profile_manifest.json"
    _write_json(
        profile_source,
        {"schema_version": 1, "profile_id": "legacy/builtin", "entries": {}},
    )
    runtime_source = project / ".arcreel"
    runtime_source.mkdir()
    (runtime_source / "source_encoding_migrated").write_text("ok", encoding="utf-8")

    result = migrate_runtime_identity(tmp_path)

    assert result.artifact_manifests == 1
    assert result.profile_manifests == 1
    assert result.runtime_directories == 1
    assert (project / ARTIFACT_MANIFEST_FILENAME).is_file()
    assert not artifact_source.exists()
    migrated_profile = json.loads((project / PROFILE_MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert migrated_profile["profile_id"] == EXPECTED_PROFILE_ID
    assert not profile_source.exists()
    assert (project / RUNTIME_DIRECTORY_NAME / "source_encoding_migrated").is_file()


def test_ignores_unvalidated_or_ambiguous_candidates(tmp_path: Path) -> None:
    project = tmp_path / "demo"
    project.mkdir()
    _write_json(project / "project.json", {"title": "Demo"})
    _write_json(project / ".custom_artifacts.json", {"entries": {}})
    _write_json(
        project / ".one_profile_manifest.json",
        {"schema_version": 1, "profile_id": "one/builtin", "entries": {}},
    )
    _write_json(
        project / ".two_profile_manifest.json",
        {"schema_version": 1, "profile_id": "two/builtin", "entries": {}},
    )

    result = migrate_runtime_identity(tmp_path)

    assert result.artifact_manifests == 0
    assert result.profile_manifests == 0
    assert not (project / ARTIFACT_MANIFEST_FILENAME).exists()
    assert not (project / PROFILE_MANIFEST_FILENAME).exists()


def test_merges_non_conflicting_existing_artifact_and_runtime_state(tmp_path: Path) -> None:
    project = tmp_path / "demo"
    project.mkdir()
    _write_json(project / "project.json", {"title": "Demo"})
    _write_json(
        project / ARTIFACT_MANIFEST_FILENAME,
        {"schema_version": 1, "hash_algorithm": HASH_ALGORITHM, "entries": {"new": {"value": 2}}},
    )
    artifact_source = project / ".legacy_artifacts.json"
    _write_json(
        artifact_source,
        {"schema_version": 1, "hash_algorithm": HASH_ALGORITHM, "entries": {"old": {"value": 1}}},
    )
    target_runtime = project / RUNTIME_DIRECTORY_NAME
    target_runtime.mkdir()
    (target_runtime / "source_encoding_migrated").write_text("ok", encoding="utf-8")
    source_runtime = project / ".arcreel"
    (source_runtime / "tasks").mkdir(parents=True)
    (source_runtime / "source_encoding_migrated").write_text("ok", encoding="utf-8")

    result = migrate_runtime_identity(tmp_path)

    assert result.artifact_manifests == 1
    assert result.runtime_directories == 1
    manifest = json.loads((project / ARTIFACT_MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert set(manifest["entries"]) == {"old", "new"}
    assert not artifact_source.exists()
    assert (target_runtime / "tasks").is_dir()
    assert not source_runtime.exists()


def test_preserves_profile_source_when_existing_target_is_invalid(tmp_path: Path) -> None:
    project = tmp_path / "demo"
    project.mkdir()
    _write_json(project / "project.json", {"title": "Demo"})
    source = project / ".legacy_profile_manifest.json"
    _write_json(source, {"schema_version": 1, "profile_id": "legacy/builtin", "entries": {}})
    _write_json(project / PROFILE_MANIFEST_FILENAME, {"schema_version": 1, "entries": {}})

    result = migrate_runtime_identity(tmp_path)

    assert result.profile_manifests == 0
    assert source.is_file()
