"""CSRF protection for browser cookie sessions."""

from __future__ import annotations

import secrets
from urllib.parse import urlsplit

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
# 登录端点必须豁免双提交校验（此刻还没有会话 Cookie），但它们是 Login CSRF 的入口：
# 恶意站点用隐藏 <form> 自动提交攻击者凭据，受害者浏览器就会静默切到攻击者账号。
# 跨站表单无法伪造 Sec-Fetch-Site / Origin，故对这几个路径单独做同源校验。
_LOGIN_PATHS = frozenset({"/api/v1/auth/session"})


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
        if self._rejects_cross_site_login(request):
            response = JSONResponse(
                {"detail": _("csrf_invalid", locale=get_locale(request))},
                status_code=403,
            )
            await response(scope, receive, send)
            return

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
    def _rejects_cross_site_login(request: Request) -> bool:
        """登录端点拒绝跨站提交（Login CSRF）。

        ``Sec-Fetch-Site`` 是浏览器自动附加、页面无法改写的请求元数据；缺失该头
        （旧浏览器 / 非浏览器客户端）时退回比对 ``Origin`` 的 host。两者都没有
        （curl、测试客户端、原生 App）时放行——这类调用不带浏览器 Cookie，构不成
        登录 CSRF。只比 host 不比 scheme：反代终止 TLS 时后端看到的 scheme 可能是
        http，过度严格会把正常登录挡在门外。
        """
        if request.method.upper() in _SAFE_METHODS or request.url.path not in _LOGIN_PATHS:
            return False
        fetch_site = request.headers.get("sec-fetch-site", "").strip().lower()
        if fetch_site == "cross-site":
            return True
        origin = request.headers.get("origin")
        if not origin:
            return False
        if origin == "null":
            return True
        origin_host = urlsplit(origin).hostname
        if not origin_host:
            return True
        return origin_host.lower() != (request.url.hostname or "").lower()

    @staticmethod
    def _requires_validation(request: Request) -> bool:
        if request.method.upper() in _SAFE_METHODS or request.url.path in _EXEMPT_PATHS:
            return False
        if not request.cookies.get(AUTH_COOKIE_NAME):
            return False
        authorization = request.headers.get("authorization", "")
        return not authorization.lower().startswith("bearer ")
