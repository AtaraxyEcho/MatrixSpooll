"""
认证 API 路由

提供 OAuth2 登录和 token 验证接口。
"""

import asyncio
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy import select

from lib.db import async_session_factory
from lib.db.models.user import User
from lib.i18n import Translator
from lib.project_manager import get_project_manager
from server.auth import (
    CurrentUser,
    authenticate_database_user,
    check_credentials,
    create_token,
    create_user_session,
    database_auth_initialized,
    database_user_exists,
    is_auth_enabled,
    revoke_all_user_sessions,
    revoke_user_session,
    update_user_password,
)
from server.security.login_throttle import ACCOUNT_LOGIN_THROTTLE, IP_LOGIN_THROTTLE
from server.services.user_validation import NICKNAME_MAX_LENGTH, validate_nickname

logger = logging.getLogger(__name__)

router = APIRouter()

ALLOWED_AVATAR_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_AVATAR_BYTES = 2 * 1024 * 1024


def _normalize_email(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    return normalized or None


# 公开端点：拿到 token 之前必须可达，注册时不挂 Bearer 依赖。
public_router = APIRouter()


# ==================== 响应模型 ====================


class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    username: str | None = None
    role: str | None = None
    nickname: str | None = None
    avatar_path: str | None = None
    email: str | None = None


class VerifyResponse(BaseModel):
    valid: bool
    username: str
    role: str | None = None


class CurrentUserResponse(BaseModel):
    id: str
    username: str
    role: str
    nickname: str | None = None
    avatar_path: str | None = None
    email: str | None = None
    last_login_at: datetime | None = None
    last_login_ip: str | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class ProfileUpdateRequest(BaseModel):
    nickname: str | None = Field(default=None, max_length=NICKNAME_MAX_LENGTH)
    email: str | None = Field(default=None, max_length=254)


class AuthStatusResponse(BaseModel):
    enabled: bool


class BrowserSessionResponse(BaseModel):
    username: str
    role: str
    nickname: str | None = None
    avatar_path: str | None = None
    email: str | None = None


@dataclass(frozen=True)
class _LoginResult:
    token: str
    username: str
    role: str
    nickname: str | None = None
    avatar_path: str | None = None
    email: str | None = None


async def _authenticate_login(
    form_data: OAuth2PasswordRequestForm,
    request: Request,
    device_id: str | None,
    translate: Callable[..., str],
) -> _LoginResult:
    account_key = form_data.username.strip().casefold()
    ip_key = request.client.host if request.client else "unknown"
    retry_after = max(
        ACCOUNT_LOGIN_THROTTLE.retry_after(account_key),
        IP_LOGIN_THROTTLE.retry_after(ip_key),
    )
    if is_auth_enabled() and retry_after:
        raise HTTPException(
            status_code=429,
            detail=translate("login_rate_limited"),
            headers={"Retry-After": str(retry_after)},
        )

    if is_auth_enabled() and database_auth_initialized():
        user = await authenticate_database_user(form_data.username, form_data.password)
        if user is not None:
            session = await create_user_session(
                user,
                device_id=(device_id or "browser-default").strip()[:200] or "browser-default",
                ip_address=request.client.host if request.client else None,
                user_agent=request.headers.get("user-agent"),
            )
            ACCOUNT_LOGIN_THROTTLE.clear(account_key)
            return _LoginResult(
                token=create_token(user.username, user_id=user.id, session_id=session.id, role=user.role),
                username=user.username,
                role=user.role,
                nickname=user.nickname,
                avatar_path=user.avatar_path,
                email=user.email,
            )

    if is_auth_enabled() and (
        (database_auth_initialized() and await database_user_exists(form_data.username))
        or not check_credentials(form_data.username, form_data.password)
    ):
        logger.warning("Login failed for user %s", form_data.username)
        ACCOUNT_LOGIN_THROTTLE.record_failure(account_key)
        IP_LOGIN_THROTTLE.record_failure(ip_key)
        raise HTTPException(
            status_code=401,
            detail=translate("unauthorized"),
            headers={"WWW-Authenticate": "Bearer"},
        )

    logger.info("User logged in: %s", form_data.username)
    ACCOUNT_LOGIN_THROTTLE.clear(account_key)
    return _LoginResult(
        token=create_token(form_data.username),
        username=form_data.username,
        role="admin",
    )


def _set_browser_session_cookies(response: Response, request: Request, token: str) -> None:
    secure = request.url.scheme == "https"
    response.set_cookie(
        "matrixspooll_auth_token",
        token,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/api/v1",
        max_age=7 * 24 * 3600,
    )
    response.set_cookie(
        "matrixspooll_csrf_token",
        secrets.token_urlsafe(32),
        httponly=False,
        secure=secure,
        samesite="lax",
        path="/",
        max_age=7 * 24 * 3600,
    )


# ==================== 路由 ====================


@public_router.get("/auth/status", response_model=AuthStatusResponse)
async def auth_status():
    """暴露 ``AUTH_ENABLED`` 状态供前端 bootstrap 判断是否需要登录拦截。

    前端 ``auth-store.initialize()`` 在 localStorage 无 token 时调用本接口：
    ``enabled=false`` 时跳过登录页直接进主界面；``enabled=true`` 时保留原
    登录链路。本接口本身**不要求认证**——一个 boolean 比 401 探针更直观，
    且实际"是否需要登录"通过 401/200 也能从外部观察到，因此不增量泄露。
    """
    return AuthStatusResponse(enabled=is_auth_enabled())


@public_router.post("/auth/token", response_model=TokenResponse)
async def login_for_access_token(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    _t: Translator,
    request: Request,
    device_id: Annotated[str | None, Form()] = None,
):
    """用户登录

    使用 OAuth2 标准表单格式验证凭据，成功返回 access_token。
    ``AUTH_ENABLED=false`` 时跳过凭据校验，直接签发 token，让前端
    LoginPage 即便被打开也能正常跳转主界面。
    """
    result = await _authenticate_login(form_data, request, device_id, _t)
    return TokenResponse(
        access_token=result.token,
        token_type="bearer",
        username=result.username,
        role=result.role,
        nickname=result.nickname,
        avatar_path=result.avatar_path,
        email=result.email,
    )


@public_router.post("/auth/session", response_model=BrowserSessionResponse)
async def login_for_browser_session(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    _t: Translator,
    request: Request,
    response: Response,
    device_id: Annotated[str | None, Form()] = None,
) -> BrowserSessionResponse:
    """Create an HttpOnly browser session without exposing its bearer token."""
    result = await _authenticate_login(form_data, request, device_id, _t)
    _set_browser_session_cookies(response, request, result.token)
    return BrowserSessionResponse(
        username=result.username,
        role=result.role,
        nickname=result.nickname,
        avatar_path=result.avatar_path,
        email=result.email,
    )


@router.post("/auth/session/exchange", response_model=BrowserSessionResponse)
async def exchange_legacy_browser_session(
    current_user: CurrentUser,
    _t: Translator,
    request: Request,
    response: Response,
) -> BrowserSessionResponse:
    """Upgrade a validated legacy bearer token to an HttpOnly browser session."""

    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail=_t("auth_token_required"))
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail=_t("auth_token_required"))
    _set_browser_session_cookies(response, request, token)
    return BrowserSessionResponse(
        username=current_user.sub,
        role=current_user.role,
    )


