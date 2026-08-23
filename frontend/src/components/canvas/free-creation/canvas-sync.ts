import type {
  FreeCreationCanvasAppliedPatch,
  FreeCreationCanvasPatch,
} from "@/types";

export interface CanvasPointValue {
  x: number;
  y: number;
}

export interface CanvasGroupValue {
  group_id: string;
  member_ids: string[];
}

export interface CanvasSharedState {
  positions: Record<string, CanvasPointValue>;
  hiddenCreationIds: string[];
  hiddenReferenceIds: string[];
  groups: CanvasGroupValue[];
  showRelations: boolean;
}

interface CanvasPatchContext {
  patchId: string;
  baseRevision: number;
  nodeRevisions: Record<string, number>;
}

function samePoint(left: CanvasPointValue | undefined, right: CanvasPointValue | undefined): boolean {
  return left?.x === right?.x && left?.y === right?.y;
}

function groupMap(groups: readonly CanvasGroupValue[]): Map<string, CanvasGroupValue> {
  return new Map(groups.map((group) => [group.group_id, group]));
}

function sameGroup(left: CanvasGroupValue | undefined, right: CanvasGroupValue | undefined): boolean {
  return left?.group_id === right?.group_id
    && JSON.stringify(left?.member_ids ?? []) === JSON.stringify(right?.member_ids ?? []);
}

export function buildCanvasPatch(
  before: CanvasSharedState,
  after: CanvasSharedState,
  context: CanvasPatchContext,
): FreeCreationCanvasPatch | null {
  const positionUpdates = Object.fromEntries(
    Object.entries(after.positions).filter(([id, point]) => !samePoint(before.positions[id], point)),
  );
  const beforeHiddenCreations = new Set(before.hiddenCreationIds);
  const afterHiddenCreations = new Set(after.hiddenCreationIds);
  const hiddenCreationUpdates = Object.fromEntries(
    [...new Set([...beforeHiddenCreations, ...afterHiddenCreations])]
      .filter((id) => beforeHiddenCreations.has(id) !== afterHiddenCreations.has(id))
      .map((id) => [id, afterHiddenCreations.has(id)]),
  );
  const beforeHiddenReferences = new Set(before.hiddenReferenceIds);
  const afterHiddenReferences = new Set(after.hiddenReferenceIds);
  const hiddenReferenceUpdates = Object.fromEntries(
    [...new Set([...beforeHiddenReferences, ...afterHiddenReferences])]
      .filter((id) => beforeHiddenReferences.has(id) !== afterHiddenReferences.has(id))
      .map((id) => [id, afterHiddenReferences.has(id)]),
  );
  const beforeGroups = groupMap(before.groups);
  const afterGroups = groupMap(after.groups);
  const groupUpserts = [...afterGroups.values()].filter(
    (group) => !sameGroup(beforeGroups.get(group.group_id), group),
  );
  const groupDeletes = [...beforeGroups.keys()].filter((id) => !afterGroups.has(id));
  const relationChanged = before.showRelations !== after.showRelations;
  const targets = new Set([
    ...Object.keys(positionUpdates),
    ...Object.keys(hiddenCreationUpdates),
    ...Object.keys(hiddenReferenceUpdates),
    ...groupUpserts.map((group) => group.group_id),
    ...groupDeletes,
    ...(relationChanged ? ["canvas:relations"] : []),
  ]);
  if (!targets.size) return null;

  return {
    patch_id: context.patchId,
    base_revision: context.baseRevision,
    target_revisions: Object.fromEntries([...targets].map((id) => [id, context.nodeRevisions[id] ?? 0])),
    ...(Object.keys(positionUpdates).length ? { position_updates: positionUpdates } : {}),
    ...(Object.keys(hiddenCreationUpdates).length ? { hidden_creation_updates: hiddenCreationUpdates } : {}),
    ...(Object.keys(hiddenReferenceUpdates).length ? { hidden_reference_updates: hiddenReferenceUpdates } : {}),
    ...(groupUpserts.length ? { group_upserts: groupUpserts } : {}),
    ...(groupDeletes.length ? { group_deletes: groupDeletes } : {}),
    ...(relationChanged ? { show_relations: after.showRelations } : {}),
  };
}

