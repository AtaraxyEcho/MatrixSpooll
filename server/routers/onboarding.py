"""Onboarding 引导状态 APIs.

首次使用引导的「已看过」标记。刻意与 `/system/config` 分开：那条路由是配置面板的
读写白名单，引导标记既不是用户可配置项，也不该被配置页的批量读写带上。

作用域：标记按当前用户隔离（``onboarding_seen:{user_id}``）。写单个全局键会让第一个
看完引导的人把后续所有账号一起标记成已看过，新账号再也见不到引导页。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from lib.config.service import ConfigService
from lib.db import get_async_session
from server.auth import CurrentUser
from server.dependencies import get_config_service

router = APIRouter()

ONBOARDING_SEEN_KEY = "onboarding_seen"


class OnboardingStatusResponse(BaseModel):
    seen: bool


def _seen_key(user_id: str) -> str:
    """按用户隔离的设置键。"""
    return f"{ONBOARDING_SEEN_KEY}:{user_id}"


async def _read_seen(svc: ConfigService, user_id: str) -> bool:
    return await svc.get_setting(_seen_key(user_id)) == "true"


@router.get("/onboarding/status", response_model=OnboardingStatusResponse)
async def get_onboarding_status(
    current_user: CurrentUser,
    svc: Annotated[ConfigService, Depends(get_config_service)],
) -> OnboardingStatusResponse:
    """当前用户的引导是否已看过。未设置视为未看过 —— 前端据此决定是否自动弹出。"""
    return OnboardingStatusResponse(seen=await _read_seen(svc, current_user.id))


@router.post("/onboarding/seen", response_model=OnboardingStatusResponse)
async def mark_onboarding_seen(
    current_user: CurrentUser,
    svc: Annotated[ConfigService, Depends(get_config_service)],
    session: AsyncSession = Depends(get_async_session),
) -> OnboardingStatusResponse:
    """标记当前用户的引导已看过。幂等 —— 跳过/看完/关闭三条退出路径都打到这里。"""
    await svc.set_setting(_seen_key(current_user.id), "true")
    await session.commit()
    return OnboardingStatusResponse(seen=True)
