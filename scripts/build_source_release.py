"""Build a versioned corresponding-source archive for authenticated delivery."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tomllib
import zipfile
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

_INCLUDED_DIRECTORIES = (
    "agent_runtime_profile",
    "alembic",
    "deploy",
    "docs",
    "frontend",
    "lib",
    "public",
    "scripts",
    "server",
    "tests",
    "website",
)
_INCLUDED_ROOT_FILES = (
    ".dockerignore",
    ".editorconfig",
    ".gitignore",
    ".pre-commit-config.yaml",
    ".python-version",
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTEXT.md",
    "CONTRIBUTING.md",
    "Dockerfile",
    "LICENSE",
    "NOTICE",
    "README.en.md",
    "README.md",
    "DISCLAIMER.en.md",
    "DISCLAIMER.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "alembic.ini",
    "pyproject.toml",
    "uv.lock",
)
_EXCLUDED_DIRECTORY_NAMES = {
    ".claude",
    ".docusaurus",
    ".git",
    ".mypy_cache",
    ".pytest-tmp",
    ".pytest_cache",
    ".ruff_cache",
    ".test-artifacts",
    ".tmp",
    ".venv",
    "__pycache__",
    "build",
    "certs",
    "claude_data",
    "coverage",
    "dist",
    "htmlcov",
    "legal-source",
    "letsencrypt",
    "logs",
    "node_modules",
    "pgdata",
    "projects",
    "vertex_keys",
}
_EXCLUDED_FILE_SUFFIXES = (".db", ".log", ".pyc", ".pyo", ".pem", ".key", ".p12", ".pfx")
_VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
_ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)


def read_project_version(project_root: Path) -> str:
    raw = tomllib.loads((project_root / "pyproject.toml").read_text(encoding="utf-8"))
    version = raw.get("project", {}).get("version")
    if not isinstance(version, str) or _VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError("pyproject.toml does not contain a safe project version")
    return version


def resolve_release_version(project_root: Path, explicit_version: str | None = None) -> str:
    version = explicit_version or os.getenv("MATRIXSPOOLL_VERSION") or read_project_version(project_root)
    if _VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError("version contains unsafe characters")
    return version


def _is_excluded(relative_path: Path) -> bool:
    if any(part in _EXCLUDED_DIRECTORY_NAMES or part.startswith(".tmp-") for part in relative_path.parts[:-1]):
        return True
    name = relative_path.name
    lower_name = name.lower()
    if name.startswith("~$") or lower_name.endswith(_EXCLUDED_FILE_SUFFIXES):
        return True
    if lower_name == ".env" or (lower_name.startswith(".env.") and lower_name != ".env.example"):
        return True
    return False


def iter_source_files(project_root: Path) -> Iterable[Path]:
    candidates: list[Path] = []
    for name in _INCLUDED_ROOT_FILES:
        path = project_root / name
        if path.is_file() and not path.is_symlink():
            candidates.append(path)

    for directory_name in _INCLUDED_DIRECTORIES:
        directory = project_root / directory_name
        if not directory.is_dir() or directory.is_symlink():
            continue
        for current_root, directory_names, file_names in os.walk(directory, topdown=True, followlinks=False):
            current = Path(current_root)
            directory_names[:] = [
                name
                for name in directory_names
                if name not in _EXCLUDED_DIRECTORY_NAMES
                and not name.startswith(".tmp-")
                and not (current / name).is_symlink()
            ]
            for file_name in file_names:
                path = current / file_name
                relative_path = path.relative_to(project_root)
                if not path.is_symlink() and not _is_excluded(relative_path):
                    candidates.append(path)

    yield from sorted(set(candidates), key=lambda path: path.relative_to(project_root).as_posix())


def _write_archive(project_root: Path, archive_path: Path, files: Iterable[Path]) -> None:
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            relative_path = path.relative_to(project_root).as_posix()
            info = zipfile.ZipInfo(f"MatrixSpooll/{relative_path}", date_time=_ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            executable = path.suffix == ".sh" or os.access(path, os.X_OK)
            info.external_attr = ((0o755 if executable else 0o644) & 0xFFFF) << 16
            archive.writestr(info, path.read_bytes())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_source_release(project_root: Path, output_dir: Path, version: str | None = None) -> dict[str, object]:
    root = project_root.resolve()
    release_version = resolve_release_version(root, version)

    output = output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive_name = f"matrixspooll-source-{release_version}.zip"
    archive_path = output / archive_name
    files = list(iter_source_files(root))
    if not files:
        raise ValueError("source file allowlist did not match any files")

    temporary_archive = output / f".{archive_name}.tmp"
    try:
        _write_archive(root, temporary_archive, files)
        temporary_archive.replace(archive_path)
    finally:
        temporary_archive.unlink(missing_ok=True)

    digest = _sha256(archive_path)
    created_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    manifest: dict[str, object] = {
        "schema_version": 1,
        "product": "MatrixSpooll",
        "version": release_version,
        "archive": archive_name,
        "sha256": digest,
        "created_at": created_at,
        "file_count": len(files),
    }
    (output / "source-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (output / "SHA256SUMS").write_text(f"{digest}  {archive_name}\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output-dir", type=Path, default=Path("deploy/production/legal-source"))
    parser.add_argument("--version")
    args = parser.parse_args()
    manifest = build_source_release(args.project_root, args.output_dir, args.version)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
