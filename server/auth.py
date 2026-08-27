"""
认证核心模块

提供密码生成、JWT token 创建/验证、凭据校验等功能。
同时支持 API Key 认证（`msp-` 前缀的 Bearer token）。

浏览器发起请求的认证模式：
- SSE 和浏览器原生媒体请求通过 Authorization header 或 HttpOnly Cookie 认证
- 导出端点使用短时效下载 token（``purpose=download``）作为 query param 唯一认证方式
- 静态媒体文件不要求认证
新端点须按用途选用对应模式。
"""

import hashlib
import logging
import os
import secrets
import string
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, timedelta
from pathlib import Path
from typing import Annotated, Literal
from uuid import NAMESPACE_URL, uuid4, uuid5

import jwt
from fastapi import Cookie, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_, select, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from lib import PROJECT_ROOT
from lib.db import async_session_factory
from lib.db.base import LEGACY_DEFAULT_USER_ID, utc_now
from lib.db.models.user import User
from lib.db.models.user_session import UserSession
from lib.db.repositories.base import rowcount
from lib.i18n import Translator
from lib.i18n import _ as translate_message

logger = logging.getLogger(__name__)


class CurrentUserInfo(BaseModel):
    """Current authenticated user info."""

    id: str
    sub: str
    role: str = "member"
    session_id: str | None = None
    auth_method: Literal["jwt", "api_key", "anonymous"] = "jwt"
    is_superadmin: bool = False

    model_config = ConfigDict(frozen=True)


# JWT 签名密钥缓存
_cached_token_secret: str | None = None

# Token 有效期：7 天
TOKEN_EXPIRY_SECONDS = 7 * 24 * 3600

# 关闭认证时返回的匿名用户标识
_ANONYMOUS_USER_SUB = "local"

# 视为"关闭认证"的 env 取值。空串不在内 —— .env 误写 `AUTH_ENABLED=` 应回退到默认（开启），
# 避免静默 fail-open。
_AUTH_DISABLED_VALUES = frozenset({"false", "0", "no", "off"})
_TESTING_VALUES = frozenset({"1", "true", "yes", "on"})


def is_auth_enabled() -> bool:
    """``AUTH_ENABLED`` env 解析。默认 ``true``，保持现有部署行为；空值也按默认。

    ``false`` / ``0`` / ``no`` / ``off`` 一律视为关闭（不区分大小写）。
    """
    return os.environ.get("AUTH_ENABLED", "true").strip().lower() not in _AUTH_DISABLED_VALUES


def is_testing() -> bool:
    """Return whether the process explicitly opted into test-only fallbacks."""

    return os.environ.get("TESTING", "").strip().lower() in _TESTING_VALUES


def _anonymous_user() -> "CurrentUserInfo":
    """关闭认证时返回的固定匿名用户。"""
    return CurrentUserInfo(
        # Anonymous mode is a test/local transport identity, not a database
        # user and never a superadmin account.
        id="00000000-0000-0000-0000-000000000000",
        sub=_ANONYMOUS_USER_SUB,
        role="admin",
        auth_method="anonymous",
        # 本地/测试单用户等同超管，保留完整项目操作能力，避免降权回归。
        is_superadmin=True,
    )


# OAuth2 scheme
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token")
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token", auto_error=False)

# 密码哈希
_password_hash = PasswordHash.recommended()
_cached_password_hash: str | None = None

# The lifespan sets this after the database bootstrap has completed. Keeping a
# small legacy fallback before that point preserves CLI/test clients that mount
# only the auth router and do not run the application lifespan.
_database_auth_initialized = False

SESSION_EXPIRY_SECONDS = 7 * 24 * 3600
SESSION_ONLINE_WINDOW_SECONDS = 120
SESSION_TOUCH_INTERVAL_SECONDS = 30
SessionState = Literal["active", "replaced", "revoked", "expired", "invalid"]


def hash_password(password: str) -> str:
    """Hash a user password with the configured password-hashing backend."""
    return _password_hash.hash(password)


