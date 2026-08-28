from pathlib import Path

import pytest

from lib.legal_notice import read_legal_attribution, read_modified_version_notice, read_source_release

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


def test_reads_modified_version_notice(tmp_path: Path) -> None:
    notice = tmp_path / "NOTICE"
    notice.write_text(
        "Modified product: MatrixSpooll\nModified by: Example distributor\nRelevant modification date: 2026-08-28\n",
        encoding="utf-8",
    )

    result = read_modified_version_notice(notice)

    assert result.product == "MatrixSpooll"
    assert result.modified_by == "Example distributor"
    assert result.modification_date == "2026-08-28"


def test_reads_safe_source_release(tmp_path: Path) -> None:
    archive = tmp_path / "matrixspooll-source-1.2.0.zip"
    archive.write_bytes(b"zip")
    (tmp_path / "source-manifest.json").write_text(
        '{"schema_version":1,"version":"1.2.0",'
        '"archive":"matrixspooll-source-1.2.0.zip",'
        '"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
        '"created_at":"2026-08-28T00:00:00Z"}',
        encoding="utf-8",
    )

    result = read_source_release(tmp_path)

    assert result is not None
    assert result.archive_path == archive


def test_rejects_source_archive_path_traversal(tmp_path: Path) -> None:
    (tmp_path / "source-manifest.json").write_text(
        '{"schema_version":1,"version":"1.2.0","archive":"../secret.zip",'
        '"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
        '"created_at":"2026-08-28T00:00:00Z"}',
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="invalid archive name"):
        read_source_release(tmp_path)
