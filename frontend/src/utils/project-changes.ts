import i18n from "@/i18n";
import type { ProjectChange } from "@/types";

const GROUP_NAME_LIMIT = 5;

/**
 * 通知文案统一走 dashboard 命名空间的 `notify_*` 词条。
 *
 * 这些函数在 SSE 回调/hook 里被调用，拿不到 React 的 `t`，因此直接用 i18n 单例；
 * 语言切换后下一条通知即为新语言（已弹出的历史通知保持原文，不做回溯重译）。
 */
function notify(key: string, options?: Record<string, unknown>): string {
  return String(i18n.t(`dashboard:${key}`, options));
}

// 生成事件（用于刷新费用等）。
export const GENERATION_ACTIONS: ReadonlySet<ProjectChange["action"]> = new Set([
  "storyboard_ready",
  "video_ready",
  "grid_ready",
  "reference_video_ready",
  "tts_ready",
  "voice_sample_ready",
]);

// 完成事件（action 本身即通知类别，与 entity_type 无关）——优先级查表、导航行为、通知文案均不按
// entity_type 拆分，五类骨架/任务共用同一套判定。
export const COMPLETION_ACTIONS: ReadonlySet<ProjectChange["action"]> = GENERATION_ACTIONS;

// 任务终态是刷新信号（important=false），不进通知文案；`task` 只为满足映射完整性。
const ENTITY_LABEL_KEYS: Record<ProjectChange["entity_type"], string> = {
  project: "notify_entity_project",
  character: "notify_entity_character",
  scene: "notify_entity_scene",
  prop: "notify_entity_prop",
  segment: "notify_entity_segment",
  drama_scene: "notify_entity_scene",
  shot: "notify_entity_shot",
  reference_unit: "notify_entity_reference_unit",
  episode: "notify_entity_episode",
  overview: "notify_entity_overview",
  draft: "notify_entity_draft",
  grid: "notify_entity_grid",
  free_creation: "notify_entity_free_creation",
  free_creation_canvas: "notify_entity_free_creation_canvas",
  task: "notify_entity_task",
};

export interface GroupedProjectChange {
  key: string;
  entityType: ProjectChange["entity_type"];
  action: ProjectChange["action"];
  changes: ProjectChange[];
}

export function buildEntityRevisionKey(
  entityType: ProjectChange["entity_type"],
  entityId: string,
): string {
  return `${entityType}:${entityId}`;
}

export function groupChangesByType(
  changes: ProjectChange[],
): GroupedProjectChange[] {
  const groups = new Map<string, GroupedProjectChange>();

  for (const change of changes) {
    const key = `${change.entity_type}:${change.action}`;
    const existing = groups.get(key);
    if (existing) {
      existing.changes.push(change);
      continue;
    }
    groups.set(key, {
      key,
      entityType: change.entity_type,
      action: change.action,
      changes: [change],
    });
  }

  return [...groups.values()];
}

function getEntityLabel(group: GroupedProjectChange): string {
  if (group.action === "storyboard_ready") {
    return notify("notify_subject_storyboard");
  }
  if (group.action === "video_ready") {
    return notify("notify_subject_video");
  }
  if (group.action === "grid_ready" || group.action === "grid_split_done") {
    return notify("notify_subject_grid");
  }
  if (group.action === "tts_ready") {
    return notify("notify_subject_tts");
  }
  if (group.action === "voice_sample_ready") {
    return notify("notify_subject_voice_sample");
  }
  const key = ENTITY_LABEL_KEYS[group.entityType];
  return key ? notify(key) : notify("notify_subject_fallback");
}

function getChangeListLabel(change: ProjectChange): string {
  if (
    change.entity_type === "character" ||
    change.entity_type === "scene" ||
    change.entity_type === "prop" ||
    change.entity_type === "segment" ||
    change.entity_type === "drama_scene" ||
    change.entity_type === "shot" ||
    change.entity_type === "reference_unit"
  ) {
    return change.entity_id;
  }
  return change.label;
}

function summarizeGroupNames(group: GroupedProjectChange): string {
  const names = group.changes.slice(0, GROUP_NAME_LIMIT).map(getChangeListLabel);
  const suffix = group.changes.length > GROUP_NAME_LIMIT ? notify("notify_summary_more") : "";
  return `${names.join(notify("notify_list_separator"))}${suffix}`;
}

function formatSingleNotificationText(change: ProjectChange): string {
  const label = change.label;
  if (change.action === "storyboard_ready") {
    return notify("notify_storyboard_ready", { label });
  }
  if (change.action === "video_ready") {
    return notify("notify_video_ready", { label });
  }
  if (
    change.action === "grid_ready" ||
    change.action === "reference_video_ready" ||
    change.action === "tts_ready" ||
    change.action === "voice_sample_ready"
  ) {
    return notify("notify_generated", { label });
  }
  if (change.action === "grid_split_done") {
    return notify("notify_split_done", { label });
  }
  if (change.action === "created") {
    return notify("notify_created", { label });
  }
  if (change.action === "deleted") {
    return notify("notify_deleted", { label });
  }
  return notify("notify_updated", { label });
}

function formatSingleDeferredText(change: ProjectChange): string {
  const label = change.label;
  if (change.action === "storyboard_ready") {
    return notify("notify_deferred_storyboard", { label });
  }
  if (change.action === "video_ready") {
    return notify("notify_deferred_video", { label });
  }
  if (
    change.action === "grid_ready" ||
    change.action === "reference_video_ready" ||
    change.action === "tts_ready" ||
    change.action === "voice_sample_ready"
  ) {
    return notify("notify_deferred_generated", { label });
  }
  if (change.action === "grid_split_done") {
    return notify("notify_deferred_split_done", { label });
  }
  if (change.action === "created") {
    return notify("notify_deferred_created", { label });
  }
  if (change.action === "deleted") {
    return notify("notify_deferred_deleted", { label });
  }
  return notify("notify_deferred_updated", { label });
}

export function formatGroupedNotificationText(
  group: GroupedProjectChange,
): string {
  if (group.changes.length === 1) {
    return formatSingleNotificationText(group.changes[0]);
  }

  const count = group.changes.length;
  const entityLabel = getEntityLabel(group);
  const summary = summarizeGroupNames(group);

  const params = { count, entity: entityLabel, summary };
  if (COMPLETION_ACTIONS.has(group.action)) {
    return notify("notify_group_generated", params);
  }
  if (group.action === "created") {
    return notify("notify_group_created", params);
  }
  if (group.action === "deleted") {
    return notify("notify_group_deleted", params);
  }
  return notify("notify_group_updated", params);
}

export function formatGroupedDeferredText(
  group: GroupedProjectChange,
): string {
  if (group.changes.length === 1) {
    return formatSingleDeferredText(group.changes[0]);
  }

  const count = group.changes.length;
  const entityLabel = getEntityLabel(group);
  const summary = summarizeGroupNames(group);

  const params = { count, entity: entityLabel, summary };
  if (COMPLETION_ACTIONS.has(group.action)) {
    return notify("notify_group_deferred_generated", params);
  }
  if (group.action === "created") {
    return notify("notify_group_deferred_created", params);
  }
  if (group.action === "deleted") {
    return notify("notify_group_deferred_deleted", params);
  }
  return notify("notify_group_deferred_updated", params);
}
