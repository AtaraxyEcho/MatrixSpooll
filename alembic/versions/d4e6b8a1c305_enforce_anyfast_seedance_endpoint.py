"""Enforce the AnyFast transport for AnyFast-hosted Seedance models."""

from collections.abc import Sequence
from urllib.parse import urlsplit

import sqlalchemy as sa

from alembic import op

revision: str = "d4e6b8a1c305"
down_revision: str | Sequence[str] | None = "c2f9b0a7e1d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, base_url FROM custom_provider")).fetchall()
    for provider_id, base_url in rows:
        raw = str(base_url or "").strip()
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
        hostname = (parsed.hostname or "").lower().rstrip(".")
        if hostname != "anyfast.ai" and not hostname.endswith(".anyfast.ai"):
            continue
        bind.execute(
            sa.text(
                "UPDATE custom_provider_model SET endpoint = 'anyfast-seedance' "
                "WHERE endpoint = 'ark-seedance' AND provider_id = :provider_id"
            ),
            {"provider_id": int(provider_id)},
        )


def downgrade() -> None:
    # The previous endpoint value cannot be distinguished from an intentional Ark selection.
    pass