def generate_password(length: int = 16) -> str:
    """生成随机字母数字密码"""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def get_token_secret() -> str:
    """获取 JWT 签名密钥

    优先使用 AUTH_TOKEN_SECRET 环境变量，否则自动生成并缓存。
    """
    global _cached_token_secret

    env_secret = os.environ.get("AUTH_TOKEN_SECRET")
    if env_secret:
        return env_secret

    if _cached_token_secret is not None:
        return _cached_token_secret

    _cached_token_secret = secrets.token_hex(32)
    logger.info("已自动生成 JWT 签名密钥")
    return _cached_token_secret


async def ensure_database_users() -> None:
    """Ensure the migrated default account has a database password.

    Environment credentials are used only as the one-time bootstrap source.
    Subsequent logins are always checked against the database user record.
    """
    global _database_auth_initialized

    if not is_auth_enabled():
        return

    password = os.environ.get("AUTH_PASSWORD", "")
    username = os.environ.get("AUTH_USERNAME", "admin").strip() or "admin"
    async with async_session_factory() as session:
        async with session.begin():
            result = await session.execute(select(User).where(User.is_superadmin.is_(True)).limit(1))
            user = result.scalar_one_or_none()
            if user is None:
                legacy = await session.get(User, LEGACY_DEFAULT_USER_ID)
                if legacy is not None:
                    raise RuntimeError(
                        "legacy superadmin id 'default' is still present; run the identity migration before startup"
                    )
            if user is None:
                configured = await session.execute(select(User).where(User.username == username).limit(1))
                user = configured.scalar_one_or_none()
                if user is not None:
                    user.is_superadmin = True
                    user.role = "admin"
            if user is None:
                user = User(
                    id=uuid4().hex,
                    username=username,
                    password_hash=_password_hash.hash(password) if password else None,
                    role="admin",
                    is_active=True,
                    is_superadmin=True,
                )
                session.add(user)
            elif user.password_hash is None and password:
                user.password_hash = _password_hash.hash(password)
            if user.username != username:
                username_taken = await session.execute(
                    select(User.id).where(User.username == username, User.id != user.id)
                )
                if username_taken.scalar_one_or_none() is None:
                    user.username = username
                else:
                    logger.warning(
                        "AUTH_USERNAME is already used by another account; preserving the superadmin username"
                    )
            user.role = "admin"
            user.is_active = True
            user.is_superadmin = True
    _database_auth_initialized = True


def database_auth_initialized() -> bool:
    """Whether startup completed the database-user bootstrap."""
    return _database_auth_initialized


async def _get_user_by_username(username: str) -> User | None:
    async with async_session_factory() as session:
        result = await session.execute(select(User).where(User.username == username))
        return result.scalar_one_or_none()


async def authenticate_database_user(username: str, password: str) -> User | None:
    """Return an active user after verifying its database password."""
    try:
        user = await _get_user_by_username(username)
    except OperationalError:
        return None
    if user is None or not user.is_active or not user.password_hash:
        return None
    try:
        valid = _password_hash.verify(password, user.password_hash)
    except (TypeError, ValueError):
        valid = False
    return user if valid else None


async def database_user_exists(username: str) -> bool:
    """Return whether the database owns a username, including disabled users."""
    try:
        return await _get_user_by_username(username) is not None
    except OperationalError:
        return False


async def create_user_session(
    user: User,
    *,
    device_id: str,
    ip_address: str | None,
    user_agent: str | None,
) -> UserSession:
    """Replace an existing session from the same browser identity or source IP."""
    now = utc_now()
    session_id = uuid4().hex
    same_client = UserSession.device_id == device_id
    if ip_address:
        same_client = or_(same_client, UserSession.ip_address == ip_address)
    async with async_session_factory() as db_session:
        async with db_session.begin():
            await db_session.execute(
                update(UserSession)
                .where(
                    UserSession.user_id == user.id,
                    same_client,
                    UserSession.revoked_at.is_(None),
                )
                .values(revoked_at=now, updated_at=now)
            )
            await db_session.execute(
                update(User).where(User.id == user.id).values(last_login_at=now, last_login_ip=ip_address)
            )
            row = UserSession(
                id=session_id,
                user_id=user.id,
                device_id=device_id,
                token_id=session_id,
                ip_address=ip_address,
                user_agent=user_agent,
                last_seen_at=now,
                expires_at=now + timedelta(seconds=SESSION_EXPIRY_SECONDS),
            )
            db_session.add(row)
            await db_session.flush()
            await db_session.refresh(row)
            return row


