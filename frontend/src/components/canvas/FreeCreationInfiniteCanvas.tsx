/* eslint-disable jsx-a11y/media-has-caption */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Captions,
  Clapperboard,
  Download,
  Eye,
  EyeOff,
  FileText,
  Group,
  Keyboard,
  LayoutGrid,
  Link2,
  Loader2,
  LocateFixed,
  Maximize2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  ScanSearch,
  Trash2,
  Ungroup,
  UploadCloud,
  ZoomIn,
  ZoomOut,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import type { FreeCreationPreviewTarget } from "@/components/canvas/FreeCreationPreviewDialog";
import { CanvasMinimap } from "@/components/canvas/free-creation/CanvasMinimap";
import {
  CanvasSceneLayer,
  type CanvasRenderNode,
} from "@/components/canvas/free-creation/CanvasSceneLayer";
import {
  CanvasSpatialIndex,
  clampCameraToBounds,
  computeContentBounds,
  fitCameraToBounds,
  selectCanvasLod,
  viewportWorldRect,
  type CanvasLod,
} from "@/components/canvas/free-creation/canvas-engine";
import {
  applyCanvasPatch,
  buildCanvasPatch,
  canvasPatchTargets,
  rebaseCanvasState,
  type CanvasSharedState,
} from "@/components/canvas/free-creation/canvas-sync";
import { CanvasCommandHistory } from "@/components/canvas/free-creation/canvas-history";
import { useAppStore } from "@/stores/app-store";
import { useFreeCreationStore } from "@/stores/free-creation-store";
import type {
  FreeCreation,
  FreeCreationArtifactMediaType,
  FreeCreationReferenceClaim,
  FreeCreationReferenceRole,
  FreeCreationCanvasState,
  FreeSubtitleTrack,
  FreeCreationUpload,
} from "@/types";
import { freeCreationUploadRole } from "@/types";
import { errMsg } from "@/utils/async";

interface Point {
  x: number;
  y: number;
}

interface FreeCreationInfiniteCanvasProps {
  projectName: string;
  creations: FreeCreation[];
  uploads: FreeCreationUpload[];
  subtitleTracks?: FreeSubtitleTrack[];
  readOnly: boolean;
  actingId: string | null;
  onCancel: (creationId: string) => void;
  onRetry: (creationId: string) => void;
  onEdit: (creationId: string) => void;
  onReference: (reference: FreeCreationReferenceClaim, label: string) => void;
  onReferences?: (references: Array<{ claim: FreeCreationReferenceClaim; label: string }>) => void;
  onPreview?: (target: FreeCreationPreviewTarget) => void;
  onEditSubtitle?: (creationId: string) => void;
  onDeleteItems?: (selection: {
    creationIds: readonly string[];
    referenceIds: readonly string[];
  }) => boolean | Promise<boolean>;
  onDeleteCreations?: (creationIds: readonly string[]) => boolean | Promise<boolean>;
  onRestoreCreations?: (creationIds: readonly string[]) => boolean | Promise<boolean>;
  onDeleteUpload?: (referenceId: string) => boolean | Promise<boolean>;
  onRestoreUpload?: (referenceId: string) => boolean | Promise<boolean>;
  onMerge?: (creationIds: string[]) => void;
  onCompositeAudio?: (videoCreationId: string, audioCreationId: string) => void;
  onUploadFiles?: (files: readonly File[]) => Promise<FreeCreationUpload[]>;
}

type PointerOperation =
  | { kind: "pan"; pointerId: number; start: Point; origin: Point }
  | { kind: "marquee"; pointerId: number; start: Point; current: Point; additive: boolean }
  | { kind: "nodes"; pointerId: number; start: Point; origins: Record<string, Point> };

interface ContextMenuState {
  nodeId: string;
  kind: "creation" | "upload";
  x: number;
  y: number;
}

const NODE_WIDTH = 272;
const NODE_HEIGHT = 322;
const UPLOAD_NODE_HEIGHT = 238;
const NODE_GAP_X = 72;
const NODE_GAP_Y = 56;
const MIN_SCALE = 0.05;
const MAX_SCALE = 1.8;
const PLACEMENT_PADDING = 24;
const SUBTITLE_NODE_WIDTH = 236;
const SUBTITLE_NODE_HEIGHT = 166;
const SUBTITLE_NODE_GAP = 32;

interface CanvasBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface CanvasGroup {
  group_id: string;
  member_ids: string[];
}

interface CanvasNodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasDependencyEdge {
  sourceId: string;
  targetId: string;
}

interface CanvasGroupFrame extends CanvasNodeBox {
  groupId: string;
  labelIndex: number;
}

interface CanvasHistoryState {
  positions: Record<string, Point>;
  hiddenCreationIds: string[];
  hiddenUploadIds: string[];
  groups: CanvasGroup[];
  showRelations: boolean;
  deletedCreationIds?: string[];
  deletedReferenceIds?: string[];
}

function creationMediaType(creation: FreeCreation): FreeCreationArtifactMediaType {
  return creation.media_type ?? (creation.output_type === "video" ? "video" : creation.output_type === "audio" ? "audio" : "image");
}

function creationReferenceRole(creation: FreeCreation): FreeCreationReferenceRole {
  const mediaType = creationMediaType(creation);
  return mediaType === "video" ? "reference_video" : mediaType === "audio" ? "reference_audio" : "reference_image";
}

function initialPosition(index: number): Point {
  const column = index % 4;
  const row = Math.floor(index / 4);
  return { x: 96 + column * (NODE_WIDTH + NODE_GAP_X), y: 88 + row * (NODE_HEIGHT + NODE_GAP_Y) };
}

function subtitlePosition(parent: Point, index: number): Point {
  return {
    x: parent.x + NODE_WIDTH + NODE_GAP_X,
    y: parent.y + index * (SUBTITLE_NODE_HEIGHT + SUBTITLE_NODE_GAP),
  };
}

function nodeBox(
  nodeId: string,
  positions: Record<string, Point>,
  uploadsById: ReadonlyMap<string, FreeCreationUpload>,
): CanvasNodeBox | null {
  const position = positions[nodeId];
  if (!position) return null;
  return {
    x: position.x,
    y: position.y,
    width: NODE_WIDTH,
    height: uploadsById.has(nodeId) ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT,
  };
}

export function buildCanvasDependencyEdges(creations: FreeCreation[]): CanvasDependencyEdge[] {
  const edges = new Map<string, CanvasDependencyEdge>();
  for (const creation of creations) {
    const targets = [
      ...(creation.parent_creation_id ? [creation.parent_creation_id] : []),
      ...(creation.reference_claims ?? []).map((claim) => (
        claim.type === "creation" ? claim.creation_id : claim.reference_id
      )),
    ];
    for (const sourceId of targets) {
      if (sourceId === creation.creation_id) continue;
      const key = `${sourceId}->${creation.creation_id}`;
      edges.set(key, { sourceId, targetId: creation.creation_id });
    }
  }
  return [...edges.values()].sort((left, right) => (
    `${left.sourceId}->${left.targetId}`.localeCompare(`${right.sourceId}->${right.targetId}`)
  ));
}

export function dependencyPath(source: CanvasNodeBox, target: CanvasNodeBox, lane: number): string {
  const laneOffset = lane * 18;
  const sourceRight = source.x + source.width;
  const targetRight = target.x + target.width;
  const sourceCenterX = source.x + source.width / 2;
  const targetCenterX = target.x + target.width / 2;
  const sourceCenterY = source.y + source.height / 2;
  const targetCenterY = target.y + target.height / 2;
  const horizontallySeparated = sourceRight <= target.x || targetRight <= source.x;

  if (horizontallySeparated) {
    const forward = sourceCenterX <= targetCenterX;
    const sourceX = forward ? sourceRight : source.x;
    const targetX = forward ? target.x : targetRight;
    if (lane === 0 && Math.abs(sourceCenterY - targetCenterY) < 10) {
      return `M ${sourceX} ${sourceCenterY} L ${targetX} ${targetCenterY}`;
    }
    const direction = forward ? 1 : -1;
    const elbowX = (sourceX + targetX) / 2 + laneOffset * direction;
    return `M ${sourceX} ${sourceCenterY} L ${elbowX} ${sourceCenterY} L ${elbowX} ${targetCenterY} L ${targetX} ${targetCenterY}`;
  }

  const forward = sourceCenterY <= targetCenterY;
  const sourceY = forward ? source.y + source.height : source.y;
  const targetY = forward ? target.y : target.y + target.height;
  if (lane === 0 && Math.abs(sourceCenterX - targetCenterX) < 10) {
    return `M ${sourceCenterX} ${sourceY} L ${targetCenterX} ${targetY}`;
  }
  const direction = forward ? 1 : -1;
  const elbowY = (sourceY + targetY) / 2 + laneOffset * direction;
  return `M ${sourceCenterX} ${sourceY} L ${sourceCenterX} ${elbowY} L ${targetCenterX} ${elbowY} L ${targetCenterX} ${targetY}`;
}

function relationLane(index: number): number {
  if (index === 0) return 0;
  return index % 2 === 0 ? index / 2 : -(index + 1) / 2;
}

export function dependencyLane(edge: CanvasDependencyEdge, edges: readonly CanvasDependencyEdge[]): number {
  const siblings = edges
    .filter((candidate) => candidate.targetId === edge.targetId)
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const index = siblings.findIndex(
    (candidate) => candidate.sourceId === edge.sourceId && candidate.targetId === edge.targetId,
  );
  return relationLane(index < 0 ? 0 : index);
}

export function createCanvasGroupId(): string {
  const randomUuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const compact = randomUuid.replace(/[^a-f0-9]/gi, "").toLowerCase().padEnd(20, "0");
  return `g_${compact.slice(0, 20)}`;
}

export function createCanvasPatchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function arrangeCanvasNodes(
  nodeIds: readonly string[],
  currentPositions: Record<string, Point>,
  creations: FreeCreation[],
  uploads: FreeCreationUpload[],
): Record<string, Point> {
  const ids = [...new Set(nodeIds)];
  if (!ids.length) return { ...currentPositions };
  const idSet = new Set(ids);
  const edges = buildCanvasDependencyEdges(creations).filter((edge) => idSet.has(edge.sourceId) && idSet.has(edge.targetId));
  const uploadsById = new Map(uploads.map((upload) => [upload.reference_id, upload]));
  const minX = Math.min(...ids.map((id) => currentPositions[id]?.x ?? 96));
  const minY = Math.min(...ids.map((id) => currentPositions[id]?.y ?? 88));
  const next = { ...currentPositions };
  if (!edges.length) {
    const orderedIds = [...ids].sort((left, right) => {
      const leftPosition = currentPositions[left];
      const rightPosition = currentPositions[right];
      return (leftPosition?.y ?? 0) - (rightPosition?.y ?? 0)
        || (leftPosition?.x ?? 0) - (rightPosition?.x ?? 0)
        || left.localeCompare(right);
    });
    const columnCount = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(orderedIds.length))));
    orderedIds.forEach((id, index) => {
      const height = uploadsById.has(id) ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT;
      next[id] = {
        x: minX + (index % columnCount) * (NODE_WIDTH + NODE_GAP_X),
        y: minY + Math.floor(index / columnCount) * (height + NODE_GAP_Y),
      };
    });
    return next;
  }
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  ids.forEach((id) => {
    incoming.set(id, []);
    outgoing.set(id, []);
  });
  edges.forEach((edge) => {
    incoming.get(edge.targetId)?.push(edge.sourceId);
    outgoing.get(edge.sourceId)?.push(edge.targetId);
  });

  const levels = new Map<string, number>(ids.map((id) => [id, 0]));
  const indegree = new Map(ids.map((id) => [id, incoming.get(id)?.length ?? 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const visited = new Set<string>();
  while (queue.length) {
    const sourceId = queue.shift()!;
    visited.add(sourceId);
    for (const targetId of outgoing.get(sourceId) ?? []) {
      levels.set(targetId, Math.max(levels.get(targetId) ?? 0, (levels.get(sourceId) ?? 0) + 1));
      indegree.set(targetId, (indegree.get(targetId) ?? 1) - 1);
      if (indegree.get(targetId) === 0) queue.push(targetId);
    }
    queue.sort();
  }
  // Cyclic or partially loaded references stay in the first available layer instead of blocking layout.
  ids.filter((id) => !visited.has(id)).forEach((id) => levels.set(id, 0));

  const layers = new Map<number, string[]>();
  ids.forEach((id) => {
    const layer = levels.get(id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), id]);
  });
  for (const [layer, layerIds] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    layerIds.sort((left, right) => {
      const leftY = currentPositions[left]?.y ?? 0;
      const rightY = currentPositions[right]?.y ?? 0;
      return leftY - rightY || left.localeCompare(right);
    });
    layerIds.forEach((id, index) => {
      const height = uploadsById.has(id) ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT;
      const previous = currentPositions[id];
      const centeredOffset = layerIds.length > 1 ? (index - (layerIds.length - 1) / 2) * (height + NODE_GAP_Y) : 0;
      next[id] = {
        x: minX + layer * (NODE_WIDTH + NODE_GAP_X + 96),
        y: minY + centeredOffset + (layerIds.length > 1 ? (layerIds.length - 1) * (height + NODE_GAP_Y) / 2 : 0),
      };
      if (!previous) next[id].y = minY + index * (height + NODE_GAP_Y);
    });
  }
  return next;
}

