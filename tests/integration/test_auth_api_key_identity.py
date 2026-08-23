"""Database-backed API key identity coverage."""

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import server.auth as auth_module
from lib.db.base import Base
from lib.db.models.user import User

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_api_key_identity_uses_its_active_database_user(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            async with session.begin():
                session.add(User(id="api-user", username="operator", role="admin", is_active=True))

        monkeypatch.setattr(auth_module, "async_session_factory", factory)
        current = await auth_module._payload_to_user({"sub": "apikey:automation", "uid": "api-user", "via": "apikey"})
        assert current.id == "api-user"
        assert current.sub == "operator"
        assert current.role == "member"
        assert current.auth_method == "api_key"

        async with factory() as session:
            user = await session.get(User, "api-user")
            assert user is not None
            user.is_active = False
            await session.commit()

        with pytest.raises(HTTPException) as raised:
            await auth_module._payload_to_user({"sub": "apikey:automation", "uid": "api-user", "via": "apikey"})
        assert raised.value.status_code == 401
    finally:
        await engine.dispose()