async def revoke_user_session(session_id: str, user_id: str | None = None) -> bool:
    """Revoke one session, optionally scoped to its owner."""
    now = utc_now()
    async with async_session_factory() as db_session:
        async with db_session.begin():
            stmt = update(UserSession).where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
            if user_id is not None:
                stmt = stmt.where(UserSession.user_id == user_id)
            result = await db_session.execute(stmt.values(revoked_at=now, updated_at=now))
            return rowcount(result) > 0


async def get_user_session_state(user_id: str, session_id: str) -> SessionState:
    """Return the terminal reason for a browser session without touching its presence timestamp."""

    now = utc_now()
    async with async_session_factory() as db_session:
        result = await db_session.execute(
            select(User, UserSession)
            .join(UserSession, UserSession.user_id == User.id)
            .where(User.id == user_id, UserSession.id == session_id)
        )
        row = result.first()
        if row is None:
            return "invalid"

        user, browser_session = row
        if not user.is_active:
            return "revoked"

        expires_at = browser_session.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if expires_at <= now:
            return "expired"
        if browser_session.revoked_at is None:
            return "active"

        same_client = UserSession.device_id == browser_session.device_id
        if browser_session.ip_address:
            same_client = or_(same_client, UserSession.ip_address == browser_session.ip_address)
        replacement = await db_session.scalar(
            select(UserSession.id)
            .where(
                UserSession.user_id == user_id,
                UserSession.id != session_id,
                same_client,
                UserSession.revoked_at.is_(None),
                UserSession.expires_at > now,
            )
            .limit(1)
        )
        return "replaced" if replacement is not None else "revoked"


async def revoke_all_user_sessions(
    user_id: str,
    except_session_id: str | None = None,
    *,
    session: AsyncSession | None = None,
) -> int:
    """Revoke active sessions, optionally within the caller's transaction."""
    now = utc_now()

    async def _execute(db_session: AsyncSession) -> int:
        stmt = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        if except_session_id is not None:
            stmt = stmt.where(UserSession.id != except_session_id)
        result = await db_session.execute(stmt.values(revoked_at=now, updated_at=now))
        return rowcount(result)

    if session is not None:
        return await _execute(session)

    async with async_session_factory() as db_session:
        async with db_session.begin():
            return await _execute(db_session)


async def update_user_password(user_id: str, new_password: str) -> bool:
    """Replace a database user's password hash."""
    async with async_session_factory() as db_session:
        async with db_session.begin():
            result = await db_session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if user is None or not user.is_active:
                return False
            user.password_hash = hash_password(new_password)
    return True


async def _session_user(payload: dict) -> CurrentUserInfo | None:
    """Resolve a modern JWT through its database user and revocable session."""
    user_id = payload.get("uid")
    session_id = payload.get("sid")
    if not isinstance(user_id, str) or not isinstance(session_id, str):
        return None

    async with async_session_factory() as db_session:
        result = await db_session.execute(
            select(User, UserSession)
            .join(UserSession, UserSession.user_id == User.id)
            .where(User.id == user_id, UserSession.id == session_id)
        )
        row = result.first()
        if row is None:
            return None
        user, session = row
        now = utc_now()
        expires_at = session.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if not user.is_active or session.revoked_at is not None or expires_at <= now:
            return None

        last_seen_at = session.last_seen_at
        if last_seen_at is not None and last_seen_at.tzinfo is None:
            last_seen_at = last_seen_at.replace(tzinfo=UTC)
        if last_seen_at is None or last_seen_at <= now - timedelta(seconds=SESSION_TOUCH_INTERVAL_SECONDS):
            session.last_seen_at = now
            await db_session.commit()

        return CurrentUserInfo(
            id=user.id,
            sub=user.username,
            role=user.role if user.role in {"admin", "member"} else "member",
            session_id=session.id,
            is_superadmin=user.is_superadmin,
        )


