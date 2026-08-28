"""系统级端点：诊断日志打包下载。"""

from __future__ import annotations

import json
import logging
import tempfile
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from lib.env_init import PROJECT_ROOT
from lib.i18n import Translator
from lib.legal_notice import read_legal_attribution, read_modified_version_notice, read_source_release
from lib.logging_config import resolve_log_dir
from server.auth import AdminUser
from server.services.diagnostics import collect_diagnostics

router = APIRouter()
logger = logging.getLogger(__name__)

_MAX_FILE_BYTES = 100 * 1024 * 1024
_SPOOL_MAX = 50 * 1024 * 1024
_LOG_GLOB = "matrixspooll.log*"


class LegalAttributionResponse(BaseModel):
    attribution: str
    repository_url: str


class SourceReleaseResponse(BaseModel):
    available: bool
    version: str | None = None
    archive_name: str | None = None
    sha256: str | None = None
    created_at: str | None = None
    download_url: str | None = None


class LegalDisclosureResponse(BaseModel):
    attribution: str
    repository_url: str
    license_name: str
    license_download_url: str
    modified_product: str
    modified_by: str
    modification_date: str
    source_release: SourceReleaseResponse


@router.get("/system/legal-attribution", response_model=LegalAttributionResponse)
async def get_legal_attribution(_t: Translator) -> LegalAttributionResponse:
    """Return the UI attribution whose source of truth is the bundled NOTICE."""
    try:
        attribution = read_legal_attribution()
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=_t("legal_notice_unavailable")) from exc
    return LegalAttributionResponse(
        attribution=attribution.attribution,
        repository_url=attribution.repository_url,
    )


@router.get("/system/legal-disclosure", response_model=LegalDisclosureResponse)
async def get_legal_disclosure(_t: Translator) -> LegalDisclosureResponse:
    """Return legal notices and current corresponding-source availability."""
    try:
        attribution = read_legal_attribution()
        modified = read_modified_version_notice()
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=_t("legal_notice_unavailable")) from exc

    source_response = SourceReleaseResponse(available=False)
    try:
        source = read_source_release()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("Invalid source release manifest: %s", exc)
    else:
        if source is not None:
            source_response = SourceReleaseResponse(
                available=True,
                version=source.version,
                archive_name=source.archive_name,
                sha256=source.sha256,
                created_at=source.created_at,
                download_url="/api/v1/system/source-code/download",
            )

    return LegalDisclosureResponse(
        attribution=attribution.attribution,
        repository_url=attribution.repository_url,
        license_name="GNU Affero General Public License v3.0",
        license_download_url="/api/v1/system/license/download",
        modified_product=modified.product,
        modified_by=modified.modified_by,
        modification_date=modified.modification_date,
        source_release=source_response,
    )


@router.get("/system/license/download")
async def download_license(_t: Translator) -> FileResponse:
    license_path = PROJECT_ROOT / "LICENSE"
    if not license_path.is_file():
        raise HTTPException(status_code=404, detail=_t("legal_notice_unavailable"))
    return FileResponse(license_path, media_type="text/plain; charset=utf-8", filename="LICENSE")


@router.get("/system/source-code/download")
async def download_source_code(_t: Translator) -> FileResponse:
    try:
        source = read_source_release()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("Invalid source release manifest: %s", exc)
        source = None
    if source is None:
        raise HTTPException(status_code=404, detail=_t("source_release_unavailable"))
    return FileResponse(
        source.archive_path,
        media_type="application/zip",
        filename=source.archive_name,
        headers={"X-Checksum-SHA256": source.sha256},
    )


@router.get("/system/logs/download")
async def download_logs(_t: Translator, _admin: AdminUser) -> StreamingResponse:
    """打包返回 logs/ 目录所有文件 + diagnostics.txt。"""
    log_dir = resolve_log_dir()
    diagnostics_lines: list[str] = []

    spooled = tempfile.SpooledTemporaryFile(max_size=_SPOOL_MAX)
    try:
        with zipfile.ZipFile(spooled, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            if log_dir.exists():
                for path in sorted(log_dir.glob(_LOG_GLOB)):
                    # 跳过 symlink：防止有人在 logs/ 下放符号链接指向目录外的敏感文件，
                    # 通过诊断包外泄。
                    if path.is_symlink() or not path.is_file():
                        continue
                    size = path.stat().st_size
                    if size > _MAX_FILE_BYTES:
                        diagnostics_lines.append(f"[skipped: too large: {path.name} ({size} bytes)]")
                        continue
                    zf.write(path, arcname=f"logs/{path.name}")

            diagnostics_text = collect_diagnostics()
            if diagnostics_lines:
                diagnostics_text += "\n" + "\n".join(diagnostics_lines) + "\n"
            zf.writestr("diagnostics.txt", diagnostics_text)

        spooled.seek(0)
    except Exception:
        spooled.close()
        raise

    ts = datetime.now(UTC).strftime("%Y-%m-%d-%H%MZ")
    filename = f"matrixspooll-diagnostics-{ts}.zip"

    def _iter() -> Iterator[bytes]:
        try:
            while chunk := spooled.read(64 * 1024):
                yield chunk
        finally:
            spooled.close()

    return StreamingResponse(
        _iter(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
