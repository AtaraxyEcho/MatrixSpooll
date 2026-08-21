"""
API 调用统计路由

提供调用记录查询和统计摘要接口。
"""

from datetime import datetime

from fastapi import APIRouter, Query
from sqlalchemy.ext.asyncio import AsyncSession

from lib.db import async_session_factory
from lib.db.repositories.usage_repo import UsageRepository
from lib.providers import CallType
from server.auth import CurrentUser, database_auth_initialized, is_auth_enabled
from server.services.project_access import list_accessible_projects, resolve_project_access

router = APIRouter()


async def _visible_project_names(
    project_name: str | None,
    user: CurrentUser,
    session: AsyncSession,
) -> list[str] | None:
    if project_name:
        if not is_auth_enabled() or not database_auth_initialized():
            return [project_name]
        access = await resolve_project_access(project_name, user, session, required_role="viewer")
        return [access.project_name]
    if not is_auth_enabled() or not database_auth_initialized():
        return None
    projects = await list_accessible_projects(user.id, session)
    return [project.name for project in projects]


@router.get("/usage/stats")
async def get_stats(
    user: CurrentUser,
    project_name: str | None = Query(None, description="项目名称（可选）"),
    provider: str | None = Query(None, description="按供应商筛选"),
    start_date: str | None = Query(None, description="开始日期 (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="结束日期 (YYYY-MM-DD)"),
    group_by: str | None = Query(None, description="分组方式: provider"),
):
    start = datetime.fromisoformat(start_date) if start_date else None
    end = datetime.fromisoformat(end_date) if end_date else None

    async with async_session_factory() as session:
        visible_projects = await _visible_project_names(project_name, user, session)
        repo = UsageRepository(session)
        if group_by == "provider":
            stats = await repo.get_stats_grouped_by_provider(
                project_name=project_name,
                project_names=visible_projects,
                provider=provider,
                start_date=start,
                end_date=end,
            )
        else:
            stats = await repo.get_stats(
                project_name=project_name,
                project_names=visible_projects,
                provider=provider,
                start_date=start,
                end_date=end,
            )
    return stats


@router.get("/usage/calls")
async def get_calls(
    user: CurrentUser,
    project_name: str | None = Query(None, description="项目名称"),
    call_type: CallType | None = Query(None, description="调用类型 (image/video/text)"),
    status: str | None = Query(None, description="状态 (success/failed)"),
    start_date: str | None = Query(None, description="开始日期 (YYYY-MM-DD)"),
    end_date: str | None = Query(None, description="结束日期 (YYYY-MM-DD)"),
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=100, description="每页记录数"),
):
    start = datetime.fromisoformat(start_date) if start_date else None
    end = datetime.fromisoformat(end_date) if end_date else None

    async with async_session_factory() as session:
        visible_projects = await _visible_project_names(project_name, user, session)
        result = await UsageRepository(session).get_calls(
            project_name=project_name,
            project_names=visible_projects,
            call_type=call_type,
            status=status,
            start_date=start,
            end_date=end,
            page=page,
            page_size=page_size,
        )
    return result


@router.get("/usage/projects")
async def get_projects_list(
    user: CurrentUser,
):
    async with async_session_factory() as session:
        visible_projects = await _visible_project_names(None, user, session)
        projects = await UsageRepository(session).get_projects_list(project_names=visible_projects)
    return {"projects": projects}
