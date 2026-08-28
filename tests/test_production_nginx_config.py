from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

PROJECT_ROOT = Path(__file__).resolve().parents[1]
HTTPS_TEMPLATE = PROJECT_ROOT / "deploy" / "production" / "nginx" / "https.conf.template"


def test_docs_login_redirect_uses_the_public_https_endpoint() -> None:
    template = HTTPS_TEMPLATE.read_text(encoding="utf-8")

    assert "return 302 https://${PUBLIC_HOST}/login?from=$uri;" in template
    assert "return 302 /login?from=$request_uri;" not in template


def test_docs_trailing_slash_redirect_uses_the_public_https_endpoint() -> None:
    template = HTTPS_TEMPLATE.read_text(encoding="utf-8")

    assert "return 308 https://${PUBLIC_HOST}/docs/;" in template
    assert "return 308 /docs/;" not in template


def test_docs_auth_uses_the_browser_cookie_without_forwarding_it_to_docs() -> None:
    template = HTTPS_TEMPLATE.read_text(encoding="utf-8")
    auth_location = template.split("location = /_matrixspooll_docs_auth {", 1)[1].split("location = /docs {", 1)[0]
    docs_location = template.split("location ^~ /docs/ {", 1)[1].split("location @docs_login", 1)[0]

    assert "proxy_set_header Cookie $http_cookie;" in auth_location
    assert 'proxy_set_header Cookie "";' in docs_location
