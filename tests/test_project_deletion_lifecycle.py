from __future__ import annotations

import pytest

from lib.project_manager import ProjectManager


@pytest.mark.unit
def test_staged_project_deletion_can_be_restored(tmp_path):
    manager = ProjectManager(tmp_path)
    original = manager.create_project("demo")

    original_dir, staged_dir = manager.stage_project_deletion("demo", "project-id")

    assert original_dir == original
    assert not original.exists()
    assert "demo" not in manager.list_projects()
    assert manager.list_staged_project_deletions() == [(staged_dir, "demo", "project-id")]

    manager.restore_staged_project_deletion(original_dir, staged_dir)

    assert original.exists()
    assert not (original / manager.DELETION_MARKER_FILE).exists()
    assert manager.list_staged_project_deletions() == []


@pytest.mark.unit
def test_staged_project_deletion_can_be_finalized(tmp_path):
    manager = ProjectManager(tmp_path)
    manager.create_project("demo")
    _original_dir, staged_dir = manager.stage_project_deletion("demo", "project-id")

    manager.finalize_staged_project_deletion(staged_dir)

    assert not staged_dir.exists()
    assert manager.list_staged_project_deletions() == []
