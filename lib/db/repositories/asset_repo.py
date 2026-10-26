"""AssetRepository: 异步 CRUD。"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ColumnElement, select

from lib.db.like import LIKE_ESCAPE_CHAR, contains_pattern
from lib.db.models.asset import Asset
from lib.db.repositories.base import BaseRepository


class AssetRepository(BaseRepository):
    async def create(
        self,
        *,
        type: str,
        name: str,
        description: str = "",
        voice_style: str = "",
        image_path: str | None = None,
        audio_path: str | None = None,
        source_project: str | None = None,
        source_project_id: str | None = None,
        owner_user_id: str | None = None,
        visibility: str | None = None,
    ) -> Asset:
        asset = Asset(
            id=str(uuid.uuid4()),
            type=type,
            name=name,
            description=description,
            voice_style=voice_style,
            image_path=image_path,
            audio_path=audio_path,
            source_project=source_project,
            source_project_id=source_project_id,
            owner_user_id=owner_user_id,
        )
        if visibility is not None:
            asset.visibility = visibility
        self.session.add(asset)
        await self.session.flush()
        return asset

    async def get_by_id(self, asset_id: str) -> Asset | None:
        return (await self.session.execute(select(Asset).where(Asset.id == asset_id))).scalar_one_or_none()

    async def get_by_type_name(self, type: str, name: str) -> Asset | None:
        return (
            await self.session.execute(select(Asset).where(Asset.type == type, Asset.name == name))
        ).scalar_one_or_none()

    async def get_by_ids(
        self,
        asset_ids: list[str],
        *,
        visible_to: ColumnElement[bool] | None = None,
    ) -> list[Asset]:
        """按 id 批量取；``visible_to`` 为调用方传入的可见性谓词（下推到 SQL）。"""

        if not asset_ids:
            return []
        stmt = select(Asset).where(Asset.id.in_(asset_ids))
        if visible_to is not None:
            stmt = stmt.where(visible_to)
        return list((await self.session.execute(stmt)).scalars())

    async def get_visible_by_id(
        self,
        asset_id: str,
        *,
        visible_to: ColumnElement[bool] | None = None,
    ) -> Asset | None:
        stmt = select(Asset).where(Asset.id == asset_id)
        if visible_to is not None:
            stmt = stmt.where(visible_to)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_by_path(
        self,
        relative_path: str,
        *,
        visible_to: ColumnElement[bool] | None = None,
    ) -> Asset | None:
        """按图片/音频相对路径反查资产，供全局素材文件直链做可见性校验。"""

        stmt = select(Asset).where((Asset.image_path == relative_path) | (Asset.audio_path == relative_path))
        if visible_to is not None:
            stmt = stmt.where(visible_to)
        return (await self.session.execute(stmt)).scalars().first()

    async def list(
        self,
        *,
        type: str | None,
        q: str | None,
        limit: int = 100,
        offset: int = 0,
        visible_to: ColumnElement[bool] | None = None,
    ) -> list[Asset]:
        stmt = select(Asset)
        if visible_to is not None:
            stmt = stmt.where(visible_to)
        if type:
            stmt = stmt.where(Asset.type == type)
        if q:
            stmt = stmt.where(Asset.name.ilike(contains_pattern(q), escape=LIKE_ESCAPE_CHAR))
        stmt = stmt.order_by(Asset.updated_at.desc()).limit(limit).offset(offset)
        return list((await self.session.execute(stmt)).scalars())

    async def update(self, asset_id: str, **fields: Any) -> Asset:
        asset = await self.get_by_id(asset_id)
        if asset is None:
            raise ValueError(f"Asset not found: {asset_id}")
        for k, v in fields.items():
            setattr(asset, k, v)
        await self.session.flush()
        return asset

    async def delete(self, asset_id: str) -> None:
        asset = await self.get_by_id(asset_id)
        if asset:
            await self.session.delete(asset)
            await self.session.flush()

    async def exists(self, type: str, name: str) -> bool:
        return await self.get_by_type_name(type, name) is not None