def create_token(
    username: str,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    role: str | None = None,
) -> str:
    """创建 JWT token

    Args:
        username: 用户名

    Returns:
        JWT token 字符串
    """
    now = time.time()
    payload = {
        "sub": username,
        "iat": now,
        "exp": now + TOKEN_EXPIRY_SECONDS,
    }
    if user_id is not None:
        payload["uid"] = user_id
    if session_id is not None:
        payload["sid"] = session_id
    if role is not None:
        payload["role"] = role
    return jwt.encode(payload, get_token_secret(), algorithm="HS256")


def verify_token(token: str) -> dict | None:
    """验证 JWT token

    Args:
        token: JWT token 字符串

    Returns:
        成功返回 payload dict，失败返回 None
    """
    try:
        payload = jwt.decode(token, get_token_secret(), algorithms=["HS256"])
        return payload
    except (jwt.InvalidTokenError, jwt.ExpiredSignatureError):
        return None


DOWNLOAD_TOKEN_EXPIRY_SECONDS = 300  # 5 分钟


def create_download_token(username: str, project_name: str) -> str:
    """签发短时效下载 token，用于浏览器原生下载认证"""
    now = time.time()
    payload = {
        "sub": username,
        "project": project_name,
        "purpose": "download",
        "iat": now,
        "exp": now + DOWNLOAD_TOKEN_EXPIRY_SECONDS,
    }
    return jwt.encode(payload, get_token_secret(), algorithm="HS256")


def verify_download_token(token: str, project_name: str) -> dict:
    """验证下载 token

    Returns:
        成功返回 payload dict

    Raises:
        jwt.ExpiredSignatureError: token 已过期
        jwt.InvalidTokenError: token 无效
        ValueError: purpose 或 project 不匹配
    """
    if not is_auth_enabled():
        return {
            "sub": _ANONYMOUS_USER_SUB,
            "project": project_name,
            "purpose": "download",
        }
    payload = jwt.decode(token, get_token_secret(), algorithms=["HS256"])
    if payload.get("purpose") != "download":
        raise ValueError("token purpose 不匹配")
    if payload.get("project") != project_name:
        raise ValueError("token project 不匹配")
    return payload


def _get_password_hash() -> str:
    """获取当前密码的哈希值（缓存）"""
    global _cached_password_hash
    if _cached_password_hash is None:
        raw = os.environ.get("AUTH_PASSWORD", "")
        _cached_password_hash = _password_hash.hash(raw)
    return _cached_password_hash


def check_credentials(username: str, password: str) -> bool:
    """校验用户名密码（使用哈希比对）

    从 AUTH_USERNAME（默认 admin）和 AUTH_PASSWORD 环境变量读取。
    即使用户名不匹配也执行哈希验证，防止时序攻击。

    ``AUTH_ENABLED=false`` 时无条件返回 True。
    """
    if not is_auth_enabled():
        return True
    expected_username = os.environ.get("AUTH_USERNAME", "admin")
    pw_hash = _get_password_hash()
    username_ok = secrets.compare_digest(username, expected_username)
    password_ok = _password_hash.verify(password, pw_hash)
    return username_ok and password_ok


