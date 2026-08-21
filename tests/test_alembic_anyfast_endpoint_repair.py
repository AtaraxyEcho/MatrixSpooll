"""Regression tests for the legacy AnyFast endpoint repair migration."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config

from alembic import command

pytestmark = pytest.mark.unit

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def alembic_cfg(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    cfg = Config(str(PROJECT_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))
    return cfg, db_path


def _sync_engine(db_path: Path) -> sa.Engine:
    return sa.create_engine(f"sqlite:///{db_path}")


def test_upgrade_repairs_only_anyfast_domain_models(alembic_cfg) -> None:
    cfg, db_path = alembic_cfg
    command.upgrade(cfg, "b3f9c07ae214")
    engine = _sync_engine(db_path)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO custom_provider "
                "(id, display_name, discovery_format, base_url, api_key, created_at, updated_at) "
                "VALUES (1, 'AnyFast', 'openai', 'https://www.anyfast.ai/v1', 'key', "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), "
                "(2, 'Ark', 'openai', 'https://ark.example/v1', 'key', "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), "
                "(3, 'Unrelated', 'openai', 'https://anyfast.ai.example/v1', 'key', "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO custom_provider_model "
                "(provider_id, model_id, display_name, endpoint, is_default, is_enabled, created_at, updated_at) "
                "VALUES (1, 'seedance-2.0-ultra', 'Ultra', 'ark-seedance', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), "
                "(2, 'seedance-2.0-ultra', 'Ultra', 'ark-seedance', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP), "
                "(3, 'seedance-2.0-ultra', 'Ultra', 'ark-seedance', 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )

    command.upgrade(cfg, "c2f9b0a7e1d4")
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT provider_id, endpoint FROM custom_provider_model ORDER BY provider_id")
        ).fetchall()
    assert rows == [(1, "anyfast-seedance"), (2, "ark-seedance"), (3, "ark-seedance")]


def test_downgrade_restores_repaired_rows(alembic_cfg) -> None:
    cfg, db_path = alembic_cfg
    command.upgrade(cfg, "c2f9b0a7e1d4")
    engine = _sync_engine(db_path)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO custom_provider "
                "(id, display_name, discovery_format, base_url, api_key, created_at, updated_at) "
                "VALUES (1, 'AnyFast', 'openai', 'https://anyfast.ai', 'key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO custom_provider_model "
                "(provider_id, model_id, display_name, endpoint, is_default, is_enabled, created_at, updated_at) "
                "VALUES (1, 'seedance-2.0', 'Seedance', 'anyfast-seedance', 0, 1, "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )

    command.downgrade(cfg, "b3f9c07ae214")
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT endpoint FROM custom_provider_model")).scalar_one() == "ark-seedance"


def test_followup_upgrade_repairs_rows_created_after_initial_repair(alembic_cfg) -> None:
    cfg, db_path = alembic_cfg
    command.upgrade(cfg, "c2f9b0a7e1d4")
    engine = _sync_engine(db_path)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO custom_provider "
                "(id, display_name, discovery_format, base_url, api_key, created_at, updated_at) "
                "VALUES (1, 'AnyFast', 'openai', 'https://www.anyfast.ai/v1', 'key', "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO custom_provider_model "
                "(provider_id, model_id, display_name, endpoint, is_default, is_enabled, created_at, updated_at) "
                "VALUES (1, 'seedance-2.0', 'Seedance', 'ark-seedance', 0, 1, "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )

    command.upgrade(cfg, "d4e6b8a1c305")
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT endpoint FROM custom_provider_model")).scalar_one() == "anyfast-seedance"
