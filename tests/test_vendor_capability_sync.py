"""供应商文档能力同步管线（capability_sync）的解析、合并与 API 面测试。

覆盖：llms.txt 索引解析、OpenAPI 能力提取（归一化规则）、声明与用户覆盖的键级合并、
API 回显与手动同步端点、整体替换语义下的声明结转。HTTP 层以注入/monkeypatch 隔离，不触网。
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from lib.config.resolver import ConfigResolver
from lib.config.service import ConfigService
from lib.custom_provider import make_provider_id
from lib.custom_provider.capability_sync import (
    STATUS_NOT_FOUND,
    parse_llms_index,
    parse_video_capabilities,
)
from lib.custom_provider.vendor_sources import match_vendor_source
from lib.db import get_async_session
from lib.db.base import Base
from lib.db.models.custom_provider import CustomProviderModel
from lib.db.repositories.custom_provider_repo import CustomProviderRepository
from server.auth import CurrentUserInfo, get_current_user
from server.error_handlers import register_error_handlers
from server.routers import custom_providers
from tests.auth_deps import AUTH_DEPENDENCIES

VIDEO_ENDPOINT = "openai-video"
VIDEO_MODEL = "sora-2"


@pytest.fixture()
async def db_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest.fixture()
async def session_factory(db_engine):
    return async_sessionmaker(db_engine, expire_on_commit=False)


@pytest.fixture()
def app(session_factory) -> FastAPI:
    _app = FastAPI()

    async def _override_session():
        async with session_factory() as session:
            yield session

    _app.dependency_overrides[get_async_session] = _override_session
    _app.dependency_overrides[get_current_user] = lambda: CurrentUserInfo(id="test", sub="test", role="admin")
    _app.include_router(custom_providers.router, prefix="/api/v1", dependencies=AUTH_DEPENDENCIES)
    register_error_handlers(_app)
    return _app


@pytest.fixture()
def client(app) -> TestClient:
    with TestClient(app) as c:
        yield c


@pytest.mark.unit
class TestParseLlmsIndex:
    def test_extracts_model_slug_urls(self):
        text = (
            "- [wan3.0-video](/api-reference/model-api/alibaba/openapi/wan3.0-video/openapi.yaml)\n"
            "- [kling-v3-i2v](/api-reference/model-api/kuaishou/openapi/kling-v3-i2v/openapi.yaml)\n"
            "- [无关页面](/guides/usecases/xxx.md)\n"
        )
        index = parse_llms_index(text, base_url="https://docs.anyfast.ai")
        assert set(index) == {"wan3.0-video", "kling-v3-i2v"}
        assert index["wan3.0-video"].endswith("alibaba/openapi/wan3.0-video/openapi.yaml")

    def test_zh_mirror_dedupes_to_english(self):
        text = (
            "- [中文](/zh/api-reference/model-api/alibaba/openapi/wan3.0-video/openapi.yaml)\n"
            "- [english](/api-reference/model-api/alibaba/openapi/wan3.0-video/openapi.yaml)\n"
        )
        index = parse_llms_index(text, base_url="https://docs.anyfast.ai")
        assert index["wan3.0-video"] == (
            "https://docs.anyfast.ai/api-reference/model-api/alibaba/openapi/wan3.0-video/openapi.yaml"
        )


@pytest.mark.unit
class TestParseVideoCapabilities:
    """以 AnyFast wan3.0-video 的真实契约形态（统一 VideoGenerationRequest）为样本。"""

    SPEC: dict = {
        "openapi": "3.0.0",
        "paths": {
            "/v1/video/generations": {
                "post": {
                    "requestBody": {
                        "content": {
                            "application/json": {"schema": {"$ref": "#/components/schemas/VideoGenerationRequest"}}
                        }
                    }
                }
            }
        },
        "components": {
            "schemas": {
                "VideoGenerationRequest": {
                    "properties": {
                        "model": {"type": "string", "enum": ["wan3.0-video", "wan3.0-video-nsfw"]},
                        "input": {"$ref": "#/components/schemas/VideoInput"},
                        "parameters": {"$ref": "#/components/schemas/VideoParameters"},
                    }
                },
                "VideoInput": {
                    "properties": {
                        "prompt": {"type": "string", "maxLength": 5000},
                        "media": {
                            "type": "array",
                            "items": {
                                "properties": {
                                    "type": {
                                        "type": "string",
                                        "enum": [
                                            "first_frame",
                                            "last_frame",
                                            "reference_image",
                                            "reference_video",
                                            "reference_audio",
                                            "file",
                                            "link",
                                        ],
                                    },
                                    "url": {"type": "string"},
                                }
                            },
                        },
                    }
                },
                "VideoParameters": {
                    "properties": {
                        "resolution": {"type": "string", "enum": ["1080P", "720P", "480P"]},
                        "ratio": {
                            "type": "string",
                            "enum": ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"],
                        },
                        "duration": {
                            "type": "integer",
                            "description": (
                                "Output duration in seconds. Use -1 for smart duration. "
                                "Without video input, use an integer from 2 through 30."
                            ),
                        },
                    }
                },
            }
        },
    }

    def test_extracts_normalized_sparse_declaration(self):
        caps = parse_video_capabilities(self.SPEC)
        assert caps["supported_resolutions"] == ["1080p", "720p", "480p"]  # 大小写归一
        assert caps["supported_aspect_ratios"] == ["16:9", "4:3", "1:1", "3:4", "9:16"]  # adaptive 剔出
        assert caps["supported_durations"] == list(range(2, 31))  # 范围解析，-1/smart 不进档位
        assert caps["first_frame"] is True
        assert caps["last_frame"] is True
        assert caps["first_frame_ratio_adaptive_only"] is True
        assert caps["max_prompt_chars"] == 5000

    def test_duration_enum_drops_non_positive(self):
        spec = {
            "components": {
                "schemas": {"P": {"properties": {"duration_seconds": {"type": "integer", "enum": [-1, 4, 8, 12]}}}}
            }
        }
        assert parse_video_capabilities(spec)["supported_durations"] == [4, 8, 12]

    def test_sora_size_seconds_shape(self):
        """sora 系用 seconds（字符串枚举）+ size（宽x高）表达参数：派生档位与比例。

        size → 档位派生与 openai 适配器的 _resolve_size 吸附口径一致（短边取最近档），
        保证声明与请求构造同源。
        """
        spec = {
            "components": {
                "schemas": {
                    "P": {
                        "properties": {
                            "seconds": {"type": "string", "enum": ["4", "8", "12"]},
                            "size": {
                                "type": "string",
                                "enum": ["720x1280", "1280x720", "1024x1792", "1792x1024"],
                            },
                        }
                    }
                }
            }
        }
        caps = parse_video_capabilities(spec)
        assert caps["supported_durations"] == [4, 8, 12]
        assert caps["supported_resolutions"] == ["720p", "1080p"]
        assert caps["supported_aspect_ratios"] == ["9:16", "16:9", "4:7", "7:4"]

    def test_size_derivation_yields_to_explicit_resolution(self):
        """显式 resolution 枚举优先，size 派生只补位。"""
        spec = {
            "components": {
                "schemas": {
                    "P": {
                        "properties": {
                            "resolution": {"type": "string", "enum": ["480P", "720P"]},
                            "size": {"type": "string", "enum": ["1280x720"]},
                        }
                    }
                }
            }
        }
        caps = parse_video_capabilities(spec)
        assert caps["supported_resolutions"] == ["480p", "720p"]

    def test_undeclared_fields_absent(self):
        spec = {"components": {"schemas": {"P": {"properties": {"prompt": {"type": "string"}}}}}}
        assert parse_video_capabilities(spec) == {}


@pytest.mark.unit
class TestMatchVendorSource:
    def test_matches_host_with_subdomain(self):
        assert match_vendor_source("https://api.anyfast.ai/v1") is not None
        assert match_vendor_source("https://www.anyfast.ai") is not None

    def test_unlisted_host_returns_none(self):
        assert match_vendor_source("https://relay.test/v1") is None
        assert match_vendor_source(None) is None


@pytest.mark.unit
class TestMergedOverrides:
    def _model_row(self, *, vendor: dict | None, user: dict | None) -> CustomProviderModel:
        return CustomProviderModel(
            provider_id=1,
            model_id=VIDEO_MODEL,
            display_name="Sora 2",
            endpoint=VIDEO_ENDPOINT,
            is_enabled=True,
            vendor_capabilities=(
                {"capabilities": vendor, "source_urls": ["u"], "parser_version": 1} if vendor else None
            ),
            capability_overrides=user,
        )

    def test_user_wins_contested_key_vendor_fills_rest(self):
        row = self._model_row(
            vendor={"supported_resolutions": ["480p", "720p"], "last_frame": True},
            user={"supported_resolutions": ["720p", "1080p"]},
        )
        assert row.vendor_declared_capabilities == {
            "supported_resolutions": ["480p", "720p"],
            "last_frame": True,
        }
        assert row.merged_capability_overrides == {
            "supported_resolutions": ["720p", "1080p"],  # 同键用户胜
            "last_frame": True,  # 用户未声明的键由文档声明补齐
        }

    def test_garbage_and_null_shapes_degrade_to_none(self):
        row = self._model_row(vendor={"supported_resolutions": ["480p"]}, user=None)
        row.vendor_capabilities = "not-a-dict"  # 手工改库的脏形态
        assert row.merged_capability_overrides is None

        row2 = self._model_row(vendor=None, user=None)
        assert row2.merged_capability_overrides is None


@pytest.mark.integration
class TestResolverReflectsVendorDeclaration:
    @pytest.mark.integration
    async def test_declaration_fills_dims_user_override_wins(self, session_factory, db_engine):
        """文档声明补齐端点判定缺席的维度；同键用户覆盖胜出——resolver 读侧与展示层同源。"""
        async with session_factory() as session:
            repo = CustomProviderRepository(session)
            provider = await repo.create_provider(
                display_name="Relay",
                discovery_format="openai",
                base_url="https://relay.test/v1",
                api_key="sk-relay",
                models=[
                    {
                        "model_id": VIDEO_MODEL,
                        "display_name": "Sora 2",
                        "endpoint": VIDEO_ENDPOINT,
                        "is_enabled": True,
                        "is_default": True,
                        "supported_durations": "[5, 10]",
                        "capability_overrides": {"supported_aspect_ratios": ["16:9", "9:16"]},
                    }
                ],
            )
            pid = make_provider_id(provider.id)
            result = await session.execute(
                select(CustomProviderModel).where(CustomProviderModel.model_id == VIDEO_MODEL)
            )
            model = result.scalar_one()
            model.vendor_capabilities = {
                "capabilities": {"supported_resolutions": ["480p", "720p"], "supported_aspect_ratios": ["21:9"]},
                "source_urls": ["u"],
                "parser_version": 1,
            }
            await session.commit()

            factory = async_sessionmaker(bind=session.get_bind(), class_=AsyncSession, expire_on_commit=False)  # type: ignore[call-overload]
            resolver = ConfigResolver(factory, _bound_session=session)
            caps = await resolver._resolve_video_caps_for_model(ConfigService(session), session, pid, VIDEO_MODEL, None)

            # 端点（openai-video）未声明分辨率档位 → 文档声明补齐
            assert caps["supported_resolutions"] == ["480p", "720p"]
            # 同键：用户覆盖胜出，文档声明的 21:9 不落
            assert caps["supported_aspect_ratios"] == ["16:9", "9:16"]
            # 用户与声明都未涉及的维度保持端点判定（时长来自 DB 列兜底）
            assert caps["supported_durations"] == [5, 10]


@pytest.mark.integration
class TestSyncCapabilitiesEndpoint:
    def _create_provider(self, client: TestClient, *, base_url: str = "https://relay.test/v1") -> int:
        return client.post(
            "/api/v1/custom-providers",
            json={
                "display_name": "Relay",
                "discovery_format": "openai",
                "base_url": base_url,
                "api_key": "sk-relay",
                "models": [
                    {"model_id": VIDEO_MODEL, "display_name": "Sora 2", "endpoint": VIDEO_ENDPOINT, "is_enabled": True}
                ],
            },
        ).json()["id"]

    @pytest.mark.integration
    def test_returns_results_and_404_for_missing_provider(self, client: TestClient):
        # anyfast 域名命中内置源，过端点的源校验；sync 本体被 mock，不触网
        pid = self._create_provider(client, base_url="https://api.anyfast.ai/v1")

        with patch.object(
            custom_providers,
            "sync_provider_capabilities",
            new=AsyncMock(return_value=[{"model_id": VIDEO_MODEL, "status": STATUS_NOT_FOUND}]),
        ) as mocked:
            resp = client.post(f"/api/v1/custom-providers/{pid}/sync-capabilities")
        assert resp.status_code == 200
        assert resp.json() == {"results": [{"model_id": VIDEO_MODEL, "status": STATUS_NOT_FOUND}]}
        mocked.assert_awaited_once()

        resp = client.post("/api/v1/custom-providers/99999/sync-capabilities")
        assert resp.status_code == 404

    @pytest.mark.integration
    def test_rejects_provider_outside_builtin_sources(self, client: TestClient):
        pid = self._create_provider(client)
        resp = client.post(f"/api/v1/custom-providers/{pid}/sync-capabilities")
        assert resp.status_code == 400

    @pytest.mark.integration
    def test_declaration_survives_model_list_replace(self, client: TestClient, session_factory):
        """整体替换语义下按 model_id 结转文档声明：用户编辑保存不抹掉机器写入的数据。"""
        pid = self._create_provider(client)

        async def _seed_declaration() -> None:
            async with session_factory() as session:
                result = await session.execute(
                    select(CustomProviderModel).where(CustomProviderModel.model_id == VIDEO_MODEL)
                )
                model = result.scalar_one()
                model.vendor_capabilities = {
                    "capabilities": {"supported_resolutions": ["480p", "720p"]},
                    "source_urls": ["https://docs.example.com/sora-2.yaml"],
                    "parser_version": 1,
                }
                await session.commit()

        import asyncio

        asyncio.run(_seed_declaration())

        models = client.get(f"/api/v1/custom-providers/{pid}").json()["models"]
        assert models[0]["vendor_capabilities"] == {"supported_resolutions": ["480p", "720p"]}

        resp = client.put(
            f"/api/v1/custom-providers/{pid}/models",
            json={
                "models": [
                    {"model_id": VIDEO_MODEL, "display_name": "Sora 2", "endpoint": VIDEO_ENDPOINT, "is_enabled": True}
                ]
            },
        )
        assert resp.status_code == 200
        assert resp.json()[0]["vendor_capabilities"] == {"supported_resolutions": ["480p", "720p"]}
