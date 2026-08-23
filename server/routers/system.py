"""系统级端点：诊断日志打包下载。"""

from __future__ import annotations

import tempfile
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lib.i18n import Translator
from lib.legal_notice import read_legal_attribution
from lib.logging_config import resolve_log_dir
from server.auth import AdminUser
from server.services.diagnostics import collect_diagnostics

router = APIRouter()

_MAX_FILE_BYTES = 100 * 1024 * 1024
_SPOOL_MAX = 50 * 1024 * 1024
_LOG_GLOB = "matrixspooll.log*"


class LegalAttributionResponse(BaseModel):
    attribution: str
    repository_url: str


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
