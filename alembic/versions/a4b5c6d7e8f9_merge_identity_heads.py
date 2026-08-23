"""Merge the identity-hardening and API/session compatibility branches."""

from collections.abc import Sequence

revision: str = "a4b5c6d7e8f9"
down_revision: tuple[str, str] = ("a3b4c5d6e7f8", "f9a0b1c2d3e4")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
