"""Repair legacy AnyFast Seedance models that point at the Ark adapter.

Older setup data could create a provider with an AnyFast base URL while using
the historical ``ark-seedance`` endpoint key.  That combination exposes Ark's
generic capability table and sends requests through the wrong transport.  The
endpoint key is part of the execution contract, so repair only the unambiguous
AnyFast-domain rows and leave all other custom providers untouched.
"""

from collections.abc import Sequence
from urllib.parse import urlsplit

import sqlalchemy as sa

from alembic import op

revision: str = "c2f9b0a7e1d4"
down_revision: str | Sequence[str] | None = "b3f9c07ae214"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _anyfast_provider_ids(bind) -> list[int]:
    rows = bind.execute(sa.text("SELECT id, base_url FROM custom_provider")).fetchall()
    provider_ids: list[int] = []
    for provider_id, base_url in rows:
        raw = str(base_url or "").strip()
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
        hostname = (parsed.hostname or "").lower().rstrip(".")
        if hostname == "anyfast.ai" or hostname.endswith(".anyfast.ai"):
            provider_ids.append(int(provider_id))
    return provider_ids


def _replace_endpoint(bind, *, source: str, target: str) -> None:
    for provider_id in _anyfast_provider_ids(bind):
        bind.execute(
            sa.text(
                "UPDATE custom_provider_model SET endpoint = :target "
                "WHERE endpoint = :source AND provider_id = :provider_id"
            ),
            {"source": source, "target": target, "provider_id": provider_id},
        )


def upgrade() -> None:
    bind = op.get_bind()
    _replace_endpoint(bind, source="ark-seedance", target="anyfast-seedance")


def downgrade() -> None:
    bind = op.get_bind()
    _replace_endpoint(bind, source="anyfast-seedance", target="ark-seedance")
