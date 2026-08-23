"""Read the legally required attribution from the bundled NOTICE file."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from lib.env_init import PROJECT_ROOT

_ATTRIBUTION_PATTERN = re.compile(
    r'^"(?P<attribution>Powered by .+?[\u2014-]\s*(?P<repository_url>https://github\.com/[^\s"]+))"$',
    re.MULTILINE,
)


@dataclass(frozen=True, slots=True)
class LegalAttribution:
    attribution: str
    repository_url: str


def read_legal_attribution(notice_path: Path | None = None) -> LegalAttribution:
    """Extract the required UI attribution without duplicating it in source code."""
    path = notice_path or PROJECT_ROOT / "NOTICE"
    notice = path.read_text(encoding="utf-8")
    match = _ATTRIBUTION_PATTERN.search(notice)
    if match is None:
        raise ValueError("NOTICE does not contain a valid UI attribution")
    return LegalAttribution(
        attribution=match.group("attribution"),
        repository_url=match.group("repository_url"),
    )