def ensure_auth_password(env_path: str | None = None) -> str:
    """确保 AUTH_PASSWORD 已设置

    如果 AUTH_PASSWORD 环境变量为空，自动生成密码，写入环境变量，
    回写到 .env 文件，并用 logger.warning 输出到控制台。

    ``AUTH_ENABLED=false`` 时整个步骤跳过（不生成、不回写）。

    Args:
        env_path: .env 文件路径，默认为项目根目录的 .env

    Returns:
        当前的 AUTH_PASSWORD 值；关闭认证时返回空串。
    """
    if not is_auth_enabled():
        return ""
    password = os.environ.get("AUTH_PASSWORD")
    if password:
        return password

    # 自动生成密码
    password = generate_password()
    os.environ["AUTH_PASSWORD"] = password

    # 回写到 .env 文件
    if env_path is None:
        env_path = str(PROJECT_ROOT / ".env")

    env_file = Path(env_path)
    try:
        if env_file.exists():
            try:
                lines = env_file.read_text(encoding="utf-8").splitlines()
            except UnicodeDecodeError:
                # 历史 .env 可能用 cp936 / ANSI 等本地编码（早期 Windows 用户写过中文注释/值）；
                # 不强制覆写以免丢失用户内容，仅 log 并跳过自动回写。
                # 进程内 password 已 set 到 os.environ，本次启动仍可用，只是不持久化。
                logger.warning(
                    "无法以 UTF-8 解码 %s，跳过 AUTH_PASSWORD 自动回写；"
                    "请将该文件转存为 UTF-8 后重启以持久化生成的密码",
                    env_path,
                )
                return password
            new_lines = []
            found = False
            for line in lines:
                if not found and line.strip().startswith("AUTH_PASSWORD="):
                    new_lines.append(f"AUTH_PASSWORD={password}")
                    found = True
                else:
                    new_lines.append(line)
            if not found:
                new_lines.append(f"AUTH_PASSWORD={password}")
            new_content = "\n".join(new_lines) + "\n"
            # 使用原地写入（truncate + write）保留 inode，兼容 Docker bind mount
            with open(env_file, "r+", encoding="utf-8") as f:
                f.seek(0)
                f.write(new_content)
                f.truncate()
        else:
            env_file.write_text(f"AUTH_PASSWORD={password}\n", encoding="utf-8")
    except OSError:
        logger.warning("无法写入 .env 文件: %s", env_path)

    logger.warning("已自动生成认证密码，请查看 .env 文件中的 AUTH_PASSWORD 字段")
    return password


# ---------------------------------------------------------------------------
# API Key 认证支持
# ---------------------------------------------------------------------------

API_KEY_PREFIX = "msp-"
# Existing keys remain valid after the product identity rename. This is an
# authentication compatibility marker only; newly issued keys always use the
# current prefix above.
LEGACY_API_KEY_PREFIX = "arc-"
API_KEY_PREFIXES = (API_KEY_PREFIX, LEGACY_API_KEY_PREFIX)
API_KEY_CACHE_TTL = 300  # 5 分钟

# LRU 缓存：key_hash → (payload_dict | None, expires_at_timestamp)
# payload 为 None 表示 key 不存在或已过期（负缓存）
# 使用 OrderedDict 实现 LRU：命中时 move_to_end，淘汰时 popitem(last=False)
_api_key_cache: OrderedDict[str, tuple[dict | None, float]] = OrderedDict()
_api_key_cache_generations: dict[str, int] = {}
_API_KEY_CACHE_MAX = 512


def _hash_api_key(key: str) -> str:
    """计算 API Key 的 SHA-256 哈希。"""
    return hashlib.sha256(key.encode()).hexdigest()


def invalidate_api_key_cache(key_hash: str) -> None:
    """清除缓存并阻止已经在途的旧查询重新写入该密钥。"""
    _api_key_cache_generations[key_hash] = _api_key_cache_generations.get(key_hash, 0) + 1
    _api_key_cache.pop(key_hash, None)


def _get_cached_api_key_payload(key_hash: str) -> tuple[bool, dict | None]:
    """从缓存中查找。返回 (命中, payload 或 None)。命中时将条目移至末尾（LRU）。"""
    entry = _api_key_cache.get(key_hash)
    if entry is None:
        return False, None
    payload, expiry = entry
    if time.monotonic() > expiry:
        _api_key_cache.pop(key_hash, None)
        return False, None
    _api_key_cache.move_to_end(key_hash)
    return True, payload


def _set_api_key_cache(
    key_hash: str,
    payload: dict | None,
    expires_at_ts: float | None = None,
    *,
    expected_generation: int | None = None,
) -> None:
    """写入缓存（含 LRU 淘汰）。

    正向缓存（payload 非 None）TTL 以 key 实际过期时间为上界，
    避免 key 过期后仍在缓存中通过验证的安全问题。
    """
    if expected_generation is not None and _api_key_cache_generations.get(key_hash, 0) != expected_generation:
        return
    if len(_api_key_cache) >= _API_KEY_CACHE_MAX:
        # 淘汰最久未使用的条目（LRU：OrderedDict 头部）
        _api_key_cache.popitem(last=False)
    ttl = API_KEY_CACHE_TTL
    if payload is not None and expires_at_ts is not None:
        time_to_expiry = expires_at_ts - time.monotonic()
        if time_to_expiry <= 0:
            # key 已过期，写入负缓存
            _api_key_cache[key_hash] = (None, time.monotonic() + API_KEY_CACHE_TTL)
            return
        ttl = min(ttl, time_to_expiry)
    _api_key_cache[key_hash] = (payload, time.monotonic() + ttl)


