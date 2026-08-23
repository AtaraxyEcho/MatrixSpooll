"""Fixtures for agent_session_store tests."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import event, pool, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from lib.db.base import Base
from lib.db.repositories.session_repo import SessionRepository


def _pg_url_from_env() -> str | None:
    """Return DATABASE_URL iff it's a PostgreSQL+asyncpg URL, else None."""
    url = os.environ.get("DATABASE_URL")
    if url and url.startswith("postgresql+asyncpg://"):
        return url
    return None


# Test fixtures attribute writes to a small set of fixed user_ids; seed them
# on PG so FK constraints (which SQLite tests bypass via PRAGMA foreign_keys=OFF)
# don't reject inserts.
_PG_TEST_USER_IDS = ("default", "u1", "conformance", "e2e", "crash-recover", "long-turn")
_PG_TEST_SCHEMA = "matrixspooll_test"
_TEST_SESSIONS = (
    ("proj", "sess"),
    ("p", "s1"),
    ("p", "s2"),
    ("other", "s3"),
    ("proj-A", "sess-1"),
)


async def _reset_pg_schema(engine) -> None:
    """Reset the single PostgreSQL test schema before a test starts."""

    async with engine.begin() as conn:
        await conn.execute(text(f'DROP SCHEMA IF EXISTS "{_PG_TEST_SCHEMA}" CASCADE'))
        await conn.execute(text(f'CREATE SCHEMA "{_PG_TEST_SCHEMA}"'))


async def _seed_pg_users(engine) -> None:
    async with engine.begin() as conn:
        for uid in _PG_TEST_USER_IDS:
            await conn.execute(
                text(
                    "INSERT INTO users (id, username, role, is_active, created_at, updated_at) "
                    "VALUES (:id, :username, 'member', true, NOW(), NOW()) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                {"id": uid, "username": uid},
            )


async def _seed_test_sessions(
    factory: async_sessionmaker[AsyncSession],
    *,
    user_id: str = "u1",
) -> None:
    """Register the fixed sessions used by store unit tests."""

    async with factory() as session:
        repo = SessionRepository(session)
        for project_name, sdk_session_id in _TEST_SESSIONS:
            if await repo.get(sdk_session_id) is None:
                await repo.create(project_name, sdk_session_id, user_id=user_id)


@pytest.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """Session factory with all tables created.

    By default uses in-memory SQLite. When ``DATABASE_URL`` points at PG
    (postgresql+asyncpg://...), uses one reset PG schema so
    dialect-specific code paths (partial unique indexes + ON CONFLICT,
    SELECT ... FOR UPDATE) are actually exercised.
    """
    pg_url = _pg_url_from_env()
    if pg_url:
        engine = create_async_engine(
            pg_url,
            connect_args={"server_settings": {"search_path": _PG_TEST_SCHEMA}},
        )
        await _reset_pg_schema(engine)
        async with engine.begin() as conn:
            import lib.agent_session_store.models  # noqa: F401
            import lib.db.models  # noqa: F401

            await conn.run_sync(Base.metadata.create_all)
        # PG enforces FK constraints (SQLite tests run with PRAGMA foreign_keys=OFF).
        # Seed the user rows that test cases attribute writes to so FK checks pass.
        await _seed_pg_users(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        await _seed_test_sessions(factory)
        try:
            yield factory
        finally:
            async with engine.begin() as conn:
                await conn.execute(text(f'DROP SCHEMA IF EXISTS "{_PG_TEST_SCHEMA}" CASCADE'))
            await engine.dispose()
        return

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        # Import model modules to register tables on Base.metadata.
        import lib.agent_session_store.models  # noqa: F401
        import lib.db.models  # noqa: F401  (users / agent_sessions / config etc.)

        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await _seed_test_sessions(factory)
    yield factory
    await engine.dispose()


@pytest.fixture
async def file_session_factory(tmp_path) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """File-backed SQLite with NullPool — each connection is independent.

    Required for concurrency tests that must NOT serialize via StaticPool
    (which is the default for ``sqlite+aiosqlite:///:memory:``).

    Always SQLite regardless of ``DATABASE_URL`` — tests that depend on this
    fixture are SQLite-specific edge cases marked ``@pytest.mark.sqlite_only``.
    """
    db_path = tmp_path / "concurrency.db"
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{db_path}",
        poolclass=pool.NullPool,
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA foreign_keys=OFF")
        cursor.close()

    async with engine.begin() as conn:
        import lib.agent_session_store.models  # noqa: F401
        import lib.db.models  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await _seed_test_sessions(factory)
    yield factory
    await engine.dispose()
