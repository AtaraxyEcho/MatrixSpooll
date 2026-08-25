from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.middleware.csrf import CSRFMiddleware

pytestmark = pytest.mark.unit


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.add_middleware(CSRFMiddleware)

    @app.post("/api/v1/write")
    async def write() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/v1/auth/session")
    async def login() -> dict[str, bool]:
        return {"ok": True}

    return TestClient(app)


def test_cookie_authenticated_write_requires_csrf_header(client: TestClient) -> None:
    client.cookies.set("matrixspooll_auth_token", "session")
    client.cookies.set("matrixspooll_csrf_token", "csrf")

    response = client.post("/api/v1/write")

    assert response.status_code == 403


def test_matching_double_submit_token_allows_cookie_write(client: TestClient) -> None:
    client.cookies.set("matrixspooll_auth_token", "session")
    client.cookies.set("matrixspooll_csrf_token", "csrf")

    response = client.post("/api/v1/write", headers={"X-CSRF-Token": "csrf"})

    assert response.status_code == 200


def test_bearer_client_does_not_require_csrf_cookie(client: TestClient) -> None:
    response = client.post("/api/v1/write", headers={"Authorization": "Bearer api-token"})

    assert response.status_code == 200


def test_browser_login_endpoint_is_exempt(client: TestClient) -> None:
    client.cookies.set("matrixspooll_auth_token", "stale-session")

    response = client.post("/api/v1/auth/session")

    assert response.status_code == 200
