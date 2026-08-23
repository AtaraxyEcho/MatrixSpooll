"""Opt-in PostgreSQL coverage for identity and schema-comment migrations."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import command

pytestmark = pytest.mark.integration

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PARENT_REVISION = "f8a0b2c4d6e8"
HARDENING_REVISION = "a4d6e8f0b2c4"


async def _execute(database_url: str, statement: str):
    engine = create_async_engine(database_url)
    try:
        async with engine.begin() as connection:
            result = await connection.execute(sa.text(statement))
            return result.scalar_one_or_none() if result.returns_rows else None
    finally:
        await engine.dispose()


def test_postgres_upgrade_downgrade_and_comments(monkeypatch) -> None:
    database_url = os.environ.get("MATRIXSPOOLL_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("MATRIXSPOOLL_TEST_POSTGRES_URL is not configured")
    database_name = make_url(database_url).database or ""
    if not database_name.startswith("matrixspooll_test_"):
        pytest.fail("MATRIXSPOOLL_TEST_POSTGRES_URL must target a matrixspooll_test_* database")

    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.delenv("TESTING", raising=False)
    cfg = Config()
    cfg.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))

    try:
        command.upgrade(cfg, PARENT_REVISION)
        asyncio.run(
            _execute(
                database_url,
                "INSERT INTO api_keys (name, key_hash, key_prefix, created_at, updated_at, user_id) "
                "VALUES ('legacy-key', 'postgres-legacy-key', 'arc-dead', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'default')",
            )
        )
        command.upgrade(cfg, HARDENING_REVISION)
        command.downgrade(cfg, PARENT_REVISION)
        remaining = asyncio.run(
            _execute(database_url, "SELECT COUNT(*) FROM api_keys WHERE key_hash = 'postgres-legacy-key'")
        )
        # Revocation metadata is additive; upgrades and downgrades must not
        # invalidate or delete keys that were already issued.
        assert remaining == 1

        command.upgrade(cfg, "head")
        table_comment = asyncio.run(_execute(database_url, "SELECT obj_description('users'::regclass, 'pg_class')"))
        column_comment = asyncio.run(_execute(database_url, "SELECT col_description('users'::regclass, 1)"))
        assert table_comment == "系统用户账户。"
        assert column_comment == "用户ID。"
    finally:
        # Later identity migrations are intentionally irreversible. This test
        # accepts only a dedicated matrixspooll_test_* database, so reset its
        # schema directly instead of pretending a production rollback exists.
        asyncio.run(_execute(database_url, "DROP SCHEMA public CASCADE"))
        asyncio.run(_execute(database_url, "CREATE SCHEMA public"))