function overlapsPosition(candidate: Point, occupied: Point[]): boolean {
  return occupied.some((position) => (
    candidate.x < position.x + NODE_WIDTH + PLACEMENT_PADDING
    && candidate.x + NODE_WIDTH + PLACEMENT_PADDING > position.x
    && candidate.y < position.y + NODE_HEIGHT + PLACEMENT_PADDING
    && candidate.y + NODE_HEIGHT + PLACEMENT_PADDING > position.y
  ));
}

function isWithinBounds(point: Point, bounds: CanvasBounds): boolean {
  return point.x >= bounds.left
    && point.y >= bounds.top
    && point.x + NODE_WIDTH <= bounds.right
    && point.y + NODE_HEIGHT <= bounds.bottom;
}

export function findOpenCanvasPosition(
  occupied: Point[],
  bounds: CanvasBounds,
  preferred?: Point,
): { position: Point; visible: boolean } {
  const candidates: Point[] = [];
  if (preferred) {
    const stepX = NODE_WIDTH + NODE_GAP_X;
    const stepY = NODE_HEIGHT + NODE_GAP_Y;
    candidates.push(preferred);
    for (let ring = 1; ring <= 5; ring += 1) {
      for (let y = -ring; y <= ring; y += 1) {
        for (let x = -ring; x <= ring; x += 1) {
          if (Math.abs(x) !== ring && Math.abs(y) !== ring) continue;
          candidates.push({ x: preferred.x + x * stepX, y: preferred.y + y * stepY });
        }
      }
    }
  }

  const firstColumn = Math.ceil((bounds.left - 96) / (NODE_WIDTH + NODE_GAP_X));
  const firstRow = Math.ceil((bounds.top - 88) / (NODE_HEIGHT + NODE_GAP_Y));
  for (let row = Math.max(0, firstRow); row < Math.max(1, firstRow) + 8; row += 1) {
    for (let column = Math.max(0, firstColumn); column < Math.max(1, firstColumn) + 8; column += 1) {
      candidates.push({
        x: 96 + column * (NODE_WIDTH + NODE_GAP_X),
        y: 88 + row * (NODE_HEIGHT + NODE_GAP_Y),
      });
    }
  }

  const visible = candidates.find((candidate) => isWithinBounds(candidate, bounds) && !overlapsPosition(candidate, occupied));
  if (visible) return { position: visible, visible: true };
  const available = candidates.find((candidate) => !overlapsPosition(candidate, occupied));
  if (available) return { position: available, visible: false };
  let index = occupied.length;
  while (overlapsPosition(initialPosition(index), occupied)) index += 1;
  return { position: initialPosition(index), visible: false };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function isCanvasNodeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-canvas-node='true']"));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest("button, a, input, textarea, select, video, audio, [role='button'], [data-canvas-node='true']"),
  );
}

function isNodeControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, textarea, select, video, audio"));
}

function uploadMediaUrl(projectName: string, upload: FreeCreationUpload): string {
  return upload.url ?? API.getFileUrl(projectName, upload.path);
}

function sharedCanvasState(
  positions: Record<string, Point>,
  hiddenCreationIds: string[],
  hiddenReferenceIds: string[],
  groups: CanvasGroup[],
  showRelations: boolean,
): CanvasSharedState {
  return {
    positions,
    hiddenCreationIds: [...hiddenCreationIds].sort(),
    hiddenReferenceIds: [...hiddenReferenceIds].sort(),
    groups,
    showRelations,
  };
}

function sharedCanvasFromResponse(canvas: FreeCreationCanvasState): CanvasSharedState {
  return sharedCanvasState(
    canvas.positions,
    canvas.hidden_creation_ids,
    canvas.hidden_reference_ids ?? [],
    canvas.groups ?? [],
    canvas.show_relations ?? true,
  );
}

