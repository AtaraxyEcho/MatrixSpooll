import pytest

from lib.db.base import utc_now
from lib.db.models.project import ProjectRegistry
from lib.db.models.user import User
from lib.db.repositories.session_repo import SessionRepository
from lib.db.repositories.task_repo import TaskRepository
from lib.db.repositories.usage_repo import UsageRepository

pytestmark = pytest.mark.unit


@pytest.mark.asyncio
async def test_empty_visible_project_set_returns_no_tasks_or_usage(db_factory) -> None:
    async with db_factory() as session:
        session.add(User(id="default", username="admin", role="admin", is_active=True))
        await session.commit()

        await TaskRepository(session).enqueue(
            project_name="private-project",
            task_type="storyboard",
            media_type="image",
            resource_id="scene-1",
        )
        usage = UsageRepository(session)
        await usage.start_call(
            project_name="private-project",
            call_type="image",
            model="provider/model",
        )

        tasks = await TaskRepository(session).list_tasks(project_names=[])
        calls = await usage.get_calls(project_names=[])
        projects = await usage.get_projects_list(project_names=[])

        assert tasks["total"] == 0
        assert calls["total"] == 0
        assert projects == []


@pytest.mark.asyncio
async def test_project_scoped_records_capture_stable_identity_and_actor(db_factory) -> None:
    async with db_factory() as session:
        now = utc_now()
        session.add(User(id="default", username="admin", role="admin", is_active=True))
        session.add(User(id="editor-1", username="editor", role="user", is_active=True))
        session.add(
            ProjectRegistry(
                id="project-stable-id",
                name="shared-project",
                owner_id="default",
                created_at=now,
                updated_at=now,
            )
        )
        await session.commit()

        await TaskRepository(session).enqueue(
            project_name="shared-project",
            task_type="storyboard",
            media_type="image",
            resource_id="scene-1",
        )
        created_session = await SessionRepository(session).create(
            "shared-project",
            "session-1",
            user_id="editor-1",
        )
        usage = UsageRepository(session)
        await usage.start_call(project_name="shared-project", call_type="image", model="provider/model")

        tasks = await TaskRepository(session).list_tasks(project_names=["shared-project"])
        calls = await usage.get_calls(project_names=["shared-project"])

        assert tasks["items"][0]["project_id"] == "project-stable-id"
        assert tasks["items"][0]["actor_user_id"] == "default"
        assert created_session["project_id"] == "project-stable-id"
        assert created_session["actor_user_id"] == "editor-1"
        assert calls["items"][0]["project_id"] == "project-stable-id"
        assert calls["items"][0]["actor_user_id"] == "default"
