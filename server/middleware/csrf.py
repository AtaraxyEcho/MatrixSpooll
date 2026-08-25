"""CSRF protection for browser cookie sessions."""

from __future__ import annotations

import secrets

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from lib.i18n import _, get_locale

AUTH_COOKIE_NAME = "matrixspooll_auth_token"
CSRF_COOKIE_NAME = "matrixspooll_csrf_token"
CSRF_HEADER_NAME = "x-csrf-token"

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
_EXEMPT_PATHS = frozenset(
    {
        "/api/v1/auth/session",
        "/api/v1/auth/token",
    }
)


class CSRFMiddleware:
    """Require a double-submit token for state changes made with auth cookies.

    Bearer clients remain stateless and are not subject to browser CSRF.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        if not self._requires_validation(request):
            await self.app(scope, receive, send)
            return

        cookie_token = request.cookies.get(CSRF_COOKIE_NAME, "")
        header_token = request.headers.get(CSRF_HEADER_NAME, "")
        if not cookie_token or not header_token or not secrets.compare_digest(cookie_token, header_token):
            response = JSONResponse(
                {"detail": _("csrf_invalid", locale=get_locale(request))},
                status_code=403,
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)

    @staticmethod
    def _requires_validation(request: Request) -> bool:
        if request.method.upper() in _SAFE_METHODS or request.url.path in _EXEMPT_PATHS:
            return False
        if not request.cookies.get(AUTH_COOKIE_NAME):
            return False
        authorization = request.headers.get("authorization", "")
        return not authorization.lower().startswith("bearer ")
