"""
登录 API 路由测试

测试 server.routers.auth 中的登录和 token 验证路由。
"""

import os
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import server.auth as auth_module
from server.routers import auth as auth_router
from server.security.login_throttle import ACCOUNT_LOGIN_THROTTLE, reset_login_throttles
from tests.auth_deps import AUTH_DEPENDENCIES

pytestmark = pytest.mark.unit


@pytest.fixture()
def client():
    """创建测试客户端，设置固定的认证环境变量"""
    reset_login_throttles()
    auth_module._cached_token_secret = None
    auth_module._cached_password_hash = None
    with patch.dict(
        os.environ,
        {
            "AUTH_USERNAME": "testuser",
            "AUTH_PASSWORD": "testpass",
            "AUTH_TOKEN_SECRET": "test-router-secret-key-at-least-32-bytes-long",
        },
    ):
        app = FastAPI()
        app.include_router(auth_router.router, prefix="/api/v1", dependencies=AUTH_DEPENDENCIES)
        app.include_router(auth_router.public_router, prefix="/api/v1")
        with TestClient(app) as c:
            yield c
    reset_login_throttles()


class TestLoginRoute:
    def test_login_success(self, client):
        """正确凭据返回 200 + access_token"""
        resp = client.post(
            "/api/v1/auth/token",
            data={"username": "testuser", "password": "testpass"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert len(data["access_token"]) > 0
        assert "matrixspooll_auth_token" not in resp.cookies

    def test_browser_session_uses_httponly_cookie_without_exposing_bearer(self, client):
        resp = client.post(
            "/api/v1/auth/session",
            data={"username": "testuser", "password": "testpass"},
        )

        assert resp.status_code == 200
        assert "access_token" not in resp.json()
        assert resp.json()["username"] == "testuser"
        assert resp.cookies["matrixspooll_auth_token"]
        assert resp.cookies["matrixspooll_csrf_token"]
        auth_cookie = next(
            value for value in resp.headers.get_list("set-cookie") if value.startswith("matrixspooll_auth_token=")
        )
        csrf_cookie = next(
            value for value in resp.headers.get_list("set-cookie") if value.startswith("matrixspooll_csrf_token=")
        )
        assert "httponly" in auth_cookie.lower()
        assert "httponly" not in csrf_cookie.lower()
        assert "path=/api/v1" in auth_cookie.lower()
        assert "path=/;" in csrf_cookie.lower()

    def test_legacy_bearer_can_be_exchanged_for_browser_session(self, client):
        token_response = client.post(
            "/api/v1/auth/token",
            data={"username": "testuser", "password": "testpass"},
        )
        token = token_response.json()["access_token"]

        response = client.post(
            "/api/v1/auth/session/exchange",
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 200
        assert response.json()["username"] == "testuser"
        assert response.cookies["matrixspooll_auth_token"] == token
        assert response.cookies["matrixspooll_csrf_token"]

    def test_login_wrong_password(self, client):
        """错误密码返回 401"""
        resp = client.post(
            "/api/v1/auth/token",
            data={"username": "testuser", "password": "wrongpass"},
        )
        assert resp.status_code == 401

    def test_login_wrong_username(self, client):
        """错误用户名返回 401"""
        resp = client.post(
            "/api/v1/auth/token",
            data={"username": "wronguser", "password": "testpass"},
        )
        assert resp.status_code == 401

    def test_repeated_failures_are_rate_limited(self, client):
        for _ in range(5):
            response = client.post(
                "/api/v1/auth/token",
                data={"username": "blocked-user", "password": "wrongpass"},
            )
            assert response.status_code == 401

        response = client.post(
            "/api/v1/auth/token",
            data={"username": "blocked-user", "password": "wrongpass"},
        )

        assert response.status_code == 429
        assert int(response.headers["retry-after"]) > 0

    def test_database_login_clears_account_failures(self, client, monkeypatch):
        async def _authenticate(_username: str, _password: str):
            return SimpleNamespace(
                id="00000000-0000-4000-8000-000000000001",
                username="testuser",
                role="member",
                nickname=None,
                avatar_path=None,
                email=None,
            )

        async def _create_session(*_args, **_kwargs):
            return SimpleNamespace(id="session-id")

        monkeypatch.setattr(auth_router, "database_auth_initialized", lambda: True)
        monkeypatch.setattr(auth_router, "authenticate_database_user", _authenticate)
        monkeypatch.setattr(auth_router, "create_user_session", _create_session)
        ACCOUNT_LOGIN_THROTTLE.record_failure("testuser")

        response = client.post(
            "/api/v1/auth/session",
            data={"username": "testuser", "password": "testpass"},
        )

        assert response.status_code == 200
        assert ACCOUNT_LOGIN_THROTTLE.retry_after("testuser") == 0


class TestVerifyRoute:
    def test_verify_valid_token(self, client):
        """有效 token 验证通过"""
        login_resp = client.post(
            "/api/v1/auth/token",
            data={"username": "testuser", "password": "testpass"},
        )
        token = login_resp.json()["access_token"]

        resp = client.get(
            "/api/v1/auth/verify",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["valid"] is True
        assert data["username"] == "testuser"

    def test_verify_no_token(self, client):
        """缺少 token 返回 401"""
        resp = client.get("/api/v1/auth/verify")
        assert resp.status_code == 401

    def test_verify_invalid_token(self, client):
        """无效 token 返回 401"""
        resp = client.get(
            "/api/v1/auth/verify",
            headers={"Authorization": "Bearer invalid-token"},
        )
        assert resp.status_code == 401

    def test_verify_accepts_browser_session_cookie(self, client):
        login_resp = client.post(
            "/api/v1/auth/session",
            data={"username": "testuser", "password": "testpass"},
        )
        assert login_resp.status_code == 200

        resp = client.get("/api/v1/auth/verify")

        assert resp.status_code == 200
        assert resp.json()["username"] == "testuser"