async def _verify_api_key(token: str) -> dict | None:
    """验证 API Key token，返回 payload dict 或 None（失败/过期/不存在）。

    内部先查缓存，缓存未命中再查数据库。
    查库成功后更新 last_used_at（后台异步，不阻塞响应）。
    """
    key_hash = _hash_api_key(token)

    # 缓存查询
    hit, cached_payload = _get_cached_api_key_payload(key_hash)
    if hit:
        return cached_payload
    cache_generation = _api_key_cache_generations.get(key_hash, 0)

    # 数据库查询
    from lib.db import async_session_factory
    from lib.db.repositories.api_key_repository import ApiKeyRepository

    async with async_session_factory() as session:
        async with session.begin():
            repo = ApiKeyRepository(session)
            row = await repo.get_by_hash(key_hash)

    if row is None:
        _set_api_key_cache(key_hash, None, expected_generation=cache_generation)
        return None

    # 检查过期
    expires_at = row.get("expires_at")
    expires_at_monotonic: float | None = None
    if expires_at:
        from datetime import datetime

        try:
            exp_dt = expires_at
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=UTC)
            if datetime.now(UTC) >= exp_dt:
                _set_api_key_cache(key_hash, None, expected_generation=cache_generation)
                return None
            # 将过期时刻转换为 monotonic 时间戳，供缓存 TTL 上界计算
            remaining_secs = (exp_dt - datetime.now(UTC)).total_seconds()
            expires_at_monotonic = time.monotonic() + remaining_secs
        except (ValueError, TypeError):
            logger.warning("API Key expires_at 值格式无法解析，忽略过期检查: %r", expires_at)

    if row.get("revoked_at") is not None:
        _set_api_key_cache(key_hash, None, expected_generation=cache_generation)
        return None

    user_id = row.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        _set_api_key_cache(key_hash, None, expected_generation=cache_generation)
        return None

    payload = {"sub": f"apikey:{row['name']}", "uid": user_id, "via": "apikey"}
    _set_api_key_cache(
        key_hash,
        payload,
        expires_at_ts=expires_at_monotonic,
        expected_generation=cache_generation,
    )

    # 异步更新 last_used_at（不阻塞，保存引用防止 GC）
    import asyncio

    async def _touch():
        try:
            async with async_session_factory() as s:
                async with s.begin():
                    await ApiKeyRepository(s).touch_last_used(key_hash)
        except Exception:
            logger.exception("更新 API Key last_used_at 失败（非致命）")

    _touch_task = asyncio.create_task(_touch())
    _touch_task.add_done_callback(lambda _: None)  # suppress "never retrieved" warning

    return payload


