"""
API Key 管理路由集成测试

通过 TestClient 测试 POST/GET/DELETE /api/v1/api-keys 端点。
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.auth import CurrentUserInfo, get_current_user
from server.routers import api_keys
from tests.auth_deps import AUTH_DEPENDENCIES

pytestmark = pytest.mark.unit


def _make_client() -> TestClient:
    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="default", sub="testuser", role="admin")
    app.include_router(api_keys.router, prefix="/api/v1", dependencies=AUTH_DEPENDENCIES)
    return TestClient(app)


FAKE_ROW = {
    "id": "key-1",
    "user_id": "default",
    "name": "mykey",
    "key_prefix": "msp-abcd",
    "created_at": "2026-03-10T00:00:00Z",
    "expires_at": "2026-04-10T00:00:00Z",
    "revoked_at": None,
    "last_used_at": None,
}

FAKE_ROW_WITH_HASH = {**FAKE_ROW, "key_hash": "abc123hash"}


class TestCreateApiKey:
    def test_create_returns_201_and_key(self):
        with _make_client() as client:
            mock_repo = AsyncMock()
            mock_repo.create = AsyncMock(return_value=FAKE_ROW)

            mock_session = AsyncMock()
            mock_session.add = MagicMock()
            mock_begin = AsyncMock()
            mock_begin.__aenter__ = AsyncMock(return_value=None)
            mock_begin.__aexit__ = AsyncMock(return_value=False)
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock(return_value=False)
            mock_session.begin = lambda: mock_begin

            with (
                patch("server.routers.api_keys.async_session_factory", return_value=mock_session),
                patch("server.routers.api_keys.ApiKeyRepository", return_value=mock_repo),
            ):
                resp = client.post("/api/v1/api-keys", json={"name": "mykey"})

        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "mykey"
        assert body["key"].startswith("msp-")
        assert "key" in body  # 完整 key 在响应中
        mock_repo.create.assert_awaited_once()
        assert mock_repo.create.await_args.kwargs["user_id"] == "default"

    def test_create_409_on_duplicate_name(self):
        from sqlalchemy.exc import IntegrityError

        with _make_client() as client:
            mock_repo = AsyncMock()
            mock_repo.create = AsyncMock(side_effect=IntegrityError("UNIQUE", None, Exception("duplicate")))

            mock_session = AsyncMock()
            mock_session.add = MagicMock()
            mock_begin = AsyncMock()
            mock_begin.__aenter__ = AsyncMock(return_value=None)
            mock_begin.__aexit__ = AsyncMock(return_value=False)
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock(return_value=False)
            mock_session.begin = lambda: mock_begin

            with (
                patch("server.routers.api_keys.async_session_factory", return_value=mock_session),
                patch("server.routers.api_keys.ApiKeyRepository", return_value=mock_repo),
            ):
                resp = client.post("/api/v1/api-keys", json={"name": "mykey"})

        assert resp.status_code == 409


class TestListApiKeys:
    def test_list_returns_200(self):
        with _make_client() as client:
            mock_repo = AsyncMock()
            mock_repo.list_all = AsyncMock(return_value=[FAKE_ROW])

            mock_session = AsyncMock()
            mock_session.add = MagicMock()
            mock_begin = AsyncMock()
            mock_begin.__aenter__ = AsyncMock(return_value=None)
            mock_begin.__aexit__ = AsyncMock(return_value=False)
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock(return_value=False)
            mock_session.begin = lambda: mock_begin

            with (
                patch("server.routers.api_keys.async_session_factory", return_value=mock_session),
                patch("server.routers.api_keys.ApiKeyRepository", return_value=mock_repo),
            ):
                resp = client.get("/api/v1/api-keys")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["name"] == "mykey"
        assert "key" not in body[0]  # 完整 key 不在列表响应中


class TestDeleteApiKey:
    def test_delete_returns_204(self):
        with _make_client() as client:
            mock_repo = AsyncMock()
            mock_repo.get_by_id = AsyncMock(return_value=FAKE_ROW_WITH_HASH)
            mock_repo.revoke = AsyncMock(return_value=True)

            mock_session = AsyncMock()
            mock_session.add = MagicMock()
            mock_begin = AsyncMock()
            mock_begin.__aenter__ = AsyncMock(return_value=None)
            mock_begin.__aexit__ = AsyncMock(return_value=False)
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock(return_value=False)
            mock_session.begin = lambda: mock_begin

            with (
                patch("server.routers.api_keys.async_session_factory", return_value=mock_session),
                patch("server.routers.api_keys.ApiKeyRepository", return_value=mock_repo),
                patch("server.routers.api_keys.invalidate_api_key_cache") as mock_invalidate,
            ):
                resp = client.delete("/api/v1/api-keys/key-1")
                assert mock_invalidate.call_count == 2
                mock_invalidate.assert_called_with("abc123hash")

        assert resp.status_code == 204

    def test_delete_404_on_missing_key(self):
        with _make_client() as client:
            mock_repo = AsyncMock()
            mock_repo.get_by_id = AsyncMock(return_value=None)

            mock_session = AsyncMock()
            mock_session.add = MagicMock()
            mock_begin = AsyncMock()
            mock_begin.__aenter__ = AsyncMock(return_value=None)
            mock_begin.__aexit__ = AsyncMock(return_value=False)
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock(return_value=False)
            mock_session.begin = lambda: mock_begin

            with (
                patch("server.routers.api_keys.async_session_factory", return_value=mock_session),
                patch("server.routers.api_keys.ApiKeyRepository", return_value=mock_repo),
            ):
                resp = client.delete("/api/v1/api-keys/key-missing")

        assert resp.status_code == 404