function applyVisibility(current: string[], updates: Record<string, boolean> | undefined): string[] {
  if (!updates) return current;
  const next = new Set(current);
  for (const [id, hidden] of Object.entries(updates)) {
    if (hidden) next.add(id);
    else next.delete(id);
  }
  return [...next].sort();
}

export function applyCanvasPatch(
  current: CanvasSharedState,
  patch: FreeCreationCanvasAppliedPatch,
): CanvasSharedState {
  const changes = patch.changes;
  const groups = groupMap(current.groups);
  for (const groupId of changes.group_deletes ?? []) groups.delete(groupId);
  for (const group of changes.group_upserts ?? []) groups.set(group.group_id, group);
  return {
    positions: { ...current.positions, ...(changes.position_updates ?? {}) },
    hiddenCreationIds: applyVisibility(current.hiddenCreationIds, changes.hidden_creation_updates),
    hiddenReferenceIds: applyVisibility(current.hiddenReferenceIds, changes.hidden_reference_updates),
    groups: [...groups.values()],
    showRelations: changes.show_relations ?? current.showRelations,
  };
}

export function canvasPatchTargets(patch: FreeCreationCanvasAppliedPatch): string[] {
  const changes = patch.changes;
  return [...new Set([
    ...Object.keys(changes.position_updates ?? {}),
    ...Object.keys(changes.hidden_creation_updates ?? {}),
    ...Object.keys(changes.hidden_reference_updates ?? {}),
    ...(changes.group_upserts ?? []).map((group) => group.group_id),
    ...(changes.group_deletes ?? []),
    ...(changes.show_relations === undefined ? [] : ["canvas:relations"]),
  ])];
}

function copyTarget(target: string, source: CanvasSharedState, destination: CanvasSharedState): void {
  if (target === "canvas:relations") {
    destination.showRelations = source.showRelations;
    return;
  }
  if (target.startsWith("g_")) {
    const sourceGroup = source.groups.find((group) => group.group_id === target);
    destination.groups = destination.groups.filter((group) => group.group_id !== target);
    if (sourceGroup) destination.groups.push(sourceGroup);
    return;
  }
  if (target.startsWith("c_")) {
    if (source.positions[target]) destination.positions[target] = source.positions[target];
    const hidden = new Set(destination.hiddenCreationIds);
    if (source.hiddenCreationIds.includes(target)) hidden.add(target);
    else hidden.delete(target);
    destination.hiddenCreationIds = [...hidden].sort();
    return;
  }
  if (target.startsWith("r_")) {
    if (source.positions[target]) destination.positions[target] = source.positions[target];
    const hidden = new Set(destination.hiddenReferenceIds);
    if (source.hiddenReferenceIds.includes(target)) hidden.add(target);
    else hidden.delete(target);
    destination.hiddenReferenceIds = [...hidden].sort();
  }
}

export function rebaseCanvasState(
  remote: CanvasSharedState,
  desired: CanvasSharedState,
  attemptedPatch: FreeCreationCanvasPatch,
  remoteNodeRevisions: Record<string, number>,
): { state: CanvasSharedState; conflictIds: string[] } {
  const state: CanvasSharedState = {
    positions: { ...remote.positions },
    hiddenCreationIds: [...remote.hiddenCreationIds],
    hiddenReferenceIds: [...remote.hiddenReferenceIds],
    groups: remote.groups.map((group) => ({ ...group, member_ids: [...group.member_ids] })),
    showRelations: remote.showRelations,
  };
  const conflictIds: string[] = [];
  for (const target of Object.keys(attemptedPatch.target_revisions)) {
    if ((remoteNodeRevisions[target] ?? 0) !== attemptedPatch.target_revisions[target]) {
      conflictIds.push(target);
      continue;
    }
    copyTarget(target, desired, state);
  }
  return { state, conflictIds: conflictIds.sort() };
}
