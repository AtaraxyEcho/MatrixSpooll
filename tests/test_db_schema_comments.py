"""Database schema comment coverage."""

import pytest

import lib.agent_session_store.models  # noqa: F401
import lib.db.models  # noqa: F401
from lib.db.base import Base

pytestmark = pytest.mark.unit


def test_all_application_tables_and_columns_have_comments() -> None:
    missing: list[str] = []
    for table in Base.metadata.tables.values():
        if not table.comment:
            missing.append(table.name)
        for column in table.columns:
            if not column.comment:
                missing.append(f"{table.name}.{column.name}")
    assert not missing, f"missing database comments: {', '.join(missing)}"
