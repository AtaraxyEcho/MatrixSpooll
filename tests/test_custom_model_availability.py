"""Tests for quarantining custom models rejected as unavailable by a provider."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from lib.db.base import Base
from lib.db.repositories.custom_provider_repo import CustomProviderRepository
from server.services.custom_model_availability import (
    is_model_access_error,
    model_id_from_task,
    quarantine_custom_model,
)

pytestmark = pytest.mark.unit


class TestModelNotFound:
    def test_recognizes_provider_model_not_found(self):
        exc = SimpleNamespace(
            status_code=404,
            body={"error": {"code": "InvalidEndpointOrModel.NotFound"}},
        )

        assert is_model_access_error(exc)

    def test_does_not_recognize_unrelated_not_found(self):
        exc = SimpleNamespace(status_code=404, body={"error": {"code": "Project.NotFound"}})

        assert not is_model_access_error(exc)

    def test_extracts_model_from_provider_qualified_payload(self):
        task = {"payload": {"model": "custom-7/doubao-seedream-3-0-t2i-250415"}}

        assert model_id_from_task(task, "custom-7") == "doubao-seedream-3-0-t2i-250415"


@pytest.fixture
async def session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory
    await engine.dispose()


async def test_quarantine_disables_only_matching_custom_model(session_factory):
    async with session_factory() as session:
        repo = CustomProviderRepository(session)
        provider = await repo.create_provider(
            display_name="AnyFast",
            discovery_format="openai",
            base_url="https://www.anyfast.ai/v1",
            api_key="sk-test",
            models=[
                {
                    "model_id": "doubao-seedream-3-0-t2i-250415",
                    "display_name": "Seedream",
                    "endpoint": "openai-images",
                    "is_enabled": True,
                },
                {
                    "model_id": "other-model",
                    "display_name": "Other",
                    "endpoint": "openai-images",
                    "is_enabled": True,
                },
            ],
        )
        await session.commit()
        provider_id = provider.id

    task = {"payload": {"model": f"custom-{provider_id}/doubao-seedream-3-0-t2i-250415"}}
    exc = SimpleNamespace(
        status_code=404,
        body={"error": {"message": "model does not exist", "code": "InvalidEndpointOrModel.NotFound"}},
    )

    assert await quarantine_custom_model(task, f"custom-{provider_id}", exc, session_factory=session_factory)

    async with session_factory() as session:
        repo = CustomProviderRepository(session)
        rejected = await repo.get_model_by_ids(provider_id, "doubao-seedream-3-0-t2i-250415")
        other = await repo.get_model_by_ids(provider_id, "other-model")
        assert rejected is not None and not rejected.is_enabled
        assert other is not None and other.is_enabled