export function FreeCreationInfiniteCanvas({
  projectName,
  creations,
  uploads,
  subtitleTracks = [],
  readOnly,
  actingId,
  onCancel,
  onRetry,
  onEdit,
  onReference,
  onReferences,
  onPreview,
  onEditSubtitle,
  onDeleteItems,
  onDeleteCreations,
  onRestoreCreations,
  onDeleteUpload,
  onRestoreUpload,
  onMerge,
  onCompositeAudio,
  onUploadFiles,
}: FreeCreationInfiniteCanvasProps) {
  const { t } = useTranslation("dashboard");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const pointerRef = useRef<PointerOperation | null>(null);
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const viewportSaveTimerRef = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const nodeRevisionsRef = useRef<Record<string, number>>({});
  const lastSavedSharedRef = useRef<CanvasSharedState | null>(null);
  const lastSavedViewportRef = useRef("");
  const seenPatchIdsRef = useRef(new Set<string>());
  const lastCanvasEventSequenceRef = useRef(0);
  const disposedRef = useRef(false);
  const viewportAnimationTimerRef = useRef<number | null>(null);
  const nativeNodeDragRef = useRef(false);
  const mediaPlaybackRef = useRef(new Map<string, { currentTime: number; playing: boolean }>());
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
  const historyRef = useRef(new CanvasCommandHistory<CanvasHistoryState>({
    maxCommands: 50,
    maxBytes: 16 * 1024 * 1024,
  }));
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const workspaceOperationRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWorkspaceOperationsRef = useRef(0);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const positionsRef = useRef<Record<string, Point>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const hiddenIdsRef = useRef<string[]>([]);
  const [hiddenUploadIds, setHiddenUploadIds] = useState<string[]>([]);
  const hiddenUploadIdsRef = useRef<string[]>([]);
  const groupsRef = useRef<CanvasGroup[]>([]);
  const showRelationsRef = useRef(true);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [spacePressed, setSpacePressed] = useState(false);
  const [marquee, setMarquee] = useState<{ start: Point; current: Point } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [hydratedProject, setHydratedProject] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [groups, setGroups] = useState<CanvasGroup[]>([]);
  const [showRelations, setShowRelations] = useState(true);
  const [viewportAnimating, setViewportAnimating] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 720 });
  const [lod, setLod] = useState<CanvasLod>("detail");
  const canvasEvents = useFreeCreationStore((state) => state.canvasEvents);
  const canvasReady = hydratedProject === projectName;

  const restoreVideoPlayback = useCallback((id: string, video: HTMLVideoElement, fallbackTime = 0) => {
    const saved = mediaPlaybackRef.current.get(id);
    const time = saved?.currentTime ?? fallbackTime;
    if (video.duration > time && Math.abs(video.currentTime - time) > 0.05) video.currentTime = time;
    if (saved?.playing) void video.play().catch(() => undefined);
  }, []);

  const rememberVideoPlayback = useCallback((id: string, video: HTMLVideoElement) => {
    mediaPlaybackRef.current.set(id, { currentTime: video.currentTime, playing: !video.paused });
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const updateSize = () => {
      const rect = surface.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setViewportSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    hiddenIdsRef.current = hiddenIds;
  }, [hiddenIds]);

  useEffect(() => {
    hiddenUploadIdsRef.current = hiddenUploadIds;
  }, [hiddenUploadIds]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  useEffect(() => {
    showRelationsRef.current = showRelations;
  }, [showRelations]);

  const currentSharedState = useCallback(() => sharedCanvasState(
    positionsRef.current,
    hiddenIdsRef.current,
    hiddenUploadIdsRef.current,
    groupsRef.current,
    showRelationsRef.current,
  ), []);

  const applySharedState = useCallback((state: CanvasSharedState) => {
    positionsRef.current = state.positions;
    hiddenIdsRef.current = state.hiddenCreationIds;
    hiddenUploadIdsRef.current = state.hiddenReferenceIds;
    groupsRef.current = state.groups;
    showRelationsRef.current = state.showRelations;
    setPositions(state.positions);
    setHiddenIds(state.hiddenCreationIds);
    setHiddenUploadIds(state.hiddenReferenceIds);
    setGroups(state.groups);
    setShowRelations(state.showRelations);
  }, []);

  const captureHistoryState = useCallback((options: {
    deletedCreationIds?: string[];
    deletedReferenceIds?: string[];
  } = {}): CanvasHistoryState => ({
      positions: { ...positionsRef.current },
      hiddenCreationIds: [...hiddenIdsRef.current],
      hiddenUploadIds: [...hiddenUploadIdsRef.current],
      groups: groupsRef.current.map((group) => ({ ...group, member_ids: [...group.member_ids] })),
      showRelations: showRelationsRef.current,
      ...options,
  }), []);

  const recordHistory = useCallback((before: CanvasHistoryState, after: CanvasHistoryState) => {
    historyRef.current.push({ before, after });
  }, []);

  const commitHistoryState = useCallback((before: CanvasHistoryState, after: CanvasHistoryState) => {
    recordHistory(before, after);
    applySharedState({
      positions: after.positions,
      hiddenCreationIds: after.hiddenCreationIds,
      hiddenReferenceIds: after.hiddenUploadIds,
      groups: after.groups,
      showRelations: after.showRelations,
    });
  }, [applySharedState, recordHistory]);

  const enqueueWorkspaceOperation = useCallback((operation: () => Promise<void>) => {
    pendingWorkspaceOperationsRef.current += 1;
    const queued = workspaceOperationRef.current.then(operation);
    workspaceOperationRef.current = queued.then(() => undefined, () => undefined);
    void queued.then(
      () => { pendingWorkspaceOperationsRef.current = Math.max(0, pendingWorkspaceOperationsRef.current - 1); },
      () => { pendingWorkspaceOperationsRef.current = Math.max(0, pendingWorkspaceOperationsRef.current - 1); },
    );
    return queued;
  }, []);

  const orderedCreations = useMemo(
    () => [...creations].sort((left, right) => (left.updated_at ?? "").localeCompare(right.updated_at ?? "")),
    [creations],
  );
  const creationsById = useMemo(
    () => new Map(creations.map((creation) => [creation.creation_id, creation])),
    [creations],
  );
  const subtitleCountByCreation = useMemo(() => {
    const counts = new Map<string, number>();
    for (const track of subtitleTracks) {
      counts.set(track.creation_id, (counts.get(track.creation_id) ?? 0) + 1);
    }
    return counts;
  }, [subtitleTracks]);
  const uploadsById = useMemo(
    () => new Map(uploads.map((upload) => [upload.reference_id, upload])),
    [uploads],
  );
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const visibleCreations = useMemo(
    () => orderedCreations.filter((creation) => showHidden || !hiddenSet.has(creation.creation_id)),
    [hiddenSet, orderedCreations, showHidden],
  );
  const hiddenUploadSet = useMemo(() => new Set(hiddenUploadIds), [hiddenUploadIds]);
  const visibleUploads = useMemo(
    () => uploads.filter((upload) => showHidden || !hiddenUploadSet.has(upload.reference_id)),
    [hiddenUploadSet, showHidden, uploads],
  );
  const allNodes = useMemo(
    () => [
      ...uploads.map((upload) => ({ id: upload.reference_id, kind: "upload" as const })),
      ...orderedCreations.map((creation) => ({ id: creation.creation_id, kind: "creation" as const })),
    ],
    [orderedCreations, uploads],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const groupByMember = useMemo(() => {
    const result = new Map<string, CanvasGroup>();
    for (const group of groups) {
      for (const memberId of group.member_ids) result.set(memberId, group);
    }
    return result;
  }, [groups]);
  const dependencyEdges = useMemo(
    () => buildCanvasDependencyEdges(creations).filter((edge) => {
      return Boolean(
        nodeBox(edge.sourceId, positions, uploadsById)
        && nodeBox(edge.targetId, positions, uploadsById)
        && !hiddenSet.has(edge.sourceId)
        && !hiddenSet.has(edge.targetId)
        && !hiddenUploadSet.has(edge.sourceId)
        && !hiddenUploadSet.has(edge.targetId),
      );
    }),
    [creations, hiddenSet, hiddenUploadSet, positions, uploadsById],
  );
  const groupFrames = useMemo<CanvasGroupFrame[]>(() => groups.flatMap((group, index) => {
    const members = group.member_ids
      .filter((memberId) => !hiddenSet.has(memberId) && !hiddenUploadSet.has(memberId))
      .map((memberId) => nodeBox(memberId, positions, uploadsById))
      .filter((box): box is CanvasNodeBox => Boolean(box));
    if (members.length < 2) return [];
    const padding = 22;
    const labelHeight = 26;
    const left = Math.min(...members.map((box) => box.x)) - padding;
    const top = Math.min(...members.map((box) => box.y)) - padding - labelHeight;
    const right = Math.max(...members.map((box) => box.x + box.width)) + padding;
    const bottom = Math.max(...members.map((box) => box.y + box.height)) + padding;
    return [{ groupId: group.group_id, labelIndex: index + 1, x: left, y: top, width: right - left, height: bottom - top }];
  }), [groups, hiddenSet, hiddenUploadSet, positions, uploadsById]);
  const canvasNodes = useMemo<CanvasRenderNode[]>(() => [
    ...visibleUploads.flatMap((upload) => {
      const position = positions[upload.reference_id];
      if (!position) return [];
      return [{
        id: upload.reference_id,
        kind: "upload" as const,
        minX: position.x,
        minY: position.y,
        maxX: position.x + NODE_WIDTH,
        maxY: position.y + UPLOAD_NODE_HEIGHT,
        label: upload.original_filename,
        mediaType: upload.media_type,
        status: "succeeded",
        thumbnailUrl: upload.media_type === "image" ? uploadMediaUrl(projectName, upload) : undefined,
        ...(upload.media_type === "video" ? {
          thumbnailUrl: API.getFreeCreationReferenceCoverUrl(projectName, upload.reference_id),
        } : {}),
      }];
    }),
    ...visibleCreations.flatMap((creation) => {
      const position = positions[creation.creation_id];
      if (!position) return [];
      const mediaType = creationMediaType(creation);
      return [{
        id: creation.creation_id,
        kind: "creation" as const,
        minX: position.x,
        minY: position.y,
        maxX: position.x + NODE_WIDTH,
        maxY: position.y + NODE_HEIGHT,
        label: creation.prompt || creation.creation_id,
        mediaType,
        status: creation.status,
        thumbnailUrl: creation.status === "succeeded" && mediaType !== "audio"
          ? mediaType === "video"
            ? API.getFreeCreationCoverUrl(projectName, creation.creation_id, creation.version)
            : API.getFreeCreationMediaUrl(projectName, creation.creation_id, creation.version)
          : undefined,
      }];
    }),
    ...subtitleTracks.flatMap((track, index) => {
      if (hiddenSet.has(track.creation_id)) return [];
      const parent = positions[track.creation_id];
      if (!parent) return [];
      const siblingIndex = subtitleTracks.slice(0, index).filter((item) => item.creation_id === track.creation_id).length;
      const position = subtitlePosition(parent, siblingIndex);
      return [{
        id: `subtitle:${track.subtitle_id}`,
        kind: "subtitle" as const,
        minX: position.x,
        minY: position.y,
        maxX: position.x + SUBTITLE_NODE_WIDTH,
        maxY: position.y + SUBTITLE_NODE_HEIGHT,
        label: track.cues[0]?.text || track.subtitle_id,
        mediaType: "text" as const,
        status: "succeeded",
      }];
    }),
  ], [hiddenSet, positions, projectName, subtitleTracks, visibleCreations, visibleUploads]);
  const canvasNodesById = useMemo(() => new Map(canvasNodes.map((node) => [node.id, node])), [canvasNodes]);
  const spatialIndex = useMemo(() => new CanvasSpatialIndex(canvasNodes), [canvasNodes]);
  const contentBounds = useMemo(() => computeContentBounds(canvasNodes), [canvasNodes]);
  const selectedBounds = useMemo(() => {
    const selectedNodes = canvasNodes.filter((node) => selectedSet.has(node.id));
    return selectedNodes.length ? computeContentBounds(selectedNodes) : null;
  }, [canvasNodes, selectedSet]);
  const worldViewport = useMemo(
    () => viewportWorldRect({ x: pan.x, y: pan.y, scale }, viewportSize),
    [pan.x, pan.y, scale, viewportSize],
  );
  const viewportNodes = useMemo(() => spatialIndex.search(worldViewport), [spatialIndex, worldViewport]);
  const viewportRenderNodes = useMemo(
    () => viewportNodes.flatMap((node) => {
      const renderNode = canvasNodesById.get(node.id);
      return renderNode ? [renderNode] : [];
    }),
    [canvasNodesById, viewportNodes],
  );
  useEffect(() => {
    const nextLod = selectCanvasLod({
      projectedNodeWidth: NODE_WIDTH * scale,
      visibleCount: viewportNodes.length,
      previous: lod,
    });
    if (nextLod !== lod) {
      // LOD is a state machine: the previous band is required for hysteresis.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLod(nextLod);
    }
  }, [lod, scale, viewportNodes.length]);
  useLayoutEffect(() => () => {
    if (lod !== "detail") return;
    const videos = surfaceRef.current?.querySelectorAll<HTMLVideoElement>("video[data-canvas-media-id]");
    for (const video of videos ?? []) {
      const id = video.dataset.canvasMediaId;
      if (id) mediaPlaybackRef.current.set(id, { currentTime: video.currentTime, playing: !video.paused });
    }
  }, [lod]);
  const viewportNodeIds = useMemo(() => new Set(viewportNodes.map((node) => node.id)), [viewportNodes]);
  const domNodeIds = useMemo(() => {
    if (lod === "detail") return viewportNodeIds;
    const pinned = selectedIds.filter((id) => positions[id]);
    if (contextMenu?.nodeId && !pinned.includes(contextMenu.nodeId)) pinned.push(contextMenu.nodeId);
    return new Set(pinned.slice(0, 160));
  }, [contextMenu, lod, positions, selectedIds, viewportNodeIds]);
  const renderedUploads = useMemo(
    () => visibleUploads.filter((upload) => domNodeIds.has(upload.reference_id)),
    [domNodeIds, visibleUploads],
  );
  const renderedCreations = useMemo(
    () => visibleCreations.filter((creation) => domNodeIds.has(creation.creation_id)),
    [domNodeIds, visibleCreations],
  );
  const sceneEdges = useMemo(() => [
    ...dependencyEdges
      .filter((edge) => viewportNodeIds.has(edge.sourceId) && viewportNodeIds.has(edge.targetId))
      .map((edge) => ({ ...edge, lane: dependencyLane(edge, dependencyEdges) })),
    ...subtitleTracks.flatMap((track, index) => {
      const targetId = `subtitle:${track.subtitle_id}`;
      if (!viewportNodeIds.has(track.creation_id) || !viewportNodeIds.has(targetId)) return [];
      const siblingIndex = subtitleTracks.slice(0, index).filter((item) => item.creation_id === track.creation_id).length;
      return [{ sourceId: track.creation_id, targetId, lane: relationLane(siblingIndex) }];
    }),
  ], [dependencyEdges, subtitleTracks, viewportNodeIds]);
  const sceneGroups = useMemo(() => groupFrames
    .map((frame) => ({
      id: frame.groupId,
      minX: frame.x,
      minY: frame.y,
      maxX: frame.x + frame.width,
      maxY: frame.y + frame.height,
    }))
    .filter((frame) => (
      frame.minX <= worldViewport.maxX
      && frame.maxX >= worldViewport.minX
      && frame.minY <= worldViewport.maxY
      && frame.maxY >= worldViewport.minY
    )), [groupFrames, worldViewport]);
  const selectedMergeIds = useMemo(() => {
    if (selectedIds.length < 2) return [];
    const selectedCreations = selectedIds
      .map((id) => creations.find((creation) => creation.creation_id === id))
      .filter((creation): creation is FreeCreation => Boolean(creation));
    if (selectedCreations.length !== selectedIds.length) return [];
    if (selectedCreations.some((creation) => creation.status !== "succeeded" || (creation.media_type !== "video" && creation.output_type !== "video"))) return [];
    return selectedCreations.map((creation) => creation.creation_id);
  }, [creations, selectedIds]);
  const selectedReferences = useMemo<Array<{ claim: FreeCreationReferenceClaim; label: string }>>(() => selectedIds.reduce<Array<{ claim: FreeCreationReferenceClaim; label: string }>>((result, id) => {
    const upload = uploads.find((item) => item.reference_id === id);
    if (upload) {
      result.push({
        claim: { type: "upload" as const, reference_id: upload.reference_id, role: freeCreationUploadRole(upload.media_type) },
        label: upload.original_filename,
      });
      return result;
    }
    const selectedCreation = creations.find((item) => item.creation_id === id);
    if (!selectedCreation || selectedCreation.status !== "succeeded" || !selectedCreation.media_path) return result;
    result.push({
      claim: {
        type: "creation" as const,
        creation_id: selectedCreation.creation_id,
        version: selectedCreation.version,
        role: creationReferenceRole(selectedCreation),
      },
      label: selectedCreation.prompt || t("free_creation"),
    });
    return result;
  }, []), [creations, selectedIds, t, uploads]);

  const publishSelection = useCallback((ids: string[]) => {
    setSelectedIds(ids);
    const selectedCreations = creations.filter(
      (item) => ids.includes(item.creation_id) && item.status === "succeeded" && Boolean(item.media_path),
    );
    const requestIds = new Set(selectedCreations.map((item) => item.request_id).filter(Boolean));
    const selectedVideoIds = selectedCreations
      .filter((item) => creationMediaType(item) === "video")
      .map((item) => item.creation_id);
    useFreeCreationStore.getState().setSelection(
      selectedCreations.map((item) => item.creation_id),
      requestIds.size === 1 ? [...requestIds][0] ?? null : null,
      selectedVideoIds,
    );
  }, [creations]);

  const applyHistoryState = useCallback((state: CanvasHistoryState) => {
    applySharedState({
      positions: state.positions,
      hiddenCreationIds: state.hiddenCreationIds,
      hiddenReferenceIds: state.hiddenUploadIds,
      groups: state.groups,
      showRelations: state.showRelations,
    });
    setShowHidden(false);
    setContextMenu(null);
    publishSelection([]);
  }, [applySharedState, publishSelection]);

  useEffect(() => {
    const validIds = new Set(allNodes.map((node) => node.id));
    const nextSelection = selectedIds.filter((id) => validIds.has(id));
    const nextGroups = groups
      .map((group) => ({ ...group, member_ids: group.member_ids.filter((id) => validIds.has(id)) }))
      .filter((group) => group.member_ids.length >= 2);
    const groupsChanged = nextGroups.length !== groups.length || nextGroups.some(
      (group, index) => group.member_ids.length !== groups[index]?.member_ids.length,
    );
    if (nextSelection.length === selectedIds.length && !groupsChanged) return;
    // Keep selection and persisted groups aligned when SSE, polling, or deletion removes a node.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (nextSelection.length !== selectedIds.length) publishSelection(nextSelection);
    if (groupsChanged) setGroups(nextGroups);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [allNodes, groups, publishSelection, selectedIds]);

  const restoreDeletedHistoryItems = useCallback(async (state: CanvasHistoryState): Promise<boolean> => {
    let succeeded = true;
    if (state.deletedCreationIds?.length) {
      succeeded = Boolean(onRestoreCreations)
        && (await onRestoreCreations?.(state.deletedCreationIds)) !== false;
    }
    if (state.deletedReferenceIds?.length) {
      const results = onRestoreUpload
        ? await Promise.all(state.deletedReferenceIds.map((id) => Promise.resolve(onRestoreUpload(id))))
        : [false];
      succeeded = results.every((result) => result !== false) && succeeded;
    }
    return succeeded;
  }, [onRestoreCreations, onRestoreUpload]);

  const deleteHistoryItems = useCallback(async (state: CanvasHistoryState): Promise<boolean> => {
    const creationIds = state.deletedCreationIds ?? [];
    const referenceIds = state.deletedReferenceIds ?? [];
    if (!creationIds.length && !referenceIds.length) return true;
    if (onDeleteItems) {
      return (await onDeleteItems({ creationIds, referenceIds })) !== false;
    }
    const results: Array<boolean | undefined> = [];
    if (creationIds.length) results.push(await onDeleteCreations?.(creationIds));
    if (referenceIds.length) {
      results.push(...await Promise.all(referenceIds.map((id) => Promise.resolve(onDeleteUpload?.(id)))));
    }
    return results.every((result) => result !== false);
  }, [onDeleteCreations, onDeleteItems, onDeleteUpload]);

  const undoCanvasChange = useCallback(async () => {
    const command = historyRef.current.undo();
    if (!command) return;
    await enqueueWorkspaceOperation(async () => {
      if (!(await restoreDeletedHistoryItems(command.after))) {
        historyRef.current.redo();
        return;
      }
      applyHistoryState(command.before);
    });
  }, [applyHistoryState, enqueueWorkspaceOperation, restoreDeletedHistoryItems]);

  const redoCanvasChange = useCallback(async () => {
    const command = historyRef.current.redo();
    if (!command) return;
    await enqueueWorkspaceOperation(async () => {
      if (!(await deleteHistoryItems(command.after))) {
        historyRef.current.undo();
        return;
      }
      applyHistoryState(command.after);
    });
  }, [applyHistoryState, deleteHistoryItems, enqueueWorkspaceOperation]);

  useEffect(() => {
    disposedRef.current = false;
    hydratedRef.current = false;
    revisionRef.current = 0;
    nodeRevisionsRef.current = {};
    lastSavedSharedRef.current = null;
    lastSavedViewportRef.current = "";
    seenPatchIdsRef.current.clear();
    historyRef.current.clear();
    const controller = new AbortController();
    void API.getFreeCreationCanvas(projectName)
      .then(({ canvas }) => {
        if (controller.signal.aborted) return;
        const shared = sharedCanvasFromResponse(canvas);
        lastSavedSharedRef.current = shared;
        lastSavedViewportRef.current = JSON.stringify(canvas.viewport);
        positionsRef.current = canvas.positions;
        hiddenIdsRef.current = canvas.hidden_creation_ids;
        hiddenUploadIdsRef.current = canvas.hidden_reference_ids ?? [];
        groupsRef.current = canvas.groups ?? [];
        showRelationsRef.current = canvas.show_relations ?? true;
        setPositions(shared.positions);
        setPan({ x: canvas.viewport.x, y: canvas.viewport.y });
        setScale(canvas.viewport.scale);
        setHiddenIds(shared.hiddenCreationIds);
        setHiddenUploadIds(shared.hiddenReferenceIds);
        setGroups(shared.groups);
        setShowRelations(shared.showRelations);
        revisionRef.current = canvas.revision;
        nodeRevisionsRef.current = canvas.node_revisions ?? {};
        lastCanvasEventSequenceRef.current = useFreeCreationStore.getState().canvasEvents.at(-1)?.sequence ?? 0;
        hydratedRef.current = true;
        setHydratedProject(projectName);
      })
      .catch(() => {
        hydratedRef.current = true;
        setHydratedProject(projectName);
      });
    return () => controller.abort();
  }, [projectName]);

  useEffect(() => () => {
    disposedRef.current = true;
    if (viewportAnimationTimerRef.current !== null) window.clearTimeout(viewportAnimationTimerRef.current);
    if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
  }, []);

  const visiblePlacementBounds = useCallback((): CanvasBounds => {
    const surface = surfaceRef.current;
    const width = surface?.clientWidth || 1280;
    const height = surface?.clientHeight || 720;
    const leftInset = width >= 900 ? 420 : 24;
    const bottomInset = height >= 620 ? 292 : 80;
    return {
      left: (leftInset - pan.x) / scale,
      top: (64 - pan.y) / scale,
      right: (width - 24 - pan.x) / scale,
      bottom: (height - bottomInset - pan.y) / scale,
    };
  }, [pan.x, pan.y, scale]);

  const arrangeNodes = useCallback((scope: "all" | "selected") => {
    if (readOnly) return;
    const visibleIds = [
      ...visibleUploads.map((upload) => upload.reference_id),
      ...visibleCreations.map((creation) => creation.creation_id),
    ];
    const visibleSet = new Set(visibleIds);
    const targetIds = scope === "selected"
      ? selectedIds.filter((id) => visibleSet.has(id))
      : visibleIds;
    if (targetIds.length < (scope === "selected" ? 2 : 1)) return;
    const next = arrangeCanvasNodes(targetIds, positionsRef.current, creations, uploads);
    const changed = targetIds.some((id) => {
      const current = positionsRef.current[id];
      const arranged = next[id];
      return current?.x !== arranged?.x || current?.y !== arranged?.y;
    });
    if (!changed) return;
    const before = captureHistoryState();
    commitHistoryState(before, { ...before, positions: { ...before.positions, ...next } });
    setContextMenu(null);
  }, [captureHistoryState, commitHistoryState, creations, readOnly, selectedIds, uploads, visibleCreations, visibleUploads]);

  const fitView = useCallback((scope: "all" | "selected") => {
    const bounds = scope === "selected" ? selectedBounds : contentBounds;
    if (!bounds) return;
    const camera = fitCameraToBounds(bounds, viewportSize, {
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      padding: 72,
    });
    setViewportAnimating(true);
    setPan({ x: camera.x, y: camera.y });
    setScale(camera.scale);
    if (viewportAnimationTimerRef.current !== null) window.clearTimeout(viewportAnimationTimerRef.current);
    viewportAnimationTimerRef.current = window.setTimeout(() => setViewportAnimating(false), 240);
  }, [contentBounds, selectedBounds, viewportSize]);

  const focusCanvasPosition = useCallback((position: Point) => {
    const surface = surfaceRef.current;
    const width = surface?.clientWidth || 1280;
    const height = surface?.clientHeight || 720;
    setViewportAnimating(true);
    setPan({
      x: width / 2 - (position.x + NODE_WIDTH / 2) * scale,
      y: height / 2 - (position.y + NODE_HEIGHT / 2) * scale,
    });
    if (viewportAnimationTimerRef.current !== null) window.clearTimeout(viewportAnimationTimerRef.current);
    viewportAnimationTimerRef.current = window.setTimeout(() => setViewportAnimating(false), 240);
  }, [scale]);

  useEffect(() => {
    if (!canvasReady) return;
    // Nodes can arrive through SSE while the creator is arranging the canvas; keep existing coordinates intact.
    const missing = allNodes.filter((node) => !positions[node.id]);
    if (!missing.length) return;
    const next = { ...positions };
    const bounds = visiblePlacementBounds();
    let focusTarget: Point | null = null;
    if (missing.length > 32) {
      const placementIndex = new CanvasSpatialIndex(allNodes.flatMap((node) => {
        const position = next[node.id];
        if (!position) return [];
        const height = node.kind === "upload" ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT;
        return [{
          id: node.id,
          kind: node.kind,
          minX: position.x - PLACEMENT_PADDING,
          minY: position.y - PLACEMENT_PADDING,
          maxX: position.x + NODE_WIDTH + PLACEMENT_PADDING,
          maxY: position.y + height + PLACEMENT_PADDING,
        }];
      }));
      let slot = 0;
      for (const node of missing) {
        let candidate = initialPosition(slot);
        while (placementIndex.search({
          minX: candidate.x,
          minY: candidate.y,
          maxX: candidate.x + NODE_WIDTH,
          maxY: candidate.y + NODE_HEIGHT,
        }).length) {
          slot += 1;
          candidate = initialPosition(slot);
        }
        next[node.id] = candidate;
        placementIndex.insert({
          id: node.id,
          kind: node.kind,
          minX: candidate.x - PLACEMENT_PADDING,
          minY: candidate.y - PLACEMENT_PADDING,
          maxX: candidate.x + NODE_WIDTH + PLACEMENT_PADDING,
          maxY: candidate.y + (node.kind === "upload" ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT) + PLACEMENT_PADDING,
        });
        slot += 1;
      }
    } else {
      missing.forEach((node, index) => {
        const occupied = Object.values(next);
        const result = occupied.length === 0 && index === 0
          ? { position: initialPosition(0), visible: true }
          : findOpenCanvasPosition(occupied, bounds);
        next[node.id] = result.position;
        if (!result.visible) focusTarget = result.position;
      });
    }
    // New nodes arrive from the project event stream, so placement synchronizes external state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPositions(next);
    if (focusTarget) focusCanvasPosition(focusTarget);
  }, [allNodes, canvasReady, focusCanvasPosition, positions, visiblePlacementBounds]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const events = canvasEvents.filter((event) => event.sequence > lastCanvasEventSequenceRef.current);
    if (!events.length) return;
    for (const event of events) {
      lastCanvasEventSequenceRef.current = Math.max(lastCanvasEventSequenceRef.current, event.sequence);
      if (event.projectName !== projectName || seenPatchIdsRef.current.has(event.patch.patch_id)) continue;
      const baseline = lastSavedSharedRef.current;
      if (!baseline) continue;
      const desired = currentSharedState();
      const pendingPatch = buildCanvasPatch(baseline, desired, {
        patchId: createCanvasPatchId(),
        baseRevision: revisionRef.current,
        nodeRevisions: nodeRevisionsRef.current,
      });
      seenPatchIdsRef.current.add(event.patch.patch_id);
      const remote = applyCanvasPatch(baseline, event.patch);
      lastSavedSharedRef.current = remote;
      revisionRef.current = Math.max(revisionRef.current, event.patch.revision);
      for (const target of canvasPatchTargets(event.patch)) {
        nodeRevisionsRef.current[target] = event.patch.revision;
      }
      applySharedState(pendingPatch
        ? rebaseCanvasState(remote, desired, pendingPatch, nodeRevisionsRef.current).state
        : remote);
    }
  }, [applySharedState, canvasEvents, currentSharedState, projectName]);

  useEffect(() => {
    if (!hydratedRef.current || readOnly) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void enqueueWorkspaceOperation(async () => {
        const before = lastSavedSharedRef.current;
        if (!before || disposedRef.current) return;
        const desired = currentSharedState();
        const attempt = buildCanvasPatch(before, desired, {
          patchId: createCanvasPatchId(),
          baseRevision: revisionRef.current,
          nodeRevisions: nodeRevisionsRef.current,
        });
        if (!attempt) return;
        try {
          const { canvas, patch } = await API.patchFreeCreationCanvas(projectName, attempt);
          if (disposedRef.current) return;
          revisionRef.current = canvas.revision;
          nodeRevisionsRef.current = canvas.node_revisions ?? nodeRevisionsRef.current;
          lastSavedSharedRef.current = sharedCanvasFromResponse(canvas);
          if (patch) {
            seenPatchIdsRef.current.add(patch.patch_id);
          }
        } catch (error) {
          if (disposedRef.current) return;
          try {
            const { canvas } = await API.getFreeCreationCanvas(projectName);
            if (disposedRef.current) return;
            const remote = sharedCanvasFromResponse(canvas);
            const rebased = rebaseCanvasState(
              remote,
              currentSharedState(),
              attempt,
              canvas.node_revisions ?? {},
            );
            revisionRef.current = canvas.revision;
            nodeRevisionsRef.current = canvas.node_revisions ?? {};
            lastSavedSharedRef.current = remote;
            applySharedState(rebased.state);
            if (rebased.conflictIds.length) {
              useAppStore.getState().pushToast(errMsg(error), "warning");
            }
          } catch {
            useAppStore.getState().pushToast(errMsg(error), "error");
          }
        }
      });
    }, 350);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [
    applySharedState,
    currentSharedState,
    enqueueWorkspaceOperation,
    groups,
    hiddenIds,
    hiddenUploadIds,
    positions,
    projectName,
    readOnly,
    showRelations,
  ]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const viewport = { x: pan.x, y: pan.y, scale };
    const snapshot = JSON.stringify(viewport);
    if (snapshot === lastSavedViewportRef.current) return;
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    viewportSaveTimerRef.current = window.setTimeout(() => {
      void API.saveFreeCreationCanvasViewport(projectName, viewport)
        .then(({ viewport: savedViewport }) => {
          lastSavedViewportRef.current = JSON.stringify(savedViewport);
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    };
  }, [pan.x, pan.y, projectName, scale]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.code === "Space" && !isEditableTarget(event.target) && !isInteractiveTarget(event.target)) {
        event.preventDefault();
        setSpacePressed(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !isEditableTarget(event.target)) {
        event.preventDefault();
        publishSelection([
          ...visibleUploads.map((item) => item.reference_id),
          ...visibleCreations.map((item) => item.creation_id),
        ]);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey && !isEditableTarget(event.target)) {
        event.preventDefault();
        if (!readOnly) void undoCanvasChange().catch(() => undefined);
      }
      if (
        (event.ctrlKey || event.metaKey)
        && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))
        && !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        if (!readOnly) void redoCanvasChange().catch(() => undefined);
      }
      if (event.key === "Escape" && !isEditableTarget(event.target)) {
        setContextMenu(null);
        setShortcutsOpen(false);
        publishSelection([]);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePressed(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    const clearSpace = () => setSpacePressed(false);
    window.addEventListener("blur", clearSpace);
    document.addEventListener("visibilitychange", clearSpace);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clearSpace);
      document.removeEventListener("visibilitychange", clearSpace);
    };
  }, [publishSelection, readOnly, redoCanvasChange, undoCanvasChange, visibleCreations, visibleUploads]);

  useEffect(() => {
    if (!contextMenu) return;
    const firstMenuItem = contextMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']");
    firstMenuItem?.focus();
  }, [contextMenu]);

  useEffect(() => () => useFreeCreationStore.getState().clearSelection(), []);

  const beginCanvasPan = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    pointerRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: pan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginNodeDrag = (event: React.PointerEvent<HTMLElement>, creationId: string) => {
    if (event.button !== 0 || readOnly) return;
    if (spacePressed) {
      beginCanvasPan(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const groupedIds = groupByMember.get(creationId)?.member_ids ?? [];
    const nextSelection = selectedSet.has(creationId)
      ? [...new Set([...selectedIds, ...groupedIds])]
      : groupedIds.length ? groupedIds : [creationId];
    publishSelection(nextSelection);
    const origins = Object.fromEntries(nextSelection.map((id) => [id, positions[id] ?? { x: 0, y: 0 }]));
    pointerRef.current = {
      kind: "nodes",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origins,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginUploadDrag = (event: React.PointerEvent<HTMLElement>, referenceId: string) => {
    if (event.button !== 0 || readOnly) return;
    if (spacePressed) {
      beginCanvasPan(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const groupedIds = groupByMember.get(referenceId)?.member_ids ?? [];
    const nextSelection = selectedSet.has(referenceId)
      ? [...new Set([...selectedIds, ...groupedIds])]
      : groupedIds.length ? groupedIds : [referenceId];
    publishSelection(nextSelection);
    pointerRef.current = {
      kind: "nodes",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origins: Object.fromEntries(nextSelection.map((id) => [id, positions[id] ?? { x: 0, y: 0 }])),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 1) {
      beginCanvasPan(event);
      return;
    }
    if ((event.target as HTMLElement).closest("[data-canvas-node='true'], button, a, input, video")) return;
    setContextMenu(null);
    if (event.button === 0 && spacePressed) {
      event.preventDefault();
      pointerRef.current = {
        kind: "pan",
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        origin: pan,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    if (lod !== "detail") {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const worldX = (event.clientX - (rect?.left ?? 0) - pan.x) / scale;
      const worldY = (event.clientY - (rect?.top ?? 0) - pan.y) / scale;
      const hit = spatialIndex.search({ minX: worldX - 1, minY: worldY - 1, maxX: worldX + 1, maxY: worldY + 1 })[0];
      if (hit) {
        if (hit.kind === "upload") beginUploadDrag(event, hit.id);
        else beginNodeDrag(event, hit.id);
        return;
      }
    }
    const point = { x: event.clientX, y: event.clientY };
    pointerRef.current = { kind: "marquee", pointerId: event.pointerId, start: point, current: point, additive: event.shiftKey };
    setMarquee({ start: point, current: point });
    if (!event.shiftKey) publishSelection([]);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const hitTestCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const worldX = (clientX - (rect?.left ?? 0) - pan.x) / scale;
    const worldY = (clientY - (rect?.top ?? 0) - pan.y) / scale;
    return spatialIndex.search({ minX: worldX - 1, minY: worldY - 1, maxX: worldX + 1, maxY: worldY + 1 })[0] ?? null;
  }, [pan.x, pan.y, scale, spatialIndex]);

  const applyPointerUpdate = (pointerId: number, clientX: number, clientY: number) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== pointerId) return;
    if (operation.kind === "pan") {
      setPan({
        x: operation.origin.x + clientX - operation.start.x,
        y: operation.origin.y + clientY - operation.start.y,
      });
      return;
    }
    if (operation.kind === "nodes") {
      const dx = (clientX - operation.start.x) / scale;
      const dy = (clientY - operation.start.y) / scale;
      const updates = Object.fromEntries(
        Object.entries(operation.origins).map(([id, origin]) => [id, { x: origin.x + dx, y: origin.y + dy }]),
      );
      positionsRef.current = { ...positionsRef.current, ...updates };
      setPositions(positionsRef.current);
      return;
    }
    const current = { x: clientX, y: clientY };
    pointerRef.current = { ...operation, current };
    setMarquee({ start: operation.start, current });
  };

  const updatePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    pendingPointerRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    if (pointerFrameRef.current !== null) return;
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const pending = pendingPointerRef.current;
      pendingPointerRef.current = null;
      if (pending) applyPointerUpdate(pending.pointerId, pending.clientX, pending.clientY);
    });
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    pendingPointerRef.current = null;
    applyPointerUpdate(event.pointerId, event.clientX, event.clientY);
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    if (operation.kind === "marquee") {
      const left = Math.min(operation.start.x, operation.current.x);
      const top = Math.min(operation.start.y, operation.current.y);
      const rect = surfaceRef.current?.getBoundingClientRect();
      const localLeft = left - (rect?.left ?? 0);
      const localTop = top - (rect?.top ?? 0);
      const width = Math.max(2, Math.abs(operation.current.x - operation.start.x));
      const height = Math.max(2, Math.abs(operation.current.y - operation.start.y));
      const hitIds = spatialIndex.search({
        minX: (localLeft - pan.x) / scale,
        minY: (localTop - pan.y) / scale,
        maxX: (localLeft + width - pan.x) / scale,
        maxY: (localTop + height - pan.y) / scale,
      }).map((node) => node.id);
      publishSelection(operation.additive ? [...new Set([...selectedIds, ...hitIds])] : hitIds);
    } else if (operation.kind === "nodes") {
      const moved = Object.entries(operation.origins).some(([id, origin]) => {
        const current = positionsRef.current[id];
        return current && (current.x !== origin.x || current.y !== origin.y);
      });
      if (moved) {
        const after = captureHistoryState();
        recordHistory(
          { ...after, positions: { ...after.positions, ...operation.origins } },
          after,
        );
      }
    } else if (operation.kind === "pan") {
      const next = clampCameraToBounds(
        {
          x: operation.origin.x + event.clientX - operation.start.x,
          y: operation.origin.y + event.clientY - operation.start.y,
          scale,
        },
        contentBounds,
        viewportSize,
      );
      setPan({ x: next.x, y: next.y });
    }
    pointerRef.current = null;
    setMarquee(null);
  };

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) return;
    if (event.altKey) {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale - event.deltaY * 0.002));
      const rect = surfaceRef.current?.getBoundingClientRect();
      const cursorX = event.clientX - (rect?.left ?? 0);
      const cursorY = event.clientY - (rect?.top ?? 0);
      const worldX = (cursorX - pan.x) / scale;
      const worldY = (cursorY - pan.y) / scale;
      const next = clampCameraToBounds({
        x: cursorX - worldX * nextScale,
        y: cursorY - worldY * nextScale,
        scale: nextScale,
      }, contentBounds, viewportSize);
      setScale(next.scale);
      setPan({ x: next.x, y: next.y });
      return;
    }
    const next = clampCameraToBounds({
      x: pan.x - event.deltaX,
      y: pan.y - event.deltaY,
      scale,
    }, contentBounds, viewportSize);
    setPan({ x: next.x, y: next.y });
  }, [contentBounds, pan.x, pan.y, scale, viewportSize]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.addEventListener("wheel", handleWheel, { passive: false });
    return () => surface.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const handleFileDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (nativeNodeDragRef.current || pointerRef.current?.kind === "nodes" || isCanvasNodeTarget(event.target)) {
      nativeNodeDragRef.current = false;
      return;
    }
    if (readOnly || !onUploadFiles) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    const preferred = {
      x: (event.clientX - (rect?.left ?? 0) - pan.x) / scale,
      y: (event.clientY - (rect?.top ?? 0) - pan.y) / scale,
    };
    const uploaded = await onUploadFiles(files);
    if (!uploaded.length) return;
    const next = { ...positionsRef.current };
    const placements: Record<string, Point> = {};
    const bounds = visiblePlacementBounds();
    let focusTarget: Point | null = null;
    uploaded.forEach((upload, index) => {
      const result = findOpenCanvasPosition(
        Object.values(next),
        bounds,
        { x: preferred.x + index * 20, y: preferred.y + index * 20 },
      );
      next[upload.reference_id] = result.position;
      placements[upload.reference_id] = result.position;
      if (!result.visible) focusTarget = result.position;
    });
    setPositions((current) => ({ ...current, ...placements }));
    if (focusTarget) focusCanvasPosition(focusTarget);
  };

  const hideNodes = (nodeIds: string[]) => {
    const before = captureHistoryState();
    const nodeSet = new Set(nodeIds);
    commitHistoryState(before, {
      ...before,
      hiddenCreationIds: [...new Set([...before.hiddenCreationIds, ...nodeIds.filter((id) => creationsById.has(id))])],
      hiddenUploadIds: [...new Set([...before.hiddenUploadIds, ...nodeIds.filter((id) => uploadsById.has(id))])],
    });
    publishSelection(selectedIds.filter((id) => !nodeSet.has(id)));
    setContextMenu(null);
  };

  const restoreNodes = (nodeIds: string[]) => {
    const before = captureHistoryState();
    const nodeSet = new Set(nodeIds);
    commitHistoryState(before, {
      ...before,
      hiddenCreationIds: before.hiddenCreationIds.filter((id) => !nodeSet.has(id)),
      hiddenUploadIds: before.hiddenUploadIds.filter((id) => !nodeSet.has(id)),
    });
    setContextMenu(null);
  };

  const hideCreation = (creationId: string) => hideNodes([creationId]);
  const hideUpload = (referenceId: string) => hideNodes([referenceId]);
  const restoreUpload = (referenceId: string) => restoreNodes([referenceId]);
  const restoreCreation = (creationId: string) => restoreNodes([creationId]);

  const deleteNodes = (creationIds: string[], referenceIds: string[]) => {
    const creationTargets = [...new Set(creationIds.filter((creationId) => {
      const creation = creationsById.get(creationId);
      return creation && !["queued", "running", "cancelling"].includes(creation.status);
    }))];
    const referenceTargets = [...new Set(referenceIds.filter((referenceId) => uploadsById.has(referenceId)))];
    const canDeleteSelection = Boolean(onDeleteItems)
      || ((creationTargets.length === 0 || Boolean(onDeleteCreations))
        && (referenceTargets.length === 0 || Boolean(onDeleteUpload)));
    if ((!creationTargets.length && !referenceTargets.length) || !canDeleteSelection) return;
    const before = captureHistoryState();
    const targetSet = new Set([...creationTargets, ...referenceTargets]);
    const after = {
      ...before,
      hiddenCreationIds: before.hiddenCreationIds.filter((id) => !targetSet.has(id)),
      hiddenUploadIds: before.hiddenUploadIds.filter((id) => !targetSet.has(id)),
      deletedCreationIds: creationTargets,
      deletedReferenceIds: referenceTargets,
    };
    publishSelection(selectedIds.filter((id) => !targetSet.has(id)));
    applySharedState({
      positions: after.positions,
      hiddenCreationIds: after.hiddenCreationIds,
      hiddenReferenceIds: after.hiddenUploadIds,
      groups: after.groups,
      showRelations: after.showRelations,
    });
    setContextMenu(null);
    void enqueueWorkspaceOperation(async () => {
      if (await deleteHistoryItems(after)) recordHistory(before, after);
      else applyHistoryState(before);
    }).catch(() => {
      applyHistoryState(before);
    });
  };

  const activeContextCreation = contextMenu
    ? contextMenu.kind === "creation" ? creations.find((creation) => creation.creation_id === contextMenu.nodeId) ?? null : null
    : null;
  const activeContextUpload = contextMenu?.kind === "upload"
    ? uploads.find((upload) => upload.reference_id === contextMenu.nodeId) ?? null
    : null;
  const contextSelectionIds = contextMenu && selectedSet.has(contextMenu.nodeId) ? selectedIds : contextMenu ? [contextMenu.nodeId] : [];
  const contextSelectionIsHidden = contextSelectionIds.length > 0 && contextSelectionIds.every(
    (id) => hiddenSet.has(id) || hiddenUploadSet.has(id),
  );
  const selectedUploadIds = contextSelectionIds.filter((id) => uploadsById.has(id));
  const selectedCreationIds = contextSelectionIds.filter((id) => creationsById.has(id));
  const audioCompositePair = (() => {
    if (selectedCreationIds.length !== 2 || contextSelectionIds.length !== 2) return null;
    const selected = selectedCreationIds.map((id) => creationsById.get(id)).filter(Boolean) as FreeCreation[];
    if (selected.length !== 2 || selected.some((item) => item.status !== "succeeded" || !item.media_path)) return null;
    const video = selected.find((item) => creationMediaType(item) === "video");
    const audio = selected.find((item) => creationMediaType(item) === "audio");
    return video && audio ? { videoId: video.creation_id, audioId: audio.creation_id } : null;
  })();
  const deletableCreationIds = selectedCreationIds.filter((id) => {
    const creation = creationsById.get(id);
    return creation && !["queued", "running", "cancelling"].includes(creation.status);
  });
  const contextSelectionCanDelete = contextSelectionIds.length > 0
    && selectedCreationIds.length + selectedUploadIds.length === contextSelectionIds.length
    && deletableCreationIds.length === selectedCreationIds.length
    && (Boolean(onDeleteItems)
      || ((selectedCreationIds.length === 0 || Boolean(onDeleteCreations))
        && (selectedUploadIds.length === 0 || Boolean(onDeleteUpload))));
  const showBatchDelete = contextSelectionIds.length >= 2 && contextSelectionCanDelete;
  const showSingleCreationDelete = Boolean(
    contextSelectionIds.length < 2
      && activeContextCreation
      && deletableCreationIds.length === 1
      && (onDeleteItems || onDeleteCreations),
  );
  const showSingleUploadDelete = Boolean(
    contextSelectionIds.length < 2 && activeContextUpload && (onDeleteItems || onDeleteUpload),
  );
  const activeContextGroup = contextMenu ? groupByMember.get(contextMenu.nodeId) : undefined;
  const canGroupSelection = contextSelectionIds.length >= 2
    && contextSelectionIds.every((id) => !groupByMember.has(id));
  const hiddenCount = hiddenIds.length + hiddenUploadIds.length;

  const groupSelection = () => {
    if (!canGroupSelection) return;
    const availableIds = new Set(allNodes.map((node) => node.id));
    const memberIds = [...new Set(contextSelectionIds.filter((id) => availableIds.has(id)))];
    if (memberIds.length < 2) return;
    const before = captureHistoryState();
    commitHistoryState(before, { ...before, groups: [...before.groups, {
      group_id: createCanvasGroupId(),
      member_ids: memberIds,
    }] });
    setContextMenu(null);
  };

  const ungroupSelection = () => {
    if (!activeContextGroup) return;
    const before = captureHistoryState();
    commitHistoryState(before, {
      ...before,
      groups: before.groups.filter((group) => group.group_id !== activeContextGroup.group_id),
    });
    setContextMenu(null);
  };

  const toggleRelations = () => {
    const before = captureHistoryState();
    commitHistoryState(before, { ...before, showRelations: !before.showRelations });
  };

  const renderActions = (creation: FreeCreation) => {
    const mediaType = creationMediaType(creation);
    return (
      <>
        {creation.status === "queued" || creation.status === "running" ? (
          <button type="button" onClick={() => onCancel(creation.creation_id)} disabled={actingId === creation.creation_id} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)] disabled:opacity-50" aria-label={t("free_creation_cancel")} title={t("free_creation_cancel")}>
            {actingId === creation.creation_id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
          </button>
        ) : null}
        {creation.status === "failed" || creation.status === "cancelled" ? (
          <button type="button" onClick={() => onRetry(creation.creation_id)} disabled={actingId === creation.creation_id} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)] disabled:opacity-50" aria-label={t("free_creation_retry")} title={creation.model ? t("free_creation_retry_original_model", { model: creation.model }) : t("free_creation_retry")}>
            {actingId === creation.creation_id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
          </button>
        ) : null}
        {creation.status === "succeeded" ? (
          <button type="button" onClick={() => onReference({ type: "creation", creation_id: creation.creation_id, version: creation.version, role: creationReferenceRole(creation) }, creation.prompt || t("free_creation"))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]" aria-label={t("free_creation_add_reference")} title={t("free_creation_add_reference")}>
            <Link2 className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {creation.status === "succeeded" && mediaType === "image" ? (
          <button type="button" onClick={() => onEdit(creation.creation_id)} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]" aria-label={t("free_creation_use_as_parent")} title={t("free_creation_use_as_parent")}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {creation.status === "succeeded" && creation.media_path ? <VersionTimeMachine projectName={projectName} resourceType={mediaType === "video" ? "free_videos" : mediaType === "audio" ? "audio" : "free_images"} resourceId={creation.creation_id} iconOnly readOnly /> : null}
        {creation.status === "succeeded" && creation.media_path ? (
          <a href={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} download className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]" aria-label={t("free_creation_download")} title={t("free_creation_download")}>
            <Download className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
      </>
    );
  };

  const handleReferenceShortcut = (
    event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
    claim: FreeCreationReferenceClaim,
    label: string,
  ) => {
    if (readOnly || (!event.ctrlKey && !event.metaKey)) return;
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onReference(claim, label);
  };

  const handleNodeKeyboard = (
    event: React.KeyboardEvent<HTMLElement>,
    nodeId: string,
    selected: boolean,
  ) => {
    if (event.currentTarget !== event.target || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      publishSelection(selected ? selectedIds.filter((id) => id !== nodeId) : [...selectedIds, nodeId]);
    } else {
      publishSelection([nodeId]);
    }
  };

  return (
    <div
      ref={surfaceRef}
      className="absolute inset-0 overflow-hidden bg-[var(--color-background)]"
      onPointerDown={handleSurfacePointerDown}
      onPointerMove={updatePointer}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        if (nativeNodeDragRef.current || pointerRef.current?.kind === "nodes" || isCanvasNodeTarget(event.target)) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        if (nativeNodeDragRef.current || pointerRef.current?.kind === "nodes" || isCanvasNodeTarget(event.target)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(event) => void handleFileDrop(event)}
      onContextMenu={(event) => {
        event.preventDefault();
        if ((event.target as HTMLElement).closest("[data-canvas-node='true']")) return;
        if (lod === "detail" || readOnly) {
          setContextMenu(null);
          return;
        }
        const hit = hitTestCanvas(event.clientX, event.clientY);
        if (!hit || hit.kind === "subtitle") {
          setContextMenu(null);
          return;
        }
        publishSelection(selectedSet.has(hit.id) ? selectedIds : [hit.id]);
        const rect = surfaceRef.current?.getBoundingClientRect();
        setContextMenu({
          kind: hit.kind,
          nodeId: hit.id,
          x: Math.min(event.clientX - (rect?.left ?? 0), (rect?.width ?? 260) - 190),
          y: Math.min(event.clientY - (rect?.top ?? 0), (rect?.height ?? 200) - 150),
        });
      }}
      onDoubleClick={(event) => {
        if (lod === "detail" || (event.target as HTMLElement).closest("[data-canvas-node='true']")) return;
        const hit = hitTestCanvas(event.clientX, event.clientY);
        if (!hit) return;
        if (hit.kind === "subtitle") {
          const track = subtitleTracks.find((item) => `subtitle:${item.subtitle_id}` === hit.id);
          if (track) onEditSubtitle?.(track.creation_id);
          return;
        }
        if (hit.kind === "upload") {
          const upload = uploadsById.get(hit.id);
          if (upload) onPreview?.({ kind: "upload", upload });
          return;
        }
        const creation = creationsById.get(hit.id);
        if (creation?.status === "succeeded" && creation.media_path) {
          onPreview?.({ kind: "creation", creation });
        }
      }}
      style={{ cursor: "default", touchAction: "none" }}
      data-testid="free-creation-canvas"
    >
      <div className="pointer-events-none absolute inset-0 opacity-75" style={{ backgroundImage: "radial-gradient(oklch(0.86 0.03 250 / 0.28) 1.25px, transparent 1.25px)", backgroundSize: `${24 * scale}px ${24 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }} />

      {dragActive ? (
        <div className="pointer-events-none absolute inset-4 z-[190] grid place-items-center rounded-md border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent-dim)] backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-md bg-[var(--color-surface-2)] px-4 py-3 text-sm font-medium text-[var(--color-text)] shadow-lg">
            <UploadCloud className="h-5 w-5 text-[var(--color-accent-2)]" aria-hidden />
            {t("free_creation_drop_on_canvas")}
          </div>
        </div>
      ) : null}

      <div className="absolute right-4 top-4 z-20 flex items-center gap-1 rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)]/94 p-1 shadow-md backdrop-blur-sm">
        <button type="button" onClick={() => setScale((value) => Math.min(MAX_SCALE, value + 0.1))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={t("free_creation_zoom_in")} aria-label={t("free_creation_zoom_in")}><ZoomIn className="h-4 w-4" aria-hidden /></button>
        <span className="min-w-12 text-center text-[11px] text-[var(--color-text-muted)]">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((value) => Math.max(MIN_SCALE, value - 0.1))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={t("free_creation_zoom_out")} aria-label={t("free_creation_zoom_out")}><ZoomOut className="h-4 w-4" aria-hidden /></button>
        <button type="button" onClick={() => { setPan({ x: 0, y: 0 }); setScale(1); }} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={t("free_creation_reset_canvas")} aria-label={t("free_creation_reset_canvas")}><LocateFixed className="h-4 w-4" aria-hidden /></button>
        <button type="button" onClick={() => fitView("all")} disabled={!canvasNodes.length} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40" title={t("free_creation_fit_all")} aria-label={t("free_creation_fit_all")}><Maximize2 className="h-4 w-4" aria-hidden /></button>
        <button type="button" onClick={() => fitView("selected")} disabled={!selectedBounds} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40" title={t("free_creation_fit_selected")} aria-label={t("free_creation_fit_selected")}><ScanSearch className="h-4 w-4" aria-hidden /></button>
        <button type="button" onClick={() => arrangeNodes("all")} disabled={readOnly || allNodes.length < 1} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40" title={t("free_creation_arrange_all")} aria-label={t("free_creation_arrange_all")}><LayoutGrid className="h-4 w-4" aria-hidden /></button>
        <button type="button" onClick={toggleRelations} className={`focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] ${showRelations ? "bg-[var(--color-accent-dim)] text-[var(--color-accent-2)]" : ""}`} title={t(showRelations ? "free_creation_hide_relations" : "free_creation_show_relations")} aria-label={t(showRelations ? "free_creation_hide_relations" : "free_creation_show_relations")}><Link2 className="h-4 w-4" aria-hidden /></button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShortcutsOpen((value) => !value)}
            className={`focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] ${shortcutsOpen ? "bg-[var(--color-accent-dim)] text-[var(--color-accent-2)]" : ""}`}
            title={t("free_creation_shortcuts")}
            aria-label={t("free_creation_shortcuts")}
            aria-expanded={shortcutsOpen}
            aria-haspopup="dialog"
          >
            <Keyboard className="h-4 w-4" aria-hidden />
          </button>
          {shortcutsOpen ? (
            <div className="absolute right-0 top-[calc(100%+8px)] z-[210] w-[min(330px,calc(100vw-32px))] rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] p-3 shadow-2xl" role="dialog" aria-label={t("free_creation_shortcuts")}>
              <h2 className="mb-2 text-xs font-semibold text-[var(--color-text)]">{t("free_creation_shortcuts")}</h2>
              <div className="grid gap-1.5">
                {[
                  [t("free_creation_shortcut_undo"), "Ctrl/Cmd + Z"],
                  [t("free_creation_shortcut_redo"), "Ctrl/Cmd + Y"],
                  [t("free_creation_shortcut_select_all"), "Ctrl/Cmd + A"],
                  [t("free_creation_shortcut_reference"), t("free_creation_shortcut_combo_reference")],
                  [t("free_creation_shortcut_preview"), t("free_creation_shortcut_combo_preview")],
                  [t("free_creation_shortcut_move"), t("free_creation_shortcut_combo_move")],
                  [t("free_creation_shortcut_pan"), t("free_creation_shortcut_combo_pan")],
                  [t("free_creation_shortcut_zoom"), t("free_creation_shortcut_combo_zoom")],
                ].map(([label, shortcut]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-[11px] text-[var(--color-text-2)]">
                    <span>{label}</span>
                    <kbd className="shrink-0 rounded border border-[var(--color-hairline-strong)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">{shortcut}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {hiddenCount ? <button type="button" onClick={() => setShowHidden((value) => !value)} className={`focus-ring grid h-8 min-w-8 place-items-center rounded px-1.5 ${showHidden ? "bg-[var(--color-accent-dim)] text-[var(--color-accent-2)]" : "text-[var(--color-text-muted)]"}`} title={t("free_creation_show_hidden", { count: hiddenCount })} aria-label={t("free_creation_show_hidden", { count: hiddenCount })}>{showHidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}</button> : null}
        {hiddenCount && !readOnly ? <button type="button" onClick={() => restoreNodes([...hiddenIds, ...hiddenUploadIds])} className="focus-ring grid h-8 min-w-8 place-items-center rounded px-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={t("free_creation_restore_all_hidden", { count: hiddenCount })} aria-label={t("free_creation_restore_all_hidden", { count: hiddenCount })}><RotateCcw className="h-4 w-4" aria-hidden /></button> : null}
      </div>

      <CanvasSceneLayer
        camera={{ x: pan.x, y: pan.y, scale }}
        viewport={viewportSize}
        nodes={viewportRenderNodes}
        edges={sceneEdges}
        groups={sceneGroups}
        selectedIds={selectedSet}
        lod={lod}
        showRelations={showRelations}
      />
      <div className="sr-only" aria-hidden>
        {sceneGroups.map((group) => <span key={group.id} data-canvas-group={group.id} />)}
      </div>
      <CanvasMinimap
        label={t("free_creation_minimap")}
        nodes={canvasNodes}
        bounds={contentBounds}
        camera={{ x: pan.x, y: pan.y, scale }}
        viewport={viewportSize}
        onNavigate={(worldX, worldY) => {
          setPan({
            x: viewportSize.width / 2 - worldX * scale,
            y: viewportSize.height / 2 - worldY * scale,
          });
        }}
      />

      <div className="absolute left-0 top-0" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`, transformOrigin: "0 0", transition: viewportAnimating ? "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)" : undefined }}>

        {renderedUploads.map((upload) => {
          const position = positions[upload.reference_id];
          if (!position) return null;
          const selected = selectedSet.has(upload.reference_id);
          const hidden = hiddenUploadSet.has(upload.reference_id);
          const claim: FreeCreationReferenceClaim = {
            type: "upload",
            reference_id: upload.reference_id,
            role: freeCreationUploadRole(upload.media_type),
          };
          return (
               <div role="button" aria-pressed={selected} key={upload.reference_id} ref={(node) => { if (node) nodeRefs.current.set(upload.reference_id, node); else nodeRefs.current.delete(upload.reference_id); }} draggable={false} onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); nativeNodeDragRef.current = true; }} onDragEnd={() => { nativeNodeDragRef.current = false; }} data-canvas-node="true" data-canvas-id={upload.reference_id} tabIndex={0} aria-label={selected ? [upload.original_filename, t("free_creation_selected")].join(", ") : upload.original_filename} onKeyDown={(event) => handleNodeKeyboard(event, upload.reference_id, selected)} className={`absolute overflow-hidden rounded-md border-2 bg-[var(--color-surface-2)] shadow-[0_16px_30px_-18px_oklch(0_0_0_/_0.95)] ${selected ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-dim)]" : "border-[var(--color-hairline-strong)]"} ${hidden ? "opacity-55" : ""}`} style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: UPLOAD_NODE_HEIGHT }} onPointerDown={(event) => { if (event.button === 0 && spacePressed) { beginCanvasPan(event); return; } if (event.button === 0 && (event.ctrlKey || event.metaKey)) { event.preventDefault(); return; } if (event.button === 0 && !event.shiftKey && !isNodeControlTarget(event.target)) { beginUploadDrag(event, upload.reference_id); return; } if (event.button === 0 && !event.shiftKey) publishSelection([upload.reference_id]); else if (event.button === 0 && event.shiftKey) publishSelection(selected ? selectedIds.filter((id) => id !== upload.reference_id) : [...selectedIds, upload.reference_id]); }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onPreview?.({ kind: "upload", upload }); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (readOnly) return; if (!selectedSet.has(upload.reference_id)) publishSelection([upload.reference_id]); const rect = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "upload", nodeId: upload.reference_id, x: Math.min(event.clientX - (rect?.left ?? 0), (rect?.width ?? 260) - 190), y: Math.min(event.clientY - (rect?.top ?? 0), (rect?.height ?? 200) - 150) }); }}>
              <div className="flex h-10 items-center justify-between border-b border-[var(--color-hairline)] px-3 text-xs font-medium text-[var(--color-text-2)]" onPointerDown={(event) => beginUploadDrag(event, upload.reference_id)}><span className="truncate">{upload.original_filename}</span><span className="text-[10px] text-[var(--color-text-muted)]">{t("free_creation_reference")}</span></div>
              {upload.media_type === "audio" ? (
                <div className="block h-[154px] w-full bg-black">
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-4"><AudioLines className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><audio src={uploadMediaUrl(projectName, upload)} preload="none" controls className="w-full" aria-label={upload.original_filename} /></div>
                </div>
              ) : (
                <div role="button" tabIndex={0} className="block h-[154px] w-full bg-black" onClick={(event) => handleReferenceShortcut(event, claim, upload.original_filename)} onKeyDown={(event) => handleReferenceShortcut(event, claim, upload.original_filename)} title={t("free_creation_reference_shortcut")}>
                  {upload.media_type === "image" ? <img src={uploadMediaUrl(projectName, upload)} alt={upload.original_filename} loading="lazy" decoding="async" className="h-full w-full object-contain" /> : upload.media_type === "video" ? (
                    <video
                      data-canvas-media-id={upload.reference_id}
                      src={API.getFreeCreationReferenceProxyUrl(projectName, upload.reference_id)}
                      poster={API.getFreeCreationReferenceCoverUrl(projectName, upload.reference_id)}
                      preload="metadata"
                      muted
                      playsInline
                      className="h-full w-full object-contain"
                      aria-label={upload.original_filename}
                      onLoadedMetadata={(event) => {
                        restoreVideoPlayback(upload.reference_id, event.currentTarget, 0.1);
                      }}
                      onPlay={(event) => rememberVideoPlayback(upload.reference_id, event.currentTarget)}
                      onPause={(event) => rememberVideoPlayback(upload.reference_id, event.currentTarget)}
                      onTimeUpdate={(event) => rememberVideoPlayback(upload.reference_id, event.currentTarget)}
                    />
                  ) : upload.media_type === "text" ? <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-muted)]"><FileText className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><span className="max-w-[90%] truncate text-xs">{t("media_type_text")}</span></div> : <Link2 className="mx-auto mt-16 h-5 w-5 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden />}
                </div>
              )}
              <div className="flex h-11 items-center justify-end px-2"><button type="button" onClick={(event) => { event.stopPropagation(); onReference(claim, upload.original_filename); }} className="focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button></div>
            </div>
          );
        })}

        {renderedCreations.map((creation) => {
          const position = positions[creation.creation_id];
          if (!position) return null;
          const selected = selectedSet.has(creation.creation_id);
          const hidden = hiddenSet.has(creation.creation_id);
          const mediaType = creationMediaType(creation);
          const referenceRole = creationReferenceRole(creation);
          const statusLabel = t(`free_creation_status_${creation.status}`);
          return (
            <div
              key={creation.creation_id}
              ref={(node) => { if (node) nodeRefs.current.set(creation.creation_id, node); else nodeRefs.current.delete(creation.creation_id); }}
              data-canvas-node="true"
              draggable={false}
              onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); nativeNodeDragRef.current = true; }}
              onDragEnd={() => { nativeNodeDragRef.current = false; }}
              data-canvas-id={creation.creation_id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={selected ? `${creation.prompt || t("free_creation")}, ${t("free_creation_selected")}` : creation.prompt || t("free_creation")}
              onKeyDown={(event) => handleNodeKeyboard(event, creation.creation_id, selected)}
              className={`absolute overflow-hidden rounded-md border-2 bg-[var(--color-surface-2)] shadow-[0_16px_30px_-18px_oklch(0_0_0_/_0.95)] ${selected ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-dim)]" : "border-[var(--color-hairline-strong)]"} ${hidden ? "opacity-55" : ""}`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              onPointerDown={(event) => {
                if (event.button === 0 && spacePressed) {
                  beginCanvasPan(event);
                  return;
                }
                if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  return;
                }
                if (event.button === 0 && !event.shiftKey && !isNodeControlTarget(event.target)) {
                  beginNodeDrag(event, creation.creation_id);
                  return;
                }
                if (event.button === 0 && !event.shiftKey) publishSelection([creation.creation_id]);
                else if (event.button === 0 && event.shiftKey) publishSelection(selected ? selectedIds.filter((id) => id !== creation.creation_id) : [...selectedIds, creation.creation_id]);
              }}
              onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); if (creation.status === "succeeded" && creation.media_path) onPreview?.({ kind: "creation", creation }); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (readOnly) return; if (!selectedSet.has(creation.creation_id)) publishSelection([creation.creation_id]); const rect = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "creation", nodeId: creation.creation_id, x: Math.min(event.clientX - (rect?.left ?? 0), (rect?.width ?? 260) - 190), y: Math.min(event.clientY - (rect?.top ?? 0), (rect?.height ?? 200) - 150) }); }}
            >
              <div className="flex h-10 items-center justify-between gap-2 border-b border-[var(--color-hairline)] px-3" onPointerDown={(event) => beginNodeDrag(event, creation.creation_id)}>
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-semibold text-[var(--color-text)]"><span className="truncate">{t(`free_creation_${creation.output_type}`)}</span>{creation.sequence_index !== null && creation.sequence_index !== undefined ? <span className="shrink-0 rounded bg-[var(--color-accent-dim)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-accent-2)]">{t("free_creation_storyboard_shot_badge", { index: creation.sequence_index + 1 })}</span> : null}</span>
                <div className="flex items-center gap-1"><span className="text-[10px] text-[var(--color-text-muted)]">{statusLabel}</span>{!readOnly ? <button type="button" className="focus-ring grid h-7 w-7 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)]" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); publishSelection([creation.creation_id]); const rect = event.currentTarget.getBoundingClientRect(); const surface = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "creation", nodeId: creation.creation_id, x: rect.right - (surface?.left ?? 0), y: rect.bottom - (surface?.top ?? 0) }); }} aria-label={t("free_creation_more_actions")} title={t("free_creation_more_actions")}><MoreHorizontal className="h-4 w-4" aria-hidden /></button> : null}</div>
              </div>
              <div role="button" tabIndex={creation.status === "succeeded" && creation.media_path ? 0 : -1} className="h-[174px] bg-black" onClick={(event) => { if (creation.status === "succeeded" && creation.media_path) handleReferenceShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: referenceRole }, creation.prompt || t("free_creation")); }} onKeyDown={(event) => { if (creation.status === "succeeded" && creation.media_path) handleReferenceShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: referenceRole }, creation.prompt || t("free_creation")); }} title={creation.status === "succeeded" && creation.media_path ? t("free_creation_reference_shortcut") : undefined}>
                {creation.status === "succeeded" && creation.media_path ? mediaType === "video" ? (
                  <video data-canvas-media-id={creation.creation_id} className="h-full w-full object-contain" src={API.getFreeCreationProxyUrl(projectName, creation.creation_id, creation.version)} poster={API.getFreeCreationCoverUrl(projectName, creation.creation_id, creation.version)} preload="metadata" muted playsInline aria-label={creation.prompt ?? creation.creation_id} controls onLoadedMetadata={(event) => restoreVideoPlayback(creation.creation_id, event.currentTarget)} onPlay={(event) => rememberVideoPlayback(creation.creation_id, event.currentTarget)} onPause={(event) => rememberVideoPlayback(creation.creation_id, event.currentTarget)} onTimeUpdate={(event) => rememberVideoPlayback(creation.creation_id, event.currentTarget)} />
                ) : mediaType === "audio" ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-4"><AudioLines className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><audio className="w-full" src={API.getFreeCreationMediaUrl(projectName, creation.creation_id, creation.version)} preload="none" aria-label={creation.prompt ?? creation.creation_id} controls /></div>
                ) : <img className="h-full w-full object-contain" src={API.getFreeCreationMediaUrl(projectName, creation.creation_id, creation.version)} alt={creation.prompt ?? creation.creation_id} loading="lazy" decoding="async" /> : <div className="flex h-full items-center justify-center px-3 text-center text-xs leading-5 text-[var(--color-text-muted)]"><span className="line-clamp-5">{creation.status === "failed" ? creation.error || t("free_creation_failed") : statusLabel}</span></div>}
              </div>
              <div className="h-[66px] px-3 py-2"><p className="line-clamp-2 text-xs leading-5 text-[var(--color-text-2)]">{creation.prompt || t("free_creation_prompt")}</p>{subtitleCountByCreation.get(creation.creation_id) ? <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-[var(--color-accent-2)]"><Captions className="h-3 w-3" aria-hidden />{t("free_creation_subtitle_badge", { count: subtitleCountByCreation.get(creation.creation_id) })}</span> : null}</div>
              {!readOnly ? <div className="flex h-10 items-center justify-end gap-0.5 border-t border-[var(--color-hairline)] px-2">{renderActions(creation)}</div> : null}
            </div>
          );
        })}

        {subtitleTracks.map((track, index) => {
          if (!domNodeIds.has(`subtitle:${track.subtitle_id}`)) return null;
          const parent = positions[track.creation_id];
          if (!parent || hiddenSet.has(track.creation_id)) return null;
          const siblingIndex = subtitleTracks.slice(0, index).filter((item) => item.creation_id === track.creation_id).length;
          const position = subtitlePosition(parent, siblingIndex);
          const cuePreview = track.cues.slice(0, 3);
          return (
            <button
              type="button"
              key={`subtitle-node-${track.subtitle_id}`}
              data-canvas-node="true"
              className="absolute overflow-hidden rounded-md border border-dashed border-[var(--color-accent-2)]/70 bg-[var(--color-surface-2)] text-left shadow-[0_16px_30px_-18px_oklch(0_0_0_/_0.95)]"
              style={{ left: position.x, top: position.y, width: SUBTITLE_NODE_WIDTH, minHeight: SUBTITLE_NODE_HEIGHT }}
              onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onClick={() => onEditSubtitle?.(track.creation_id)}
              aria-label={t("free_creation_subtitle_title")}
            >
              <div className="flex h-10 items-center gap-2 border-b border-[var(--color-hairline)] px-3 text-xs font-semibold text-[var(--color-text)]">
                <Captions className="h-3.5 w-3.5 text-[var(--color-accent-2)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t("free_creation_subtitle_title")}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{t("free_creation_subtitle_badge", { count: track.cues.length })}</span>
              </div>
              <div className="space-y-1 px-3 py-2">
                {cuePreview.length ? cuePreview.map((cue, cueIndex) => (
                  <p key={`${track.subtitle_id}-${cueIndex}`} className="line-clamp-2 text-[11px] leading-4 text-[var(--color-text-2)]">{cue.text}</p>
                )) : <p className="text-[11px] text-[var(--color-text-muted)]">{t("free_creation_subtitle_action")}</p>}
              </div>
              <div className="border-t border-[var(--color-hairline)] px-3 py-2 text-[10px] text-[var(--color-text-muted)]">{t("free_creation_subtitle_action")}</div>
            </button>
          );
        })}
      </div>

      {marquee ? <div className="pointer-events-none fixed z-30 border border-[var(--color-accent)] bg-[var(--color-accent-dim)]" style={{ left: Math.min(marquee.start.x, marquee.current.x), top: Math.min(marquee.start.y, marquee.current.y), width: Math.abs(marquee.current.x - marquee.start.x), height: Math.abs(marquee.current.y - marquee.start.y) }} /> : null}

      {(activeContextCreation || activeContextUpload) && contextMenu ? (
        <div ref={contextMenuRef} tabIndex={-1} className="absolute z-[200] min-w-44 rounded-md border border-[var(--color-hairline)] p-1 shadow-2xl" style={{ left: Math.max(4, contextMenu.x), top: Math.max(4, contextMenu.y), background: "var(--color-surface-2)", opacity: 1 }} role="menu" aria-label={t("free_creation_more_actions")}>
          {activeContextCreation ? <>
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => contextSelectionIsHidden ? restoreNodes(contextSelectionIds) : hideNodes(contextSelectionIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]">{contextSelectionIsHidden ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}{t(contextSelectionIsHidden ? "free_creation_restore" : "free_creation_hide")}</button> : null}
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => arrangeNodes("selected")} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />{t("free_creation_arrange_selected")}</button> : null}
            {canGroupSelection ? <button type="button" role="menuitem" onClick={groupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Group className="h-3.5 w-3.5" aria-hidden />{t("free_creation_group_selected")}</button> : null}
            {activeContextGroup ? <button type="button" role="menuitem" onClick={ungroupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Ungroup className="h-3.5 w-3.5" aria-hidden />{t("free_creation_ungroup")}</button> : null}
            {showBatchDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes(deletableCreationIds, selectedUploadIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete_selected", { count: contextSelectionIds.length })}</button> : null}
            {selectedReferences.length >= 2 && selectedSet.has(activeContextCreation.creation_id) ? <button type="button" role="menuitem" onClick={() => { if (onReferences) onReferences(selectedReferences); else selectedReferences.forEach(({ claim, label }) => onReference(claim, label)); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_selected_references", { count: selectedReferences.length })}</button> : null}
            {onMerge && selectedMergeIds.length >= 2 && selectedMergeIds.includes(activeContextCreation.creation_id) ? <button type="button" role="menuitem" onClick={() => { onMerge(selectedMergeIds); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Clapperboard className="h-3.5 w-3.5" aria-hidden />{t("free_creation_merge_selected")}</button> : null}
            {onCompositeAudio && audioCompositePair ? <button type="button" role="menuitem" onClick={() => { onCompositeAudio(audioCompositePair.videoId, audioCompositePair.audioId); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><AudioLines className="h-3.5 w-3.5" aria-hidden />{t("free_creation_composite_audio")}</button> : null}
            {showSingleCreationDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes([activeContextCreation.creation_id], [])} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete")}</button> : null}
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path && creationMediaType(activeContextCreation) === "image" ? <button type="button" role="menuitem" onClick={() => { onEdit(activeContextCreation.creation_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Pencil className="h-3.5 w-3.5" aria-hidden />{t("free_creation_use_as_parent")}</button> : null}
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path ? <button type="button" role="menuitem" onClick={() => { onPreview?.({ kind: "creation", creation: activeContextCreation }); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_preview")}</button> : null}
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path ? <button type="button" role="menuitem" onClick={() => { onReference({ type: "creation", creation_id: activeContextCreation.creation_id, version: activeContextCreation.version, role: creationReferenceRole(activeContextCreation) }, activeContextCreation.prompt || t("free_creation")); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button> : null}
            {contextSelectionIds.length < 2 ? (hiddenSet.has(activeContextCreation.creation_id) ? <button type="button" role="menuitem" onClick={() => restoreCreation(activeContextCreation.creation_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_restore")}</button> : <button type="button" role="menuitem" onClick={() => hideCreation(activeContextCreation.creation_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><EyeOff className="h-3.5 w-3.5" aria-hidden />{t("free_creation_hide")}</button>) : null}
          </> : null}
          {activeContextUpload ? <>
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => contextSelectionIsHidden ? restoreNodes(contextSelectionIds) : hideNodes(contextSelectionIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]">{contextSelectionIsHidden ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}{t(contextSelectionIsHidden ? "free_creation_restore" : "free_creation_hide")}</button> : null}
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => arrangeNodes("selected")} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />{t("free_creation_arrange_selected")}</button> : null}
            {canGroupSelection ? <button type="button" role="menuitem" onClick={groupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Group className="h-3.5 w-3.5" aria-hidden />{t("free_creation_group_selected")}</button> : null}
            {activeContextGroup ? <button type="button" role="menuitem" onClick={ungroupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Ungroup className="h-3.5 w-3.5" aria-hidden />{t("free_creation_ungroup")}</button> : null}
            {showBatchDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes(deletableCreationIds, selectedUploadIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete_selected", { count: contextSelectionIds.length })}</button> : null}
            {selectedReferences.length >= 2 && selectedSet.has(activeContextUpload.reference_id) ? <button type="button" role="menuitem" onClick={() => { if (onReferences) onReferences(selectedReferences); else selectedReferences.forEach(({ claim, label }) => onReference(claim, label)); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_selected_references", { count: selectedReferences.length })}</button> : null}
            <button type="button" role="menuitem" onClick={() => { onPreview?.({ kind: "upload", upload: activeContextUpload }); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_preview")}</button>
            <button type="button" role="menuitem" onClick={() => { onReference({ type: "upload", reference_id: activeContextUpload.reference_id, role: freeCreationUploadRole(activeContextUpload.media_type) }, activeContextUpload.original_filename); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button>
            {contextSelectionIds.length < 2 && (hiddenUploadSet.has(activeContextUpload.reference_id) ? <button type="button" role="menuitem" onClick={() => restoreUpload(activeContextUpload.reference_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_restore")}</button> : <button type="button" role="menuitem" onClick={() => hideUpload(activeContextUpload.reference_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><EyeOff className="h-3.5 w-3.5" aria-hidden />{t("free_creation_hide")}</button>)}
            {showSingleUploadDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes([], [activeContextUpload.reference_id])} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete")}</button> : null}
          </> : null}
        </div>
      ) : null}

      {creations.length === 0 && uploads.length === 0 ? <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 pb-44 text-center"><div className="max-w-sm"><LocateFixed className="mx-auto mb-3 h-5 w-5 text-[var(--color-text-muted)]" aria-hidden /><p className="text-sm text-[var(--color-text-muted)]">{t("free_creation_empty")}</p></div></div> : null}
    </div>
  );
}
