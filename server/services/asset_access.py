"""全局资产库的可见性判定（唯一真相源）。

判定语义：

- 管理员（``role == "admin"``，含超管）全可见，与其对资产的写权限一致。
- 创建者始终可见。
- ``visibility == "shared"`` 进实例级共享池，所有登录用户可读、可复制。
- ``source_project_id`` 指向的项目里，当前用户是 owner 或成员时可见——私有资产的
  "团队可见"语义，避免同一项目的协作者各自重复上传同一张设定图。
- ``owner_user_id IS NULL`` 的历史/系统资产对所有登录用户可见，保持引入可见性字段
  之前的行为（升级不锁死存量内容）。

谓词直接下推到 SQL：列表分页、按 id 批量取、按文件路径反查都消费同一个表达式，
避免「列表过滤了、详情/直链没过滤」这类半修。
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, or_, select, true

from lib.db.models.asset import ASSET_VISIBILITY_SHARED, Asset
from lib.db.models.project import ProjectMember, ProjectRegistry
from server.auth import CurrentUserInfo


def accessible_project_ids(user: CurrentUserInfo):
    """当前用户可访问（owner 或成员）的项目注册表 id 子查询。"""

    return (
        select(ProjectRegistry.id)
        .outerjoin(ProjectMember, ProjectMember.project_id == ProjectRegistry.id)
        .where(
            or_(
                ProjectRegistry.owner_id == user.id,
                ProjectMember.user_id == user.id,
            )
        )
    )


def visible_asset_clause(user: CurrentUserInfo) -> ColumnElement[bool]:
    """返回 ``Asset`` 上的可见性过滤条件，供 select/where 组合。"""

    if user.role == "admin":
        return true()
    return or_(
        Asset.owner_user_id == user.id,
        Asset.owner_user_id.is_(None),
        Asset.visibility == ASSET_VISIBILITY_SHARED,
        Asset.source_project_id.in_(accessible_project_ids(user)),
    )
