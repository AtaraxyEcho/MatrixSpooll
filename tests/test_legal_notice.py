from pathlib import Path

import pytest

from lib.legal_notice import read_legal_attribution

pytestmark = pytest.mark.unit


def test_reads_quoted_attribution_and_repository(tmp_path: Path) -> None:
    notice = tmp_path / "NOTICE"
    notice.write_text(
        'Project Notices\n\n"Powered by Upstream — https://github.com/upstream/project"\n',
        encoding="utf-8",
    )

    result = read_legal_attribution(notice)

    assert result.attribution == "Powered by Upstream — https://github.com/upstream/project"
    assert result.repository_url == "https://github.com/upstream/project"


def test_rejects_notice_without_attribution(tmp_path: Path) -> None:
    notice = tmp_path / "NOTICE"
    notice.write_text("Project Notices\n", encoding="utf-8")

    with pytest.raises(ValueError, match="valid UI attribution"):
        read_legal_attribution(notice)
