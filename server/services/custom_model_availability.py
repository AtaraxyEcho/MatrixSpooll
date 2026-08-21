"""Handle custom models that a provider explicitly rejects as unavailable."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any

from lib.custom_provider import is_custom_provider, parse_provider_id
from lib.db import safe_session_factory
from lib.db.repositories.custom_provider_repo import CustomProviderRepository

logger = logging.getLogger(__name__)


def is_model_access_error(exc: Any) -> bool:
    """Return whether a provider response identifies a missing/inaccessible model."""
    if getattr(exc, "status_code", None) != 404:
        return False

    body = getattr(exc, "body", None)
    try:
        body_text = json.dumps(body, ensure_ascii=False, default=str) if body is not None else ""
    except (TypeError, ValueError):
        body_text = str(body)
    text = f"{body_text} {exc}".casefold()
    model_signal = "model" in text or "endpoint" in text
    access_signal = any(
        marker in text
        for marker in (
            "does not exist",
            "not found",
            "notfound",
            "no access",
            "access to it",
            "permission",
            "unauthorized",
        )
    )
    return model_signal and access_signal


def model_id_from_task(task: Mapping[str, Any], provider_id: str) -> str | None:
    """Extract a model ID only when the task explicitly names this provider."""
    if not is_custom_provider(provider_id):
        return None

    payload = task.get("payload")
    if not isinstance(payload, Mapping):
        return None

    provider_prefix = f"{provider_id}/"
    for key in ("model", "video_model", "image_model", "audio_model", "model_id"):
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        value = value.strip()
        if value.startswith(provider_prefix):
            return value[len(provider_prefix) :]
        if "/" not in value:
            return value
    return None


async def quarantine_custom_model(
    task: Mapping[str, Any],
    provider_id: str,
    exc: Any,
    *,
    session_factory: Any = None,
) -> bool:
    """Disable a custom model after a deterministic provider access failure.

    The model and provider credentials remain intact so the settings UI can
    re-enable the model after access is granted.
    """
    if not is_model_access_error(exc):
        return False
    model_id = model_id_from_task(task, provider_id)
    if model_id is None:
        return False
    try:
        provider_db_id = parse_provider_id(provider_id)
    except (TypeError, ValueError):
        return False

    factory = session_factory or safe_session_factory
    try:
        async with factory() as session:
            model = await CustomProviderRepository(session).get_model_by_ids(provider_db_id, model_id)
            if model is None or not model.is_enabled:
                return False
            model.is_enabled = False
            await session.commit()
        logger.warning("Disabled inaccessible custom model after provider 404: %s/%s", provider_id, model_id)
        return True
    except Exception:
        logger.warning("Failed to disable inaccessible custom model: %s/%s", provider_id, model_id, exc_info=True)
        return False
