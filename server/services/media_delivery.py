"""Private, cache-aware delivery for project media files.

The project media endpoints are authenticated, so responses must never be
marked public even when the path contains a version or content hash.  This
module keeps cache validators and single-range video delivery in one place so
routers do not each implement slightly different HTTP semantics.
"""

from __future__ import annotations

import email.utils
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Request
from fastapi.responses import Response, StreamingResponse
from starlette.responses import FileResponse

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_CHUNK_SIZE = 1024 * 1024


def media_validators(path: Path, *, immutable: bool = False) -> dict[str, str]:
    """Return stable validators for one immutable file version."""

    stat = path.stat()
    # mtime_ns and size are sufficient for the local-disk versioned media
    # contract and avoid hashing large videos on every request.
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    modified = datetime.fromtimestamp(stat.st_mtime, tz=UTC)
    return {
        "ETag": etag,
        "Last-Modified": email.utils.format_datetime(modified, usegmt=True),
        "Cache-Control": (
            "private, max-age=31536000, immutable" if immutable else "private, max-age=0, must-revalidate"
        ),
        "Accept-Ranges": "bytes",
    }


def _not_modified(request: Request, headers: dict[str, str], modified_timestamp: float) -> bool:
    if request.headers.get("if-none-match") == headers["ETag"]:
        return True
    modified = request.headers.get("if-modified-since")
    if not modified:
        return False
    try:
        requested = email.utils.parsedate_to_datetime(modified)
    except (TypeError, ValueError, IndexError):
        return False
    if requested.tzinfo is None:
        requested = requested.replace(tzinfo=UTC)
    modified_at = datetime.fromtimestamp(modified_timestamp, tz=UTC).replace(microsecond=0)
    return requested >= modified_at


def _range_representation_is_current(
    request: Request,
    headers: dict[str, str],
    modified_timestamp: float,
) -> bool:
    """Return whether a byte range targets the representation now on disk."""

    if_range = request.headers.get("if-range")
    if if_range:
        if if_range.startswith(('"', "W/")):
            return if_range == headers["ETag"]
        try:
            requested = email.utils.parsedate_to_datetime(if_range)
        except (TypeError, ValueError, IndexError):
            return False
        if requested.tzinfo is None:
            requested = requested.replace(tzinfo=UTC)
        modified_at = datetime.fromtimestamp(modified_timestamp, tz=UTC).replace(microsecond=0)
        return requested >= modified_at

    if_none_match = request.headers.get("if-none-match")
    if not if_none_match:
        return True
    validators = {value.strip() for value in if_none_match.split(",")}
    return "*" in validators or headers["ETag"] in validators


def _parse_range(value: str | None, size: int) -> tuple[int, int] | None:
    """Parse a single HTTP byte range, returning inclusive offsets."""

    if not value:
        return None
    match = _RANGE_RE.fullmatch(value.strip())
    if match is None:
        raise ValueError("invalid range")
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        raise ValueError("invalid range")
    if not start_text:
        suffix = int(end_text)
        if suffix <= 0:
            raise ValueError("invalid range")
        return max(0, size - suffix), size - 1
    start = int(start_text)
    if start >= size:
        raise ValueError("range outside file")
    end = int(end_text) if end_text else size - 1
    if end < start:
        raise ValueError("invalid range")
    return start, min(end, size - 1)


def _iter_range(path: Path, start: int, end: int) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as stream:
        stream.seek(start)
        while remaining:
            chunk = stream.read(min(_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def serve_media_file(
    path: Path,
    request: Request,
    *,
    media_type: str | None = None,
    immutable: bool = False,
) -> Response:
    """Build a private file response with validators and single-range support."""

    stat = path.stat()
    headers = media_validators(path, immutable=immutable)
    if _not_modified(request, headers, stat.st_mtime):
        return Response(status_code=304, headers=headers)

    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=media_type, headers=headers)
    if not _range_representation_is_current(request, headers, stat.st_mtime):
        return FileResponse(path, media_type=media_type, headers=headers)

    try:
        start, end = _parse_range(range_header, stat.st_size) or (0, stat.st_size - 1)
    except ValueError:
        invalid_headers = {**headers, "Content-Range": f"bytes */{stat.st_size}"}
        return Response(status_code=416, headers=invalid_headers)

    length = end - start + 1
    range_headers = {
        **headers,
        "Content-Length": str(length),
        "Content-Range": f"bytes {start}-{end}/{stat.st_size}",
    }
    if request.method == "HEAD":
        return Response(status_code=206, headers=range_headers, media_type=media_type)
    return StreamingResponse(
        _iter_range(path, start, end),
        status_code=206,
        headers=range_headers,
        media_type=media_type,
    )
