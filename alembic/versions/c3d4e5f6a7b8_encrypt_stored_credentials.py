"""Encrypt stored provider credentials.

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
"""

from collections.abc import Callable, Sequence

import sqlalchemy as sa

from alembic import op
from lib.db.encrypted_type import decrypt_secret, encrypt_secret

revision: str = "c3d4e5f6a7b8"
down_revision: str | Sequence[str] | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rewrite_column(
    table: str,
    column: str,
    transform: Callable[[str | None], str | None],
    *,
    where: str | None = None,
) -> None:
    connection = op.get_bind()
    condition = f" WHERE {where}" if where else ""
    rows = connection.execute(sa.text(f'SELECT id, "{column}" FROM "{table}"{condition}')).all()
    statement = sa.text(f'UPDATE "{table}" SET "{column}" = :value WHERE id = :id')
    for row_id, value in rows:
        if value is None or value == "":
            continue
        rewritten = transform(value)
        if rewritten != value:
            connection.execute(statement, {"id": row_id, "value": rewritten})


def upgrade() -> None:
    _rewrite_column("custom_provider", "api_key", encrypt_secret)
    for column in ("api_key", "access_key", "secret_key"):
        _rewrite_column("provider_credential", column, encrypt_secret)
    _rewrite_column("agent_anthropic_credentials", "api_key", encrypt_secret)
    _rewrite_column("provider_config", "value", encrypt_secret, where="is_secret")


def downgrade() -> None:
    _rewrite_column("custom_provider", "api_key", decrypt_secret)
    for column in ("api_key", "access_key", "secret_key"):
        _rewrite_column("provider_credential", column, decrypt_secret)
    _rewrite_column("agent_anthropic_credentials", "api_key", decrypt_secret)
    _rewrite_column("provider_config", "value", decrypt_secret, where="is_secret")
