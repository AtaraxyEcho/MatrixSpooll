"""Credential encryption boundary tests."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from lib.config.repository import ProviderConfigRepository
from lib.db.encrypted_type import ENCRYPTED_PREFIX
from lib.db.repositories.agent_credential_repo import AgentCredentialRepository
from lib.db.repositories.credential_repository import CredentialRepository
from lib.db.repositories.custom_provider_repo import CustomProviderRepository

pytestmark = [pytest.mark.unit, pytest.mark.uses_db]


@pytest.mark.asyncio
async def test_credential_models_encrypt_raw_database_values(async_session: AsyncSession) -> None:
    custom = await CustomProviderRepository(async_session).create_provider(
        "Custom",
        "openai",
        "https://example.com",
        "custom-secret",
    )
    provider = await CredentialRepository(async_session).create(
        "ark",
        "Primary",
        api_key="provider-secret",
        access_key="access-secret",
        secret_key="signing-secret",
    )
    agent = await AgentCredentialRepository(async_session).create(
        preset_id="deepseek",
        display_name="DeepSeek",
        base_url="https://api.deepseek.com/anthropic",
        api_key="agent-secret",
    )
    await async_session.flush()

    raw_custom = await async_session.scalar(
        text("SELECT api_key FROM custom_provider WHERE id = :id"), {"id": custom.id}
    )
    raw_provider = (
        await async_session.execute(
            text("SELECT api_key, access_key, secret_key FROM provider_credential WHERE id = :id"),
            {"id": provider.id},
        )
    ).one()
    raw_agent = await async_session.scalar(
        text("SELECT api_key FROM agent_anthropic_credentials WHERE id = :id"), {"id": agent.id}
    )

    assert str(raw_custom).startswith(ENCRYPTED_PREFIX)
    assert all(str(value).startswith(ENCRYPTED_PREFIX) for value in raw_provider)
    assert str(raw_agent).startswith(ENCRYPTED_PREFIX)
    assert custom.api_key == "custom-secret"
    assert provider.api_key == "provider-secret"
    assert agent.api_key == "agent-secret"


@pytest.mark.asyncio
async def test_secret_provider_config_is_encrypted_and_transparently_read(async_session: AsyncSession) -> None:
    repository = ProviderConfigRepository(async_session)
    await repository.set("ark", "api_key", "config-secret", is_secret=True)

    raw = await async_session.scalar(
        text("SELECT value FROM provider_config WHERE provider = 'ark' AND key = 'api_key'")
    )
    assert str(raw).startswith(ENCRYPTED_PREFIX)
    assert await repository.get_all("ark") == {"api_key": "config-secret"}
    assert "config-secret" not in str((await repository.get_all_masked("ark"))["api_key"])
