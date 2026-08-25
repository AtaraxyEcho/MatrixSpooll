"""Identity and project access migration coverage."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config

from alembic import command

pytestmark = pytest.mark.integration

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PARENT_REVISION = "f8a0b2c4d6e8"
REVISION = "a4d6e8f0b2c4"


@pytest.fixture
def alembic_cfg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Config, Path]:
    db_path = tmp_path / "identity.db"
    monkeypatch.setenv("MATRIXSPOOLL_TEST_DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    cfg = Config()
    cfg.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))
    return cfg, db_path


def test_migration_normalizes_ownership_and_preserves_history(alembic_cfg: tuple[Config, Path]) -> None:
    cfg, db_path = alembic_cfg
    command.upgrade(cfg, PARENT_REVISION)

    engine = sa.create_engine(f"sqlite:///{db_path}")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "INSERT INTO users (id, username, role, is_active, created_at, updated_at) "
                "VALUES ('worker', 'worker-name', 'user', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            sa.text(
                "INSERT INTO project_registry (id, name, owner_id, created_at, updated_at) "
                "VALUES ('project-1', 'demo', 'default', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            sa.text(
                "INSERT INTO project_members (project_id, user_id, role, created_at, updated_at) "
                "VALUES ('project-1', 'default', 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            sa.text(
                "INSERT INTO tasks (task_id, project_id, project_name, task_type, media_type, resource_id, "
                "status, source, queued_at, updated_at, user_id) VALUES "
                "('task-1', 'project-1', 'demo', 'video', 'video', 'resource-1', "
                "'succeeded', 'webui', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'worker')"
            )
        )
        connection.execute(
            sa.text(
                "INSERT INTO api_keys (name, key_hash, key_prefix, created_at, updated_at, user_id) "
                "VALUES ('retired-key', 'retired-key-hash', 'retired', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'default')"
            )
        )

    command.upgrade(cfg, REVISION)

    inspector = sa.inspect(engine)
    task_columns = {column["name"]: column for column in inspector.get_columns("tasks")}
    assert task_columns["user_id"]["nullable"] is True
    assert "actor_username" in task_columns
    assert "revoked_at" in {column["name"] for column in inspector.get_columns("api_keys")}
    assert "audit_events" in inspector.get_table_names()
    assert "uq_agent_credential_one_active_per_user" in {
        index["name"] for index in inspector.get_indexes("agent_anthropic_credentials")
    }

    user_fk = next(
        foreign_key
        for foreign_key in inspector.get_foreign_keys("tasks")
        if foreign_key["constrained_columns"] == ["user_id"]
    )
    assert (user_fk.get("options") or {}).get("ondelete") == "SET NULL"

    with engine.begin() as connection:
        connection.execute(sa.text("PRAGMA foreign_keys = ON"))
        # Adding revocation metadata must not silently invalidate existing keys.
        assert connection.execute(sa.text("SELECT revoked_at FROM api_keys")).scalar_one() is None
        assert connection.execute(sa.text("SELECT role FROM users WHERE id = 'worker'")).scalar_one() == "member"
        assert (
            connection.execute(sa.text("SELECT COUNT(*) FROM project_members WHERE role = 'owner'")).scalar_one() == 0
        )
        connection.execute(sa.text("DELETE FROM users WHERE id = 'worker'"))
        row = connection.execute(sa.text("SELECT user_id, actor_username FROM tasks WHERE task_id = 'task-1'")).one()
        assert row == (None, "worker-name")

    engine.dispose()


def test_downgrade_preserves_existing_keys(alembic_cfg: tuple[Config, Path]) -> None:
    cfg, db_path = alembic_cfg
    command.upgrade(cfg, PARENT_REVISION)

    engine = sa.create_engine(f"sqlite:///{db_path}")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "INSERT INTO api_keys (name, key_hash, key_prefix, created_at, updated_at, user_id) "
                "VALUES ('legacy-key', 'legacy-key-hash', 'arc-dead', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'default')"
            )
        )

    command.upgrade(cfg, REVISION)
    command.downgrade(cfg, PARENT_REVISION)

    with engine.connect() as connection:
        remaining = connection.execute(
            sa.text("SELECT COUNT(*) FROM api_keys WHERE key_hash = 'legacy-key-hash'")
        ).scalar_one()
    assert remaining == 1
    engine.dispose()
