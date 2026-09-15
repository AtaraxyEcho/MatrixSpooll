"""供应商文档能力同步管线。

从能力源（见 vendor_sources）的 llms.txt 索引建立 model_id → OpenAPI URL 映射，按需拉取
单个模型的契约 YAML，一次结构化解析为稀疏能力声明，落 custom_provider_model.vendor_capabilities。
声明进入既有合成链时位于用户覆盖之下、端点判定之上（键级合并，见
CustomProviderModel.merged_capability_overrides）。

纪律：
- 解析只提取机器可读的结构化字段；prose 中的逐类参考上限 v1 不解析（回落端点判定/用户覆盖）；
- 未声明不猜测：解析不出的字段键缺席，不套用其他模型的值；
- 失败方向是「降级为现状」：本模块所有公开入口都不把异常抛进生成路径；
- 请求礼貌：标识 UA、ETag 条件请求、同站并发 ≤2、响应 ≤5MB、超时随共享 client。
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlsplit

import httpx
import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from lib.custom_provider.endpoints import endpoint_to_media_type
from lib.custom_provider.vendor_sources import VendorSource, match_vendor_source
from lib.db.base import utc_now
from lib.db.models.custom_provider import CustomProvider, CustomProviderModel
from lib.db.repositories.custom_provider_repo import CustomProviderRepository
from lib.httpx_shared import get_http_client

logger = logging.getLogger(__name__)

_INDEX_TTL = timedelta(hours=24)
_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
_USER_AGENT = "MatrixSpooll (capability-sync)"
_FETCH_CONCURRENCY = asyncio.Semaphore(2)

# llms.txt 索引里的模型契约页：api-reference/model-api/<vendor>/openapi/<slug>/openapi.yaml。
# /zh/ 前缀是中文镜像页，与英文版同slug，去重时英文版优先。
_MODEL_SPEC_PATTERN = re.compile(
    r"(?P<zh>/zh)?api-reference/model-api/[^/\s)\"'<>]+/openapi/(?P<slug>[^/\s)\"'<>]+)/openapi\.yaml"
)
_RATIO_PATTERN = re.compile(r"\d{1,4}:\d{1,4}")
# duration 参数的取值范围写在 description 里："an integer from 2 through 30" / "4-15" / "4–30 秒"。
_DURATION_RANGE_PATTERN = re.compile(r"(\d{1,3})\s*(?:through|to|[–—-])\s*(\d{1,3})")

# 同步结果常量（前端按 key 翻译；不做异常通道——失败是常态路径而非例外）。
STATUS_SYNCED = "synced"
STATUS_UNCHANGED = "unchanged"
STATUS_NOT_FOUND = "not_found"
STATUS_NO_DATA = "no_data"
STATUS_FETCH_FAILED = "fetch_failed"
STATUS_NO_SOURCE = "no_source"
STATUS_NON_VIDEO = "non_video"

_INDEX_CACHE: dict[str, tuple[datetime, str, str | None]] = {}  # key -> (fetched_at, text, etag)
_INDEX_LOCKS: dict[str, asyncio.Lock] = {}


def _site_root(source: VendorSource) -> str:
    parsed = urlsplit(source.llms_txt)
    return f"{parsed.scheme}://{parsed.netloc}"


def parse_llms_index(text: str, *, base_url: str) -> dict[str, str]:
    """从 llms.txt 文本解析 model_id → OpenAPI URL 映射；英文版优先于 /zh/ 镜像。"""
    root = base_url.rstrip("/")
    english: dict[str, str] = {}
    chinese: dict[str, str] = {}
    for match in _MODEL_SPEC_PATTERN.finditer(text):
        url = f"{root}/{match.group(0).lstrip('/')}"
        target = chinese if match.group("zh") else english
        target.setdefault(match.group("slug"), url)
    return {**chinese, **english}


def _normalize_resolution(token: str) -> str:
    """分辨率 token 归一：已知 p 系档位大小写收敛（1080P→1080p），未知 token 原样保留。"""
    stripped = token.strip()
    lowered = stripped.lower()
    if lowered in {"480p", "720p", "1080p"}:
        return lowered
    return stripped


# sora 等用 `size`（"宽x高"字符串）而非 resolution 档位表达输出尺寸。适配器层（如
# _resolve_size）按分辨率档位 + 比例吸附到合法 size，故声明层把 size 集合还原成
# 「最近档位 + 约分比例」，保持与请求构造同源。
_SIZE_PATTERN = re.compile(r"(\d{2,5})x(\d{2,5})")
_TIER_SHORT_EDGES: dict[str, int] = {"480p": 480, "720p": 720, "1080p": 1080, "2K": 1440, "4K": 2160}


def _tiers_from_sizes(sizes: list[str]) -> list[str]:
    """size 集合 → 覆盖到的分辨率档位（短边取最近档）。"""
    tiers: list[str] = []
    for size in sizes:
        match = _SIZE_PATTERN.fullmatch(size)
        if not match:
            continue
        short = min(int(match.group(1)), int(match.group(2)))
        tier = min(_TIER_SHORT_EDGES.items(), key=lambda kv: abs(kv[1] - short))[0]
        if tier not in tiers:
            tiers.append(tier)
    return tiers


def _ratios_from_sizes(sizes: list[str]) -> list[str]:
    """size 集合 → 约分后的宽高比（如 720x1280 → 9:16），保持首现顺序去重。"""
    from math import gcd

    ratios: list[str] = []
    for size in sizes:
        match = _SIZE_PATTERN.fullmatch(size)
        if not match:
            continue
        width, height = int(match.group(1)), int(match.group(2))
        divisor = gcd(width, height)
        ratio = f"{width // divisor}:{height // divisor}"
        if ratio not in ratios:
            ratios.append(ratio)
    return ratios


def _extract_durations(prop: dict[str, object]) -> list[int]:
    """duration/seconds 参数 → 正整数档位列表。枚举（含数字字符串）直接取值；整数形态从 description 解析区间。"""
    enum = prop.get("enum")
    if isinstance(enum, list):
        values = {int(v) for v in enum if isinstance(v, int) or (isinstance(v, str) and v.strip().isdigit())}
        return sorted(v for v in values if v > 0)
    description = prop.get("description")
    if isinstance(description, str):
        match = _DURATION_RANGE_PATTERN.search(description)
        if match:
            low, high = int(match.group(1)), int(match.group(2))
            if 0 < low <= high <= 120:
                return list(range(low, high + 1))
    return []


def _iter_schema_nodes(node: object) -> Iterator[dict[str, object]]:
    """深度优先产出 OpenAPI 树里的每个 dict 节点（含 properties/enum 的任意嵌套层级）。"""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _iter_schema_nodes(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_schema_nodes(item)


def parse_video_capabilities(spec: dict[str, object]) -> dict[str, object]:
    """从 OpenAPI 文档提取稀疏视频能力声明。

    只输出文档显式声明的字段；输出键对齐 VideoCapabilities，值形态与能力覆盖写入侧一致
    （序列为 list，落库后经 merged_capability_overrides 直接进合成链）。
    """
    resolutions: list[str] = []
    ratios: list[str] = []
    durations: list[int] = []
    size_resolutions: list[str] = []
    size_ratios: list[str] = []
    max_prompt_chars: int | None = None
    first_frame = False
    last_frame = False
    adaptive_only = False

    for node in _iter_schema_nodes(spec):
        # 媒体角色枚举（值含 first_frame/last_frame/reference_*）→ 首帧/尾帧位。
        # 请求与任务查询响应里出现同一枚举等价（描述的是同一模型的角色集）。
        enum = node.get("enum")
        if isinstance(enum, list) and enum:
            values = {v.strip().lower() for v in enum if isinstance(v, str)}
            if "first_frame" in values:
                first_frame = True
            if "last_frame" in values:
                last_frame = True
        properties = node.get("properties")
        if not isinstance(properties, dict):
            continue
        for name, prop in properties.items():
            if not isinstance(prop, dict):
                continue
            if name == "resolution":
                prop_enum = prop.get("enum")
                if isinstance(prop_enum, list):
                    resolutions = [
                        token for token in (_normalize_resolution(v) for v in prop_enum if isinstance(v, str)) if token
                    ]
            elif name in ("ratio", "aspect_ratio"):
                prop_enum = prop.get("enum")
                if isinstance(prop_enum, list):
                    for value in prop_enum:
                        if not isinstance(value, str):
                            continue
                        token = value.strip()
                        if token.lower() == "adaptive":
                            adaptive_only = True
                        elif _RATIO_PATTERN.fullmatch(token) and token not in ratios:
                            ratios.append(token)
            elif name in ("duration", "duration_seconds", "seconds"):
                extracted = _extract_durations(prop)
                if extracted:
                    durations = extracted
            elif name == "size":
                prop_enum = prop.get("enum")
                if isinstance(prop_enum, list):
                    sizes = [v.strip() for v in prop_enum if isinstance(v, str)]
                    size_resolutions = _tiers_from_sizes(sizes)
                    size_ratios = _ratios_from_sizes(sizes)
            elif name == "prompt":
                max_length = prop.get("maxLength")
                if isinstance(max_length, int) and max_length > 0:
                    max_prompt_chars = max_length
            elif name == "first_frame" and prop.get("type") == "boolean":
                first_frame = True
            elif name == "last_frame" and prop.get("type") == "boolean":
                last_frame = True

    declared: dict[str, object] = {}
    if resolutions:
        declared["supported_resolutions"] = resolutions
    elif size_resolutions:
        declared["supported_resolutions"] = size_resolutions
    if ratios:
        declared["supported_aspect_ratios"] = ratios
    elif size_ratios:
        declared["supported_aspect_ratios"] = size_ratios
    if durations:
        declared["supported_durations"] = durations
    if first_frame:
        declared["first_frame"] = True
    if last_frame:
        declared["last_frame"] = True
    if adaptive_only:
        declared["first_frame_ratio_adaptive_only"] = True
    if max_prompt_chars is not None:
        declared["max_prompt_chars"] = max_prompt_chars
    return declared


@dataclass(frozen=True)
class _FetchedText:
    """一次文本拉取的结果；304 语义用 text=None 表达（etag 仍返回，供续用）。"""

    text: str | None
    etag: str | None


async def _fetch_text(client: httpx.AsyncClient, url: str, *, etag: str | None = None) -> _FetchedText:
    headers = {"User-Agent": _USER_AGENT}
    if etag:
        headers["If-None-Match"] = etag
    async with _FETCH_CONCURRENCY:
        response = await client.get(url, headers=headers)
    if response.status_code == 304:
        return _FetchedText(text=None, etag=etag or response.headers.get("ETag"))
    response.raise_for_status()
    content_length = response.headers.get("Content-Length")
    if content_length and int(content_length) > _MAX_RESPONSE_BYTES:
        raise ValueError(f"response too large: {url}")
    etag = response.headers.get("ETag")
    return _FetchedText(text=response.text, etag=etag)


async def _get_llms_index(client: httpx.AsyncClient, source: VendorSource, *, force: bool = False) -> dict[str, str]:
    """llms.txt 索引（长缓存 + 条件请求）；返回 model_id → OpenAPI URL。"""
    now = utc_now()
    cached = _INDEX_CACHE.get(source.key)
    if not force and cached is not None and now - cached[0] < _INDEX_TTL:
        return parse_llms_index(cached[1], base_url=_site_root(source))
    lock = _INDEX_LOCKS.setdefault(source.key, asyncio.Lock())
    async with lock:
        cached = _INDEX_CACHE.get(source.key)
        if not force and cached is not None and utc_now() - cached[0] < _INDEX_TTL:
            return parse_llms_index(cached[1], base_url=_site_root(source))
        fetched = await _fetch_text(client, source.llms_txt, etag=cached[2] if cached else None)
        if fetched.text is None:
            # 304：索引未变化，仅续期
            _INDEX_CACHE[source.key] = (now, cached[1] if cached else "", fetched.etag)
        else:
            _INDEX_CACHE[source.key] = (now, fetched.text, fetched.etag)
        text = _INDEX_CACHE[source.key][1]
        return parse_llms_index(text, base_url=_site_root(source))


async def sync_model_capabilities(
    session: AsyncSession,
    provider: CustomProvider,
    model: CustomProviderModel,
    *,
    client: httpx.AsyncClient | None = None,
    index: dict[str, str] | None = None,
) -> str:
    """同步单个模型的能力声明并落库；返回状态常量。不抛网络/解析异常。"""
    if endpoint_to_media_type(model.endpoint) != "video":
        return STATUS_NON_VIDEO
    source = match_vendor_source(provider.base_url)
    if source is None:
        return STATUS_NO_SOURCE
    http = client if client is not None else get_http_client()
    try:
        mapping = index if index is not None else await _get_llms_index(http, source)
        spec_url = mapping.get(model.model_id)
        if spec_url is None:
            return STATUS_NOT_FOUND
        previous = model.vendor_capabilities if isinstance(model.vendor_capabilities, dict) else None
        previous_etag = previous.get("etag") if isinstance(previous, dict) else None
        # 解析器版本升级后，旧 ETag 的 304 会跳过重解析、拿不到新规则的结果——此时绕过条件
        # 请求强制重拉，落库声明随之带上新 parser_version。
        parser_outdated = not isinstance(previous, dict) or previous.get("parser_version") != source.parser_version
        fetched = await _fetch_text(
            http,
            spec_url,
            etag=previous_etag if isinstance(previous_etag, str) and not parser_outdated else None,
        )
        if fetched.text is None:
            model.vendor_capabilities_synced_at = utc_now()
            return STATUS_UNCHANGED
        spec = yaml.safe_load(fetched.text)
        declared = parse_video_capabilities(spec) if isinstance(spec, dict) else {}
        if not declared:
            model.vendor_capabilities = None
            model.vendor_capabilities_synced_at = utc_now()
            return STATUS_NO_DATA
        model.vendor_capabilities = {
            "capabilities": declared,
            "source_urls": [spec_url],
            "parser_version": source.parser_version,
            "etag": fetched.etag,
        }
        model.vendor_capabilities_synced_at = utc_now()
        return STATUS_SYNCED
    except Exception:
        logger.warning("能力文档同步失败 provider=%s model=%s", provider.id, model.model_id, exc_info=True)
        return STATUS_FETCH_FAILED


async def sync_provider_capabilities(
    session_factory: async_sessionmaker[AsyncSession],
    provider_db_id: int,
    *,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, str]]:
    """同步一家供应商下全部启用视频模型；返回逐模型结果。"""
    async with session_factory() as session:
        repo = CustomProviderRepository(session)
        provider = await repo.get_provider(provider_db_id)
        if provider is None:
            return []
        result = await session.execute(
            select(CustomProviderModel).where(CustomProviderModel.provider_id == provider_db_id)
        )
        models = list(result.scalars())
        outcomes: list[dict[str, str]] = []
        for model in models:
            if not model.is_enabled:
                continue
            status = await sync_model_capabilities(session, provider, model, client=client)
            outcomes.append({"model_id": model.model_id, "status": status})
        await session.commit()
        return outcomes


def schedule_provider_capability_sync(provider_db_id: int, session_factory: async_sessionmaker[AsyncSession]) -> None:
    """保存后触发异步同步（fire-and-forget）；失败只记日志，不影响保存结果。

    持有强引用防任务被 GC；测试可 monkeypatch 本函数或注入内存 session_factory。
    """

    async def _run() -> None:
        try:
            await sync_provider_capabilities(session_factory, provider_db_id)
        except Exception:
            logger.warning("能力同步任务失败 provider=%s", provider_db_id, exc_info=True)

    task = asyncio.get_running_loop().create_task(_run())
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()
