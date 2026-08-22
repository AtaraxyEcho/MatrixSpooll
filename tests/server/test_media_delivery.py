from __future__ import annotations

from pathlib import Path

import pytest
from starlette.requests import Request

from server.services.media_delivery import serve_media_file


def _request(*, headers: dict[str, str] | None = None, method: str = "GET") -> Request:
    return Request(
        {
            "type": "http",
            "method": method,
            "path": "/media",
            "headers": [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()],
            "query_string": b"",
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("testclient", 1234),
            "root_path": "",
        }
    )


async def _body(response) -> bytes:
    chunks: list[bytes] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_private_media_validators_and_range(tmp_path: Path) -> None:
    path = tmp_path / "sample.mp4"
    path.write_bytes(b"0123456789")

    response = serve_media_file(
        path,
        _request(headers={"Range": "bytes=2-5"}),
        media_type="video/mp4",
        immutable=True,
    )
    assert response.status_code == 206
    assert response.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert await _body(response) == b"2345"

    full = serve_media_file(path, _request(), media_type="video/mp4")
    assert full.status_code == 200
    assert full.headers["cache-control"] == "private, max-age=0, must-revalidate"
    etag = full.headers["etag"]
    cached = serve_media_file(path, _request(headers={"If-None-Match": etag}), media_type="video/mp4")
    assert cached.status_code == 304


@pytest.mark.unit
def test_invalid_media_range_returns_416(tmp_path: Path) -> None:
    path = tmp_path / "sample.mp4"
    path.write_bytes(b"0123456789")

    response = serve_media_file(path, _request(headers={"Range": "bytes=20-30"}), media_type="video/mp4")
    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */10"
