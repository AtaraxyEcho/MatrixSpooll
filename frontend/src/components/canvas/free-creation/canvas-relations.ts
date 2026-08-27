import type {
  FreeCreation,
  FreeCreationReferenceRole,
} from "@/types";

export type CanvasRelationMode = "selected" | "all" | "off";
export type CanvasRelationRole = FreeCreationReferenceRole | "edit_source" | "reference";

export interface CanvasRelation {
  id: string;
  sourceId: string;
  sourceType: "creation" | "upload";
  targetId: string;
  roles: CanvasRelationRole[];
}

interface CanvasRelationQuery {
  mode: CanvasRelationMode;
  selectedIds: ReadonlySet<string>;
  visibleIds: ReadonlySet<string>;
  maxRelations?: number;
}

export interface CanvasRelationQueryResult {
  relations: CanvasRelation[];
  total: number;
  omitted: number;
}

export interface CanvasRelationGraph {
  relations: CanvasRelation[];
  upstream: (nodeId: string) => CanvasRelation[];
  downstream: (nodeId: string) => CanvasRelation[];
  query: (query: CanvasRelationQuery) => CanvasRelationQueryResult;
}

const ROLE_ORDER: CanvasRelationRole[] = [
  "first_frame",
  "last_frame",
  "reference_image",
  "reference_video",
  "reference_audio",
  "prompt_context",
  "edit_source",
  "reference",
];

function roleOrder(role: CanvasRelationRole): number {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

function sortedRelations(relations: Iterable<CanvasRelation>): CanvasRelation[] {
  return [...relations].sort((left, right) => left.id.localeCompare(right.id));
}

export function createCanvasRelationGraph(creations: readonly FreeCreation[]): CanvasRelationGraph {
  const relationsById = new Map<string, CanvasRelation>();
  const addRelation = (
    sourceId: string,
    sourceType: CanvasRelation["sourceType"],
    targetId: string,
    role: CanvasRelationRole,
  ) => {
    if (!sourceId || sourceId === targetId) return;
    const id = `${sourceId}->${targetId}`;
    const existing = relationsById.get(id);
    if (existing) {
      if (!existing.roles.includes(role)) {
        existing.roles.push(role);
        existing.roles.sort((left, right) => roleOrder(left) - roleOrder(right));
      }
      return;
    }
    relationsById.set(id, { id, sourceId, sourceType, targetId, roles: [role] });
  };

  for (const creation of creations) {
    const claimedSourceIds = new Set<string>();
    for (const claim of creation.reference_claims ?? []) {
      const sourceId = claim.type === "creation" ? claim.creation_id : claim.reference_id;
      claimedSourceIds.add(sourceId);
      addRelation(sourceId, claim.type, creation.creation_id, claim.role ?? "reference");
    }
    if (creation.parent_creation_id && !claimedSourceIds.has(creation.parent_creation_id)) {
      addRelation(creation.parent_creation_id, "creation", creation.creation_id, "edit_source");
    }
  }

  const relations = sortedRelations(relationsById.values());
  const upstreamById = new Map<string, CanvasRelation[]>();
  const downstreamById = new Map<string, CanvasRelation[]>();
  for (const relation of relations) {
    const upstream = upstreamById.get(relation.targetId) ?? [];
    upstream.push(relation);
    upstreamById.set(relation.targetId, upstream);
    const downstream = downstreamById.get(relation.sourceId) ?? [];
    downstream.push(relation);
    downstreamById.set(relation.sourceId, downstream);
  }

  return {
    relations,
    upstream: (nodeId) => upstreamById.get(nodeId) ?? [],
    downstream: (nodeId) => downstreamById.get(nodeId) ?? [],
    query: ({ mode, selectedIds, visibleIds, maxRelations = 1_000 }) => {
      if (mode === "off") return { relations: [], total: 0, omitted: 0 };
      const selectedCount = selectedIds.size;
      const candidates = relations.filter((relation) => {
        if (!visibleIds.has(relation.sourceId) || !visibleIds.has(relation.targetId)) return false;
        if (mode === "all") return true;
        if (selectedCount === 0) return false;
        if (selectedCount === 1) {
          return selectedIds.has(relation.sourceId) || selectedIds.has(relation.targetId);
        }
        return selectedIds.has(relation.sourceId) && selectedIds.has(relation.targetId);
      });
      const total = candidates.length;
      return {
        relations: candidates.slice(0, Math.max(0, maxRelations)),
        total,
        omitted: Math.max(0, total - maxRelations),
      };
    },
  };
}