@router.get("/auth/verify", response_model=VerifyResponse)
async def verify(
    current_user: CurrentUser,
):
    """验证 token 有效性

    使用 OAuth2 Bearer token 依赖自动提取和验证 token。
    """
    return VerifyResponse(valid=True, username=current_user.sub, role=current_user.role)


async def _load_user_profile(
    user_id: str,
) -> tuple[str | None, str | None, str | None, datetime | None, str | None]:
    """按 users.id 取 (nickname, avatar_path)；记录不存在时返回 (None, None)。"""
    async with async_session_factory() as s:
        user = (await s.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    return (
        (user.nickname, user.avatar_path, user.email, user.last_login_at, user.last_login_ip)
        if user
        else (None, None, None, None, None)
    )


def _delete_avatar_file(rel_path: str) -> None:
    """删除头像文件（按文件名从 _avatars 根取，不拼接路径防越界）；缺失视为成功。"""
    root = get_project_manager().get_user_avatars_root()
    path = root / Path(rel_path).name
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError:
        logger.warning("delete avatar file failed: %s", rel_path)


@router.get("/auth/me", response_model=CurrentUserResponse)
async def current_user(current_user: CurrentUser) -> CurrentUserResponse:
    nickname, avatar_path, email, last_login_at, last_login_ip = await _load_user_profile(current_user.id)
    return CurrentUserResponse(
        id=current_user.id,
        username=current_user.sub,
        role=current_user.role,
        nickname=nickname,
        avatar_path=avatar_path,
        email=email,
        last_login_at=last_login_at,
        last_login_ip=last_login_ip,
    )


@router.put("/auth/me", response_model=CurrentUserResponse)
async def update_profile(
    req: ProfileUpdateRequest,
    current_user: CurrentUser,
    _t: Translator,
) -> CurrentUserResponse:
    """更新当前用户资料（昵称/邮箱）；空串昵称按清空处理，回退显示 username。"""
    nickname = validate_nickname(req.nickname, _t)
    async with async_session_factory() as s:
        user = (await s.execute(select(User).where(User.id == current_user.id))).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=404, detail=_t("admin_user_not_found"))
        if "nickname" in req.model_fields_set:
            if nickname is not None:
                existing = await s.execute(select(User).where(User.nickname == nickname, User.id != current_user.id))
                if existing.scalar_one_or_none() is not None:
                    raise HTTPException(status_code=409, detail=_t("admin_nickname_exists"))
            user.nickname = nickname
        if "email" in req.model_fields_set:
            user.email = _normalize_email(req.email)
        await s.commit()
        nickname = user.nickname
        avatar_path = user.avatar_path
        email = user.email
        last_login_at = user.last_login_at
        last_login_ip = user.last_login_ip
    return CurrentUserResponse(
        id=current_user.id,
        username=current_user.sub,
        role=current_user.role,
        nickname=nickname,
        avatar_path=avatar_path,
        email=email,
        last_login_at=last_login_at,
        last_login_ip=last_login_ip,
    )


