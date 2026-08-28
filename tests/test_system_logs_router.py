"""GET /api/v1/system/logs/download 行为测试。"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

pytestmark = pytest.mark.unit


@pytest.fixture
def auth_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "false")


# 三处 importlib.reload(app_module)：FastAPI app 在 import 时立刻 mount router 与读取 env，
# monkeypatch 设的 env 要在测试中生效必须让 server.app 重新走一次顶层代码。这一点与
# tests/test_logging_persistence.py 不同——那里 setup_logging() 在每次调用都重新读 env，
# 不需要 reload。
@pytest.fixture
async def _client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, auth_disabled: None):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setenv("MATRIXSPOOLL_LOG_DIR", str(log_dir))
    monkeypatch.setenv("MATRIXSPOOLL_DATA_DIR", str(tmp_path / "data"))
    from lib.app_data_dir import _reset_for_tests

    _reset_for_tests()

    import importlib

    from server import app as app_module

    importlib.reload(app_module)

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, log_dir


async def test_download_returns_zip(_client) -> None:
    client, log_dir = _client
    (log_dir / "matrixspooll.log").write_text("test log line\n", encoding="utf-8")
    res = await client.get("/api/v1/system/logs/download")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    assert "attachment" in res.headers.get("content-disposition", "")


async def test_legal_attribution_is_loaded_from_notice(_client) -> None:
    client, _log_dir = _client

    res = await client.get("/api/v1/system/legal-attribution")

    assert res.status_code == 200
    payload = res.json()
    assert payload["attribution"].startswith("Powered by ")
    assert payload["repository_url"] in payload["attribution"]


async def test_legal_disclosure_reports_missing_source_release(_client, monkeypatch, tmp_path: Path) -> None:
    client, _log_dir = _client
    monkeypatch.setenv("MATRIXSPOOLL_SOURCE_RELEASE_DIR", str(tmp_path / "missing-source"))

    res = await client.get("/api/v1/system/legal-disclosure")

    assert res.status_code == 200
    payload = res.json()
    assert payload["modified_product"] == "MatrixSpooll"
    assert payload["source_release"] == {
        "enabled": True,
        "available": False,
        "version": None,
        "archive_name": None,
        "sha256": None,
        "created_at": None,
        "download_url": None,
    }


async def test_source_download_disabled_blocks_existing_archive(_client, monkeypatch, tmp_path: Path) -> None:
    client, _log_dir = _client
    archive = tmp_path / "matrixspooll-source-1.2.0.zip"
    archive.write_bytes(b"zip")
    (tmp_path / "source-manifest.json").write_text(
        '{"schema_version":1,"version":"1.2.0",'
        '"archive":"matrixspooll-source-1.2.0.zip",'
        '"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
        '"created_at":"2026-08-28T00:00:00Z"}',
        encoding="utf-8",
    )
    monkeypatch.setenv("MATRIXSPOOLL_SOURCE_RELEASE_DIR", str(tmp_path))
    monkeypatch.setenv("MATRIXSPOOLL_SOURCE_DOWNLOAD_ENABLED", "false")

    disclosure = await client.get("/api/v1/system/legal-disclosure")
    download = await client.get("/api/v1/system/source-code/download")

    assert disclosure.status_code == 200
    assert disclosure.json()["source_release"] == {
        "enabled": False,
        "available": False,
        "version": None,
        "archive_name": None,
        "sha256": None,
        "created_at": None,
        "download_url": None,
    }
    assert download.status_code == 404


async def test_zip_contains_diagnostics(_client) -> None:
    client, _log_dir = _client
    res = await client.get("/api/v1/system/logs/download")
    z = zipfile.ZipFile(io.BytesIO(res.content))
    assert "diagnostics.txt" in z.namelist()
    diag = z.read("diagnostics.txt").decode("utf-8")
    assert "App version" in diag


async def test_zip_includes_log_files(_client) -> None:
    client, log_dir = _client
    (log_dir / "matrixspooll.log").write_text("active log\n", encoding="utf-8")
    (log_dir / "matrixspooll.log.2026-05-15").write_text("archived log\n", encoding="utf-8")
    res = await client.get("/api/v1/system/logs/download")
    z = zipfile.ZipFile(io.BytesIO(res.content))
    names = z.namelist()
    assert any(n.endswith("matrixspooll.log") for n in names)
    assert any(n.endswith("matrixspooll.log.2026-05-15") for n in names)


async def test_empty_logs_dir(_client) -> None:
    client, _ = _client
    res = await client.get("/api/v1/system/logs/download")
    assert res.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(res.content))
    assert z.namelist() == ["diagnostics.txt"]


async def test_oversized_file_skipped(_client) -> None:
    client, log_dir = _client
    big = log_dir / "matrixspooll.log.2026-05-10"
    with big.open("wb") as f:
        f.seek(101 * 1024 * 1024 - 1)
        f.write(b"\0")

    res = await client.get("/api/v1/system/logs/download")
    z = zipfile.ZipFile(io.BytesIO(res.content))
    diag = z.read("diagnostics.txt").decode("utf-8")
    assert "skipped: too large" in diag
    assert big.name in diag
    assert big.name not in z.namelist()


async def test_missing_logs_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, auth_disabled: None) -> None:
    # log_dir 故意不创建
    log_dir = tmp_path / "logs"
    assert not log_dir.exists()
    monkeypatch.setenv("MATRIXSPOOLL_LOG_DIR", str(log_dir))
    monkeypatch.setenv("MATRIXSPOOLL_DATA_DIR", str(tmp_path / "data"))
    from lib.app_data_dir import _reset_for_tests

    _reset_for_tests()

    import importlib

    from server import app as app_module

    importlib.reload(app_module)

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/system/logs/download")
        assert res.status_code == 200
        z = zipfile.ZipFile(io.BytesIO(res.content))
        assert z.namelist() == ["diagnostics.txt"]


async def test_download_requires_auth(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_USERNAME", "admin")
    monkeypatch.setenv("AUTH_PASSWORD", "hunter2")
    monkeypatch.setenv("AUTH_TOKEN_SECRET", "test-secret-32-chars-long-xxxxx")
    monkeypatch.setenv("MATRIXSPOOLL_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("MATRIXSPOOLL_DATA_DIR", str(tmp_path / "data"))
    from lib.app_data_dir import _reset_for_tests

    _reset_for_tests()

    import importlib

    from server import app as app_module

    importlib.reload(app_module)

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/system/logs/download")
        assert res.status_code == 401