def _verify_and_get_payload(token: str) -> dict:
    """同步验证 JWT token 并在失败时抛出 401 异常。（仅用于 JWT 路径）"""
    payload = verify_token(token)
    if payload is None:
        raise HTTPException(
            status_code=401,
            detail="token 无效或已过期",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


async def _verify_and_get_payload_async(
    token: str,
    _t: Callable[..., str] = translate_message,
) -> dict:
    """异步验证 API Key 或 JWT token。"""
    if token.startswith(API_KEY_PREFIXES):
        payload = await _verify_api_key(token)
        if payload is None:
            raise HTTPException(
                status_code=401,
                detail=_t("api_key_invalid"),
                headers={"WWW-Authenticate": "Bearer"},
            )
        return payload

    jwt_payload = verify_token(token)
    if jwt_payload is not None:
        return jwt_payload

    raise HTTPException(
        status_code=401,
        detail=_t("token_invalid"),
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _payload_to_user(
    payload: dict,
    _t: Callable[..., str] = translate_message,
) -> CurrentUserInfo:
    """Convert a verified JWT/API-key payload to a current user."""
    if payload.get("via") == "apikey":
        user_id = payload.get("uid")
        if not isinstance(user_id, str) or not user_id:
            raise HTTPException(
                status_code=401,
                detail=_t("api_key_user_invalid"),
                headers={"WWW-Authenticate": "Bearer"},
            )
        async with async_session_factory() as db_session:
            user = await db_session.get(User, user_id)
        if user is None or not user.is_active:
            raise HTTPException(
                status_code=401,
                detail=_t("api_key_user_invalid"),
                headers={"WWW-Authenticate": "Bearer"},
            )
        return CurrentUserInfo(
            id=user.id,
            sub=user.username,
            role="member",
            auth_method="api_key",
        )

    if payload.get("uid") and payload.get("sid"):
        try:
            user = await _session_user(payload)
        except OperationalError:
            user = None
        if user is None:
            raise HTTPException(
                status_code=401,
                detail=_t("session_invalid"),
                headers={"WWW-Authenticate": "Bearer"},
            )
        return user

    # Older JWTs did not carry a session id. Resolve their subject by username
    # during the migration window instead of mapping them to a magic id.
    subject = payload.get("sub")
    if isinstance(subject, str) and subject:
        if not database_auth_initialized():
            return CurrentUserInfo(
                id=uuid5(NAMESPACE_URL, f"matrixspooll:bootstrap-user:{subject}").hex,
                sub=subject,
                role="admin",
                is_superadmin=True,
            )
        async with async_session_factory() as db_session:
            user = await db_session.scalar(select(User).where(User.username == subject, User.is_active.is_(True)))
        if user is not None:
            return CurrentUserInfo(id=user.id, sub=user.username, role=user.role, is_superadmin=user.is_superadmin)
    raise HTTPException(
        status_code=401,
        detail=_t("session_invalid"),
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    _t: Translator,
    token: Annotated[str | None, Depends(oauth2_scheme_optional)] = None,
    cookie_token: Annotated[str | None, Cookie(alias="matrixspooll_auth_token")] = None,
) -> CurrentUserInfo:
    """标准认证依赖 — 支持 Bearer token 和浏览器 HttpOnly Cookie。

    ``AUTH_ENABLED=false`` 时无视 token，直接返回匿名 admin。
    启用时缺 token 抛 401（与旧 oauth2_scheme auto_error 行为等价）。
    """
    if not is_auth_enabled():
        return _anonymous_user()
    raw = next(
        (candidate for candidate in (token, cookie_token) if isinstance(candidate, str) and candidate),
        None,
    )
    if not raw:
        raise HTTPException(
            status_code=401,
            detail=_t("auth_required"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = await _verify_and_get_payload_async(raw, _t)
    return await _payload_to_user(payload, _t)


async def get_current_user_flexible(
    _t: Translator,
    token: Annotated[str | None, Depends(oauth2_scheme_optional)] = None,
    cookie_token: Annotated[str | None, Cookie(alias="matrixspooll_auth_token")] = None,
) -> CurrentUserInfo:
    """SSE 认证依赖 — 同时支持 Authorization header 和 HttpOnly Cookie。

    ``AUTH_ENABLED=false`` 时无视 token，直接返回匿名 admin。
    """
    if not is_auth_enabled():
        return _anonymous_user()
    raw = next(
        (candidate for candidate in (token, cookie_token) if isinstance(candidate, str) and candidate),
        None,
    )
    if not raw:
        raise HTTPException(
            status_code=401,
            detail=_t("auth_token_required"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = await _verify_and_get_payload_async(raw, _t)
    return await _payload_to_user(payload, _t)


# Type aliases for FastAPI dependency injection
CurrentUser = Annotated[CurrentUserInfo, Depends(get_current_user)]
CurrentUserFlexible = Annotated[CurrentUserInfo, Depends(get_current_user_flexible)]


async def require_admin(user: CurrentUser, _t: Translator) -> CurrentUserInfo:
    """Authorization seam for administrator-only routes."""
    if user.role != "admin" or user.auth_method == "api_key":
        raise HTTPException(status_code=403, detail=_t("admin_required"))
    return user


AdminUser = Annotated[CurrentUserInfo, Depends(require_admin)]
