export type AssetType = "character" | "scene" | "prop";

/** 可见性：shared 进实例级共享池，private 仅创建者与来源项目成员可见。 */
export type AssetVisibility = "private" | "shared";

/** 列表筛选：all 全部可见项，mine 我创建的，shared 共享池。 */
export type AssetScope = "all" | "mine" | "shared";

export interface Asset {
  id: string;
  type: AssetType;
  name: string;
  description: string;
  voice_style: string;
  image_path: string | null;
  audio_path: string | null;
  source_project: string | null;
  source_project_id: string | null;
  owner_user_id: string | null;
  visibility: AssetVisibility;
  owner: { username: string; nickname: string | null; avatar_path: string | null } | null;
  updated_at: string | null;
}

export interface AssetCreatePayload {
  type: AssetType;
  name: string;
  description?: string;
  voice_style?: string;
  visibility?: AssetVisibility;
}

export interface AssetUpdatePayload {
  name?: string;
  description?: string;
  voice_style?: string;
  visibility?: AssetVisibility;
}
