"""Tests for lib.db.engine configuration."""

import os
from unittest.mock import patch

import pytest

from lib.db.engine import get_database_url, is_sqlite_backend

pytestmark = pytest.mark.unit


class TestGetDatabaseUrl:
    def test_testing_uses_isolated_sqlite_even_when_runtime_url_exists(self):
        with patch.dict(
            os.environ,
            {"TESTING": "true", "DATABASE_URL": "postgresql+asyncpg://localhost/development"},
            clear=False,
        ):
            os.environ.pop("MATRIXSPOOLL_TEST_DATABASE_URL", None)
            url = get_database_url()
            assert url == "sqlite+aiosqlite:///:memory:"

    def test_explicit_test_database_override(self):
        with patch.dict(
            os.environ,
            {
                "TESTING": "true",
                "DATABASE_URL": "postgresql+asyncpg://localhost/development",
                "MATRIXSPOOLL_TEST_DATABASE_URL": "postgresql+asyncpg://localhost/matrixspooll_test",
            },
        ):
            url = get_database_url()
            assert url == "postgresql+asyncpg://localhost/matrixspooll_test"

    def test_runtime_env_override(self):
        with patch.dict(
            os.environ,
            {"TESTING": "false", "DATABASE_URL": "postgresql+asyncpg://localhost/matrixspooll"},
        ):
            assert get_database_url() == "postgresql+asyncpg://localhost/matrixspooll"

    def test_missing_url_rejected_outside_testing(self):
        with patch.dict(os.environ, {"TESTING": "false"}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            with pytest.raises(RuntimeError, match="DATABASE_URL is required"):
                get_database_url()


class TestIsSqliteBackend:
    def test_sqlite(self):
        with patch.dict(os.environ, {"TESTING": "true"}, clear=False):
            os.environ.pop("MATRIXSPOOLL_TEST_DATABASE_URL", None)
            assert is_sqlite_backend() is True

    def test_postgresql(self):
        with patch.dict(
            os.environ,
            {"TESTING": "true", "MATRIXSPOOLL_TEST_DATABASE_URL": "postgresql+asyncpg://localhost/test"},
        ):
            assert is_sqlite_backend() is False
