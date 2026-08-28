"""Read legal notices and the deploy-time source release manifest.

NOTICE remains the source of truth for the upstream attribution and the
modified-version notice.  Source archives are release artifacts mounted by the
operator, so their metadata lives in a small JSON manifest next to the archive.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from lib.env_init import PROJECT_ROOT

_ATTRIBUTION_PATTERN = re.compile(
    r'^"(?P<attribution>Powered by .+?[\u2014-]\s*(?P<repository_url>https://github\.com/[^\s"]+))"$',
    re.MULTILINE,
)
_MODIFIED_PRODUCT_PATTERN = re.compile(r"^Modified product:\s*(?P<value>.+?)\s*$", re.MULTILINE)
_MODIFIED_BY_PATTERN = re.compile(r"^Modified by:\s*(?P<value>.+?)\s*$", re.MULTILINE)
_MODIFICATION_DATE_PATTERN = re.compile(
    r"^Relevant modification date:\s*(?P<value>\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE
)
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_SOURCE_MANIFEST_NAME = "source-manifest.json"
_SOURCE_DOWNLOAD_ENABLED_ENV = "MATRIXSPOOLL_SOURCE_DOWNLOAD_ENABLED"
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES = frozenset({"0", "false", "no", "off"})


@dataclass(frozen=True, slots=True)
class LegalAttribution:
    attribution: str
    repository_url: str


@dataclass(frozen=True, slots=True)
class ModifiedVersionNotice:
    product: str
    modified_by: str
    modification_date: str


@dataclass(frozen=True, slots=True)
class SourceRelease:
    version: str
    archive_name: str
    sha256: str
    created_at: str
    archive_path: Path


def source_download_enabled() -> bool:
    """Return whether corresponding-source downloads are enabled for this deployment."""
    raw = os.environ.get(_SOURCE_DOWNLOAD_ENABLED_ENV, "true").strip().lower()
    if raw in _TRUE_VALUES:
        return True
    if raw in _FALSE_VALUES:
        return False
    valid = ", ".join(sorted(_TRUE_VALUES | _FALSE_VALUES))
    raise ValueError(f"{_SOURCE_DOWNLOAD_ENABLED_ENV} must be one of: {valid}")


def read_legal_attribution(notice_path: Path | None = None) -> LegalAttribution:
    """Extract the required UI attribution without duplicating it in source code."""
    path = notice_path or PROJECT_ROOT / "NOTICE"
    notice = path.read_text(encoding="utf-8")
    match = _ATTRIBUTION_PATTERN.search(notice)
    if match is None:
        raise ValueError("NOTICE does not contain a valid UI attribution")
    return LegalAttribution(
        attribution=match.group("attribution"),
        repository_url=match.group("repository_url"),
    )


def read_modified_version_notice(notice_path: Path | None = None) -> ModifiedVersionNotice:
    """Read the prominent modified-version declaration required by AGPLv3."""
    path = notice_path or PROJECT_ROOT / "NOTICE"
    notice = path.read_text(encoding="utf-8")
    product = _MODIFIED_PRODUCT_PATTERN.search(notice)
    modified_by = _MODIFIED_BY_PATTERN.search(notice)
    modification_date = _MODIFICATION_DATE_PATTERN.search(notice)
    if product is None or modified_by is None or modification_date is None:
        raise ValueError("NOTICE does not contain a valid modified-version notice")
    return ModifiedVersionNotice(
        product=product.group("value"),
        modified_by=modified_by.group("value"),
        modification_date=modification_date.group("value"),
    )


def source_release_directory() -> Path:
    """Return the operator-mounted directory containing source release artifacts."""
    configured = os.environ.get("MATRIXSPOOLL_SOURCE_RELEASE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (PROJECT_ROOT / "deploy" / "production" / "legal-source").resolve()


def read_source_release(source_dir: Path | None = None) -> SourceRelease | None:
    """Validate and read the current source release, or return ``None`` when absent."""
    directory = (source_dir or source_release_directory()).resolve()
    manifest_path = directory / _SOURCE_MANIFEST_NAME
    if not manifest_path.is_file():
        return None

    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise ValueError("source manifest has an unsupported schema")

    version = raw.get("version")
    archive = raw.get("archive")
    sha256_value = raw.get("sha256")
    created_at = raw.get("created_at")
    if (
        not isinstance(version, str)
        or not version.strip()
        or not isinstance(archive, str)
        or not archive.strip()
        or not isinstance(sha256_value, str)
        or not sha256_value.strip()
        or not isinstance(created_at, str)
        or not created_at.strip()
    ):
        raise ValueError("source manifest is missing required fields")

    archive_name = archive.strip()
    if Path(archive_name).name != archive_name or not archive_name.lower().endswith(".zip"):
        raise ValueError("source manifest contains an invalid archive name")
    sha256 = sha256_value.strip().lower()
    if _SHA256_PATTERN.fullmatch(sha256) is None:
        raise ValueError("source manifest contains an invalid SHA-256 digest")

    archive_path = (directory / archive_name).resolve()
    if archive_path.parent != directory or not archive_path.is_file():
        return None
    return SourceRelease(
        version=version.strip(),
        archive_name=archive_name,
        sha256=sha256,
        created_at=created_at.strip(),
        archive_path=archive_path,
    )
