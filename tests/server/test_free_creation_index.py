from pathlib import Path

import pytest

from server.services.free_creation_index import invalidate_free_creation_index, load_free_creation_index
from server.services.free_creation_tasks import write_creation_metadata
from server.services.free_creation_workspace import save_reference_upload

pytestmark = pytest.mark.unit


def test_free_creation_index_rebuilds_from_project_records(tmp_path: Path) -> None:
    creation_id = "c_11111111111111111111"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "request_id": "q_11111111111111111111",
            "status": "succeeded",
            "output_type": "video",
            "media_type": "video",
            "prompt": "A city at sunrise",
            "effective_mode": "subtitle_burn",
            "subtitle_id": "sub_11111111111111111111",
            "subtitle_revision": 3,
            "media_path": f"creations/{creation_id}.mp4",
            "updated_at": "2026-08-23T00:00:00+00:00",
        },
    )
    upload = save_reference_upload(tmp_path, original_filename="reference.png", content=b"image")

    index = load_free_creation_index(tmp_path)

    assert index["total"] == 2
    assert index["creation_total"] == 1
    assert index["reference_total"] == 1
    assert index["creations"][0]["creation_id"] == creation_id
    assert index["creations"][0]["effective_mode"] == "subtitle_burn"
    assert index["creations"][0]["subtitle_id"] == "sub_11111111111111111111"
    assert index["creations"][0]["subtitle_revision"] == 3
    assert "references" not in index["creations"][0]
    assert index["references"][0]["reference_id"] == upload["reference_id"]


def test_free_creation_index_is_invalidated_after_a_record_changes(tmp_path: Path) -> None:
    creation_id = "c_11111111111111111111"
    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "status": "queued",
            "output_type": "video",
            "prompt": "first",
        },
    )
    assert load_free_creation_index(tmp_path)["creations"][0]["status"] == "queued"

    write_creation_metadata(
        tmp_path,
        creation_id,
        {
            "creation_id": creation_id,
            "status": "succeeded",
            "output_type": "video",
            "prompt": "first",
        },
    )

    assert load_free_creation_index(tmp_path)["creations"][0]["status"] == "succeeded"


def test_free_creation_index_can_be_explicitly_rebuilt(tmp_path: Path) -> None:
    first = load_free_creation_index(tmp_path)
    invalidate_free_creation_index(tmp_path)
    second = load_free_creation_index(tmp_path)

    assert first["version"] == second["version"] == 2
    assert first["total"] == second["total"] == 0
