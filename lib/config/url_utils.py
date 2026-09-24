"""URL 归一化工具函数。"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
from urllib.parse import urlparse

# 官方 OpenAI 端点：既是 is_official_openai_base_url 的判定基准，也是上层
# 客户端工厂在 base_url 为空时须显式回填的默认值——AsyncOpenAI 对空 base_url
# 会回落读取 OPENAI_BASE_URL 环境变量，显式传入官方值即断掉该回落。单一来源，
# 勿散落字面量。
OFFICIAL_OPENAI_HOSTNAME = "api.openai.com"
OFFICIAL_OPENAI_BASE_URL = f"https://{OFFICIAL_OPENAI_HOSTNAME}/v1"


def is_official_openai_base_url(base_url: str | None) -> bool:
    """判断 OpenAI 兼容 base_url 是否指向官方 api.openai.com。

    官方端点上 max_tokens 已弃用且被推理模型（o 系列 / gpt-5 等）拒绝，
    应改用 max_completion_tokens；第三方兼容端点（vLLM、各类中转）对新
    参数支持情况不一，须保守沿用 max_tokens。

    base_url 只来自 DB 配置（唯一来源），为空（None/空白串）时判定为官方端点。

    已知限制：指向中转/代理的 base_url 一律判非官方，若中转将 max_tokens
    原样转发给官方推理模型仍会被拒（显式 400，报错信息自描述）。
    """
    effective = (base_url or "").strip()
    if not effective:
        return True
    # hostname 自带小写化与去端口；无 scheme 时 hostname 为 None → 保守判非官方
    return urlparse(effective).hostname == OFFICIAL_OPENAI_HOSTNAME


def ensure_openai_base_url(url: str | None) -> str | None:
    """自动补全 OpenAI 兼容 API 的 /v1 路径后缀。

    用户可能只填了 ``https://api.example.com``，但 OpenAI SDK 期望
    ``https://api.example.com/v1``。本函数在缺少版本路径时自动追加。
    """
    if not url:
        return url
    stripped = url.strip().rstrip("/")
    if not re.search(r"/v\d+$", stripped):
        stripped += "/v1"
    return stripped


def normalize_base_url(url: str | None) -> str | None:
    """确保 base_url 以 / 结尾。

    Google genai SDK 的 http_options.base_url 要求尾部带 /，
    否则请求路径拼接会失败。预置 Gemini 后端使用此函数。
    """
    if not url:
        return None
    url = url.strip()
    if not url:
        return None
    if not url.endswith("/"):
        url += "/"
    return url


def ensure_google_base_url(url: str | None) -> str | None:
    """规范化 Google genai SDK 的 base_url。

    Google genai SDK 会自动在 base_url 后拼接 ``api_version``（默认 ``v1beta``）。
    如果用户误填了 ``https://example.com/v1beta``，SDK 会拼出
    ``https://example.com/v1beta/v1beta/models``，导致请求失败。

    本函数剥离末尾的版本路径（如 ``/v1beta``、``/v1``），并确保尾部带 ``/``。
    """
    if not url:
        return None
    url = url.strip()
    if not url:
        return None
    url = url.rstrip("/")
    # 剥离末尾的版本路径（/v1, /v1beta, /v1alpha 等）
    # 用 [a-zA-Z] 代替 \w：\d+\w* 的重叠会触发 CodeQL polynomial regex 警告
    url = re.sub(r"/v\d+[a-zA-Z]*$", "", url)
    if not url.endswith("/"):
        url += "/"
    return url


def ensure_anthropic_base_url(url: str | None) -> str | None:
    """规范化 Anthropic base_url。

    @anthropic-ai/sdk 内部会拼接 /v1/messages、/v1/models 等，所以
    base_url 必须是根级形态。如用户填了 https://example.com/v1 或
    /v1beta、/v1/messages 等带版本前缀的形式，需要剥掉，否则会拼出
    /v1/v1/messages 报 404。
    """
    if not url:
        return None
    s = url.strip().rstrip("/")
    if not s:
        return None
    # [a-zA-Z]* 兼容 /v1beta /v2alpha 等带后缀的版本号
    # 用 [a-zA-Z] 代替 \w：\d+\w* 的重叠会触发 CodeQL polynomial regex 警告
    s = re.sub(r"/v\d+[a-zA-Z]*(?:/messages)?$", "", s)
    s = re.sub(r"/messages$", "", s)
    return s


def _allow_private_provider_endpoints() -> bool:
    return os.environ.get("ALLOW_PRIVATE_PROVIDER_ENDPOINTS", "").strip().lower() in {"1", "true", "yes", "on"}


def validate_provider_base_url(url: str) -> str:
    """校验自定义供应商 base_url，拒绝 SSRF 高危目标。

    拒绝 link-local / metadata / 未明确放行的回环与私网。自托管 vLLM 等内网端点
    可通过 ``ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true`` 显式放行。主机名解析失败时
    放行（无法证明为内网；后续 discover/test 仍会连通失败），只对「已解析出的
    高危地址」与 IP 字面量 fail-closed。
    """
    raw = (url or "").strip()
    if not raw:
        raise ValueError("base_url is required")
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("base_url must be http(s)")
    host = parsed.hostname
    if not host:
        raise ValueError("base_url host is required")
    if host.lower() in {"metadata.google.internal", "metadata", "instance-data"}:
        raise ValueError("base_url points at cloud metadata")
    allow_private = _allow_private_provider_endpoints()

    def _check_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
        if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            raise ValueError("base_url resolves to a link-local or invalid address")
        if not allow_private and (ip.is_loopback or ip.is_private):
            raise ValueError(
                "base_url resolves to a private/loopback address; set ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true to allow"
            )

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        _check_ip(literal)
        return raw

    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except OSError:
        return raw
    for info in infos:
        try:
            resolved = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        _check_ip(resolved)
    return raw
