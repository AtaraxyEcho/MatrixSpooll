from pathlib import Path

import pytest

from server.services.free_creation_deletion import delete_free_creation_items
from server.services.free_creation_tasks import list_creation_metadata, load_creation_metadata, write_creation_metadata
from server.services.free_creation_workspace import list_reference_uploads, save_reference_upload

pytestmark = pytest.mark.unit


def test_delete_free_creation_items_commits_the_whole_selection(tmp_path: Path) -> None:
    creation_ids = ["c_0123456789abcdef0123", "c_0123456789abcdef0124"]
    for creation_id in creation_ids:
        write_creation_metadata(tmp_path, creation_id, {"creation_id": creation_id, "status": "succeeded"})
    reference = save_reference_upload(tmp_path, original_filename="opening.png", content=b"png")

    result = delete_free_creation_items(
        tmp_path,
        creation_ids=creation_ids,
        reference_ids=[reference["reference_id"]],
    )

    assert result == {
        "creation_ids": creation_ids,
        "reference_ids": [reference["reference_id"]],
    }
    assert list_creation_metadata(tmp_path) == []
    assert list_reference_uploads(tmp_path) == []


def test_delete_free_creation_items_rejects_the_whole_selection_before_writing(tmp_path: Path) -> None:
    terminal_id = "c_0123456789abcdef0123"
    active_id = "c_0123456789abcdef0124"
    write_creation_metadata(tmp_path, terminal_id, {"creation_id": terminal_id, "status": "succeeded"})
    write_creation_metadata(tmp_path, active_id, {"creation_id": active_id, "status": "running"})
    reference = save_reference_upload(tmp_path, original_filename="opening.png", content=b"png")

    with pytest.raises(RuntimeError, match="active free creation"):
        delete_free_creation_items(
            tmp_path,
            creation_ids=[terminal_id, active_id],
            reference_ids=[reference["reference_id"]],
        )

    terminal = load_creation_metadata(tmp_path, terminal_id)
    active = load_creation_metadata(tmp_path, active_id)
    assert terminal is not None and terminal.get("deleted_at") is None
    assert active is not None and active.get("deleted_at") is None
    assert [item["reference_id"] for item in list_reference_uploads(tmp_path)] == [reference["reference_id"]]
