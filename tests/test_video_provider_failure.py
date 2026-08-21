"""Structured persistence and localization for runtime video-provider rejections."""

from __future__ import annotations

import pytest

from lib.generation_worker import _encode_task_failure_message
from lib.i18n import MESSAGES
from lib.i18n import _ as translate_message
from lib.task_failure import FAILURE_CODE_KEYS, PROVIDER_FAILURE_CODES, render_failure
from lib.video_backends.base import VideoProviderError

pytestmark = pytest.mark.unit


def _translator(locale: str):
    def translate(key: str, **params) -> str:
        return translate_message(key, locale=locale, **params)

    return translate


@pytest.mark.parametrize("code", sorted(PROVIDER_FAILURE_CODES))
def test_provider_failure_codes_are_machine_encodable_in_all_locales(code: str) -> None:
    assert FAILURE_CODE_KEYS[code] == code
    for locale in ("zh", "en", "vi"):
        assert code in MESSAGES[locale], f"{locale} missing {code}"


def test_provider_rejection_uses_structured_task_failure_encoding() -> None:
    stored = _encode_task_failure_message(VideoProviderError("video_first_frame_content_rejected"))

    assert stored == "[video_first_frame_content_rejected]"
    assert "first frame" in render_failure(stored, _translator("en")).lower()