@router.put("/auth/me/avatar", response_model=CurrentUserResponse)
async def update_avatar(
    current_user: CurrentUser,
    _t: Translator,
    avatar: UploadFile = File(...),
) -> CurrentUserResponse:
    """上传/更换当前用户头像；旧文件（扩展名不同时）落库后清理。"""
    ext = Path(avatar.filename or "").suffix.lower()
    if ext not in ALLOWED_AVATAR_EXTS:
        raise HTTPException(status_code=415, detail=_t("invalid_image_format"))
    data = await avatar.read()
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail=_t("avatar_too_large"))

    rel = f"_avatars/{current_user.id}{ext}"
    target = get_project_manager().get_user_avatars_root() / f"{current_user.id}{ext}"
    await asyncio.to_thread(target.write_bytes, data)

    async with async_session_factory() as s:
        user = (await s.execute(select(User).where(User.id == current_user.id))).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=404, detail=_t("admin_user_not_found"))
        old = user.avatar_path
        user.avatar_path = rel
        await s.commit()
        nickname = user.nickname
        email = user.email
        last_login_at = user.last_login_at
        last_login_ip = user.last_login_ip
    if old and old != rel:
        _delete_avatar_file(old)
    return CurrentUserResponse(
        id=current_user.id,
        username=current_user.sub,
        role=current_user.role,
        nickname=nickname,
        avatar_path=rel,
        email=email,
        last_login_at=last_login_at,
        last_login_ip=last_login_ip,
    )


@router.delete("/auth/me/avatar", response_model=CurrentUserResponse)
async def remove_avatar(
    current_user: CurrentUser,
    _t: Translator,
) -> CurrentUserResponse:
    """移除当前用户头像，回退为首字母占位。"""
    async with async_session_factory() as s:
        user = (await s.execute(select(User).where(User.id == current_user.id))).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=404, detail=_t("admin_user_not_found"))
        old = user.avatar_path
        user.avatar_path = None
        await s.commit()
        nickname = user.nickname
        email = user.email
        last_login_at = user.last_login_at
        last_login_ip = user.last_login_ip
    if old:
        _delete_avatar_file(old)
    return CurrentUserResponse(
        id=current_user.id,
        username=current_user.sub,
        role=current_user.role,
        nickname=nickname,
        avatar_path=None,
        email=email,
        last_login_at=last_login_at,
        last_login_ip=last_login_ip,
    )


@router.post("/auth/logout", status_code=204)
async def logout(current_user: CurrentUser, response: Response) -> None:
    if current_user.session_id:
        await revoke_user_session(current_user.session_id, current_user.id)
    response.delete_cookie("matrixspooll_auth_token", path="/api/v1")
    response.delete_cookie("matrixspooll_csrf_token", path="/")


@router.post("/auth/password", status_code=204)
async def change_password(
    body: ChangePasswordRequest,
    current_user: CurrentUser,
    _t: Translator,
) -> None:
    """Change the authenticated database user's password."""
    if not database_auth_initialized() or not current_user.session_id:
        raise HTTPException(status_code=400, detail=_t("password_change_unavailable"))

    user = await authenticate_database_user(current_user.sub, body.current_password)
    if user is None or user.id != current_user.id:
        raise HTTPException(status_code=400, detail=_t("current_password_invalid"))

    updated = await update_user_password(user.id, body.new_password)
    if not updated:
        raise HTTPException(status_code=400, detail=_t("password_change_unavailable"))

    # Keep the current device usable while invalidating every other login.
    await revoke_all_user_sessions(user.id, except_session_id=current_user.session_id)
