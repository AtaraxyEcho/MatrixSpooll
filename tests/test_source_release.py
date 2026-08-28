from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from scripts.build_source_release import build_source_release

pytestmark = pytest.mark.unit


def test_build_source_release_excludes_runtime_and_secret_files(tmp_path: Path) -> None:
    root = tmp_path / "project"
    output = root / "deploy" / "production" / "legal-source"
    (root / "lib").mkdir(parents=True)
    (root / "deploy" / "production").mkdir(parents=True)
    (root / "projects").mkdir()
    (root / "lib" / "module.py").write_text("VALUE = 1\n", encoding="utf-8")
    (root / "README.md").write_text("# Project\n", encoding="utf-8")
    (root / "pyproject.toml").write_text('[project]\nname = "matrixspooll"\nversion = "1.2.0"\n', encoding="utf-8")
    (root / ".env").write_text("SECRET=value\n", encoding="utf-8")
    (root / "projects" / "private.json").write_text("{}", encoding="utf-8")

    manifest = build_source_release(root, output)

    archive = output / str(manifest["archive"])
    with zipfile.ZipFile(archive) as package:
        names = package.namelist()
    assert "MatrixSpooll/lib/module.py" in names
    assert "MatrixSpooll/.env" not in names
    assert all("projects/private.json" not in name for name in names)
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["sha256"]
    assert json.loads((output / "source-manifest.json").read_text(encoding="utf-8"))["version"] == "1.2.0"


def test_build_source_release_prefers_delivery_version_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    output = root / "deploy" / "production" / "legal-source"
    (root / "lib").mkdir(parents=True)
    (root / "lib" / "module.py").write_text("VALUE = 1\n", encoding="utf-8")
    (root / "pyproject.toml").write_text(
        '[project]\nname = "matrixspooll"\nversion = "0.26.0"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("MATRIXSPOOLL_VERSION", "1.2.0")

    manifest = build_source_release(root, output)

    assert manifest["version"] == "1.2.0"
    assert manifest["archive"] == "matrixspooll-source-1.2.0.zip"
