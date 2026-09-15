"""内置供应商能力源注册表。

自定义供应商的 base_url 域名命中此处即启用「能力文档同步」：从该供应商的 llms.txt 索引建立
model_id → OpenAPI 契约的映射，供 capability_sync 管线按需拉取解析。每接一家新中转只需在此
加一条配置（这类文档站布局高度一致），用户无需填写任何文档地址。

仅当站方明确欢迎程序化读取时才登记（llms.txt 约定 / robots 内容信号）。
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class VendorSource:
    """一家中转的能力文档源。"""

    key: str
    display_name: str
    hosts: tuple[str, ...]  # base_url 域名按后缀匹配（含子域）
    llms_txt: str  # 文档索引入口，管线由此建立 model_id → OpenAPI URL 映射
    parser_version: int  # OpenAPI 解析器版本；声明落库时随行，规则变更时递增


VENDOR_SOURCES: dict[str, VendorSource] = {
    "anyfast": VendorSource(
        key="anyfast",
        display_name="AnyFast",
        hosts=("anyfast.ai",),
        llms_txt="https://docs.anyfast.ai/llms.txt",
        parser_version=1,
    ),
}


def match_vendor_source(base_url: str | None) -> VendorSource | None:
    """按供应商 base_url 的域名后缀匹配能力源；未命中返回 None（不启用同步）。"""
    if not base_url or not base_url.strip():
        return None
    raw = base_url.strip()
    try:
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
    except ValueError:
        return None
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if not hostname:
        return None
    for source in VENDOR_SOURCES.values():
        if any(hostname == host or hostname.endswith(f".{host}") for host in source.hosts):
            return source
    return None
