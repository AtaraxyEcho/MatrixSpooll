"""Schema comment migration invariants."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from lib.db.schema_comments import SCHEMA_COMMENTS as APPLICATION_SCHEMA_COMMENTS

pytestmark = pytest.mark.integration

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_PATH = PROJECT_ROOT / "alembic" / "versions" / "b5e7f9a1c3d5_add_schema_comments.py"


def _load_migration() -> ModuleType:
    spec = spec_from_file_location("schema_comment_migration", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_schema_comment_migration_uses_an_immutable_snapshot() -> None:
    migration = _load_migration()
    assert migration.SCHEMA_COMMENTS is not APPLICATION_SCHEMA_COMMENTS


def test_schema_comment_migration_fails_on_schema_drift(monkeypatch) -> None:
    migration = _load_migration()
    bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
    inspector = SimpleNamespace(get_table_names=lambda: [])
    monkeypatch.setattr(migration.op, "get_bind", lambda: bind)
    monkeypatch.setattr(migration.sa, "inspect", lambda _bind: inspector)

    with pytest.raises(RuntimeError, match="missing tables"):
        migration._apply_comments(clear=False)
