import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  ArrowUpRight,
  Captions,
  Clapperboard,
  Download,
  Eye,
  EyeOff,
  Group,
  Keyboard,
  LayoutGrid,
  Link2,
  Loader2,
  LocateFixed,
  Magnet,
  Maximize2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  ScanSearch,
  Trash2,
  Ungroup,
  UploadCloud,
  Waypoints,
  ZoomIn,
  ZoomOut,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import type { FreeCreationPreviewTarget } from "@/components/canvas/FreeCreationPreviewDialog";
import {
  CanvasSceneLayer,
  type CanvasRenderNode,
  type CanvasRenderRelation,
} from "@/components/canvas/free-creation/CanvasSceneLayer";
import {
  createCanvasRelationGraph,
  type CanvasRelation,
  type CanvasRelationMode,
  type CanvasRelationRole,
} from "@/components/canvas/free-creation/canvas-relations";
import { CanvasMediaThumbnail } from "@/components/canvas/free-creation/CanvasMediaThumbnail";
import {
  CanvasNodeLabel,
  CanvasNodeStatusDot,
} from "@/components/canvas/free-creation/CanvasNodeLabel";
import {
  CanvasSpatialIndex,
  computeContentBounds,
  fitCameraToBounds,
  snapCanvasPositions,
  selectCanvasLod,
  viewportWorldRect,
  type CanvasSnapGuide,
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
  onContinue?: (creationId: string) => void;
  onPreview?: (target: FreeCreationPreviewTarget) => void;
  onEditSubtitle?: (creationId: string) => void;
  onRenderSubtitle?: (subtitleId: string) => void;
  onDeleteSubtitle?: (subtitleId: string) => void;
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
  bottomInset?: number;
}

type PointerOperation =
  | { kind: "pan"; pointerId: number; start: Point; origin: Point }
  | { kind: "marquee"; pointerId: number; start: Point; current: Point; additive: boolean }
  | {
    kind: "nodes";
    pointerId: number;
    pointerType: string;
    start: Point;
    origins: Record<string, Point>;
    selection: string[];
    active: boolean;
    touchReady: boolean;
  };

interface ContextMenuState {
  nodeId: string;
  kind: "creation" | "upload" | "subtitle";
  x: number;
  y: number;
}

const NODE_WIDTH = 272;
const NODE_HEIGHT = 322;
const UPLOAD_NODE_HEIGHT = 238;
const NODE_GAP_X = 72;
const NODE_GAP_Y = 56;
const MIN_SCALE = 0.4;
const MAX_SCALE = 1.8;
const PLACEMENT_PADDING = 24;
const SUBTITLE_NODE_WIDTH = 236;
const SUBTITLE_NODE_HEIGHT = 166;
const SUBTITLE_NODE_GAP = 32;
const DESKTOP_DRAG_THRESHOLD = 4;
const TOUCH_DRAG_THRESHOLD = 8;
const TOUCH_DRAG_HOLD_MS = 240;
const RELATION_RENDER_LIMIT = 1_000;
const CANVAS_VIEW_PREFERENCES_KEY = "matrixspooll:freeCreationCanvasView";
const CANVAS_VIEW_PREFERENCES_VERSION = 2;
const RELATION_ROLE_KEYS: Record<CanvasRelationRole, string> = {
  first_frame: "free_creation_relation_role_first_frame",
  last_frame: "free_creation_relation_role_last_frame",
  reference_image: "free_creation_relation_role_reference_image",
  reference_video: "free_creation_relation_role_reference_video",
  reference_audio: "free_creation_relation_role_reference_audio",
  prompt_context: "free_creation_relation_role_prompt_context",
  edit_source: "free_creation_relation_role_edit_source",
  subtitle_source: "free_creation_relation_role_subtitle_source",
  subtitle_render: "free_creation_relation_role_subtitle_render",
  reference: "free_creation_relation_role_reference",
};

function canvasViewPreferenceKey(projectName: string): string {
  return `${CANVAS_VIEW_PREFERENCES_KEY}:${encodeURIComponent(projectName)}`;
}

function readRelationMode(projectName: string): CanvasRelationMode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(canvasViewPreferenceKey(projectName));
    if (!raw) return null;
    const preference = JSON.parse(raw) as { relationMode?: unknown; version?: unknown };
    const mode = preference.relationMode;
    if (mode === "selected" && preference.version !== CANVAS_VIEW_PREFERENCES_VERSION) return "all";
    return mode === "selected" || mode === "all" || mode === "off" ? mode : null;
  } catch {
    return null;
  }
}

function writeRelationMode(projectName: string, relationMode: CanvasRelationMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(canvasViewPreferenceKey(projectName), JSON.stringify({
      relationMode,
      version: CANVAS_VIEW_PREFERENCES_VERSION,
    }));
  } catch {
    // View preferences remain in memory when browser storage is unavailable.
  }
}

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

export function parseCanvasAspectRatio(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : null;
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function canvasNodeHeightForAspectRatio(aspectRatio: number | null, fallback: number): number {
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return fallback;
  return Math.round(NODE_WIDTH / aspectRatio);
}

function subtitlePosition(parent: Point, index: number): Point {
  return {
    x: parent.x + NODE_WIDTH + NODE_GAP_X,
    y: parent.y + index * (SUBTITLE_NODE_HEIGHT + SUBTITLE_NODE_GAP),
  };
}

function derivedCreationPosition(
  creation: FreeCreation | undefined,
  positions: Readonly<Record<string, Point>>,
): Point | undefined {
  if (!creation) return undefined;
  if (creation.effective_mode === "subtitle_burn" && creation.subtitle_id) {
    const subtitle = positions[creation.subtitle_id];
    if (subtitle) return { x: subtitle.x + NODE_WIDTH + NODE_GAP_X, y: subtitle.y };
  }
  if (creation.effective_mode !== "audio_composite") return undefined;
  const sources = (creation.reference_claims ?? [])
    .flatMap((claim) => claim.type === "creation" && positions[claim.creation_id]
      ? [positions[claim.creation_id]]
      : []);
  if (!sources.length) return undefined;
  return {
    x: Math.max(...sources.map((point) => point.x)) + NODE_WIDTH + NODE_GAP_X,
    y: Math.round(sources.reduce((sum, point) => sum + point.y, 0) / sources.length),
  };
}

function nodeBox(
  nodeId: string,
  positions: Record<string, Point>,
  uploadsById: ReadonlyMap<string, FreeCreationUpload>,
  nodeHeights: Readonly<Record<string, number>> = {},
): CanvasNodeBox | null {
  const position = positions[nodeId];
  if (!position) return null;
  return {
    x: position.x,
    y: position.y,
    width: NODE_WIDTH,
    height: nodeHeights[nodeId] ?? (uploadsById.has(nodeId) ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT),
  };
}

export function buildCanvasDependencyEdges(
  creations: FreeCreation[],
  subtitleTracks: FreeSubtitleTrack[] = [],
): CanvasDependencyEdge[] {
  return createCanvasRelationGraph(creations, subtitleTracks).relations.map(({ sourceId, targetId }) => ({
    sourceId,
    targetId,
  }));
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
  nodeHeights: Readonly<Record<string, number>> = {},
  subtitleTracks: FreeSubtitleTrack[] = [],
): Record<string, Point> {
  const ids = [...new Set(nodeIds)];
  if (!ids.length) return { ...currentPositions };
  const idSet = new Set(ids);
  const edges = buildCanvasDependencyEdges(creations, subtitleTracks)
    .filter((edge) => idSet.has(edge.sourceId) && idSet.has(edge.targetId));
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
    let rowY = minY;
    for (let rowStart = 0; rowStart < orderedIds.length; rowStart += columnCount) {
      const rowIds = orderedIds.slice(rowStart, rowStart + columnCount);
      const rowHeight = Math.max(...rowIds.map((id) => (
        nodeHeights[id] ?? (uploadsById.has(id) ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT)
      )));
      rowIds.forEach((id, column) => {
        next[id] = { x: minX + column * (NODE_WIDTH + NODE_GAP_X), y: rowY };
      });
      rowY += rowHeight + NODE_GAP_Y;
    }
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
    let layerY = minY;
    layerIds.forEach((id) => {
      const height = nodeHeights[id] ?? (uploadsById.has(id) ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT);
      next[id] = {
        x: minX + layer * (NODE_WIDTH + NODE_GAP_X + 96),
        y: layerY,
      };
      layerY += height + NODE_GAP_Y;
    });
  }
  return next;
}

function overlapsPosition(
  candidate: Point,
  candidateHeight: number,
  occupied: Point[],
  occupiedHeights: readonly number[],
): boolean {
  return occupied.some((position, index) => (
    candidate.x < position.x + NODE_WIDTH + PLACEMENT_PADDING
    && candidate.x + NODE_WIDTH + PLACEMENT_PADDING > position.x
    && candidate.y < position.y + (occupiedHeights[index] ?? NODE_HEIGHT) + PLACEMENT_PADDING
    && candidate.y + candidateHeight + PLACEMENT_PADDING > position.y
  ));
}

function isWithinBounds(point: Point, bounds: CanvasBounds, height: number): boolean {
  return point.x >= bounds.left
    && point.y >= bounds.top
    && point.x + NODE_WIDTH <= bounds.right
    && point.y + height <= bounds.bottom;
}

interface CanvasPlacementOptions {
  candidateHeight?: number;
  occupiedHeights?: readonly number[];
}

export function findOpenCanvasPosition(
  occupied: Point[],
  bounds: CanvasBounds,
  preferred?: Point,
  options: CanvasPlacementOptions = {},
): { position: Point; visible: boolean } {
  const candidateHeight = options.candidateHeight ?? NODE_HEIGHT;
  const occupiedHeights = options.occupiedHeights ?? [];
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

  const visible = candidates.find((candidate) => (
    isWithinBounds(candidate, bounds, candidateHeight)
    && !overlapsPosition(candidate, candidateHeight, occupied, occupiedHeights)
  ));
  if (visible) return { position: visible, visible: true };
  const available = candidates.find((candidate) => !overlapsPosition(candidate, candidateHeight, occupied, occupiedHeights));
  if (available) return { position: available, visible: false };
  let index = occupied.length;
  while (overlapsPosition(initialPosition(index), candidateHeight, occupied, occupiedHeights)) index += 1;
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
  return target instanceof Element && Boolean(target.closest(
    "button, a, input, textarea, select, audio, [role='button']:not([data-canvas-node='true'])",
  ));
}

function uploadMediaUrl(projectName: string, upload: FreeCreationUpload): string {
  return upload.url ?? API.getFileUrl(projectName, upload.path);
}

function creationLabel(creation: FreeCreation, fallback: string): string {
  const prompt = creation.prompt?.trim();
  if (prompt) return prompt;
  const filename = creation.media_path?.split(/[\\/]/).at(-1);
  return filename || fallback;
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
  onContinue,
  onPreview,
  onEditSubtitle,
  onRenderSubtitle,
  onDeleteSubtitle,
  onDeleteItems,
  onDeleteCreations,
  onRestoreCreations,
  onDeleteUpload,
  onRestoreUpload,
  onMerge,
  onCompositeAudio,
  onUploadFiles,
  bottomInset = 320,
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
  const hasStoredRelationModeRef = useRef(readRelationMode(projectName) !== null);
  const mediaPlaybackRef = useRef(new Map<string, { currentTime: number; playing: boolean }>());
  const pointerFrameRef = useRef<number | null>(null);
  const touchHoldTimerRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ pointerId: number; clientX: number; clientY: number; altKey: boolean } | null>(null);
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
  const [canvasLoadError, setCanvasLoadError] = useState(false);
  const [canvasReloadToken, setCanvasReloadToken] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapGuides, setSnapGuides] = useState<CanvasSnapGuide[]>([]);
  const [groups, setGroups] = useState<CanvasGroup[]>([]);
  const [showRelations, setShowRelations] = useState(true);
  const [relationMode, setRelationMode] = useState<CanvasRelationMode>(() => readRelationMode(projectName) ?? "all");
  const [relationMenuOpen, setRelationMenuOpen] = useState(false);
  const [relationPanelNodeId, setRelationPanelNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [viewportAnimating, setViewportAnimating] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 720 });
  const [lod, setLod] = useState<CanvasLod>("detail");
  const [mediaAspectRatios, setMediaAspectRatios] = useState<Record<string, number>>({});
  const camera = useMemo(() => ({ x: pan.x, y: pan.y, scale }), [pan.x, pan.y, scale]);
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

  const rememberMediaDimensions = useCallback((id: string, width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const aspectRatio = width / height;
    setMediaAspectRatios((current) => (
      Math.abs((current[id] ?? 0) - aspectRatio) < 0.001
        ? current
        : { ...current, [id]: aspectRatio }
    ));
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
  const subtitleIds = useMemo(
    () => new Set(subtitleTracks.map((track) => track.subtitle_id)),
    [subtitleTracks],
  );
  const relationGraph = useMemo(
    () => createCanvasRelationGraph(creations, subtitleTracks),
    [creations, subtitleTracks],
  );
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
  const nodeHeights = useMemo(() => {
    const heights: Record<string, number> = {};
    for (const upload of uploads) {
      const usesMediaRatio = upload.media_type === "image" || upload.media_type === "video";
      heights[upload.reference_id] = usesMediaRatio
        ? canvasNodeHeightForAspectRatio(mediaAspectRatios[upload.reference_id] ?? null, UPLOAD_NODE_HEIGHT)
        : UPLOAD_NODE_HEIGHT;
    }
    for (const creation of creations) {
      const mediaType = creationMediaType(creation);
      const usesMediaRatio = mediaType === "image" || mediaType === "video";
      const aspectRatio = mediaAspectRatios[creation.creation_id] ?? parseCanvasAspectRatio(creation.aspect_ratio);
      heights[creation.creation_id] = usesMediaRatio
        ? canvasNodeHeightForAspectRatio(aspectRatio, NODE_HEIGHT)
        : NODE_HEIGHT;
    }
    for (const track of subtitleTracks) heights[track.subtitle_id] = SUBTITLE_NODE_HEIGHT;
    return heights;
  }, [creations, mediaAspectRatios, subtitleTracks, uploads]);
  const allNodes = useMemo(
    () => [
      ...uploads.map((upload) => ({ id: upload.reference_id, kind: "upload" as const })),
      ...orderedCreations
        .filter((creation) => creation.effective_mode !== "subtitle_burn")
        .map((creation) => ({ id: creation.creation_id, kind: "creation" as const })),
      ...subtitleTracks
        .filter((track) => creationsById.has(track.creation_id))
        .map((track) => ({ id: track.subtitle_id, kind: "subtitle" as const })),
      ...orderedCreations
        .filter((creation) => creation.effective_mode === "subtitle_burn")
        .map((creation) => ({ id: creation.creation_id, kind: "creation" as const })),
    ],
    [creationsById, orderedCreations, subtitleTracks, uploads],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const activeRelationIds = useMemo<ReadonlySet<string>>(() => {
    if (selectedSet.size) return selectedSet;
    return hoveredNodeId ? new Set([hoveredNodeId]) : new Set();
  }, [hoveredNodeId, selectedSet]);
  const draggingSet = useMemo(() => new Set(draggingIds), [draggingIds]);
  const groupByMember = useMemo(() => {
    const result = new Map<string, CanvasGroup>();
    for (const group of groups) {
      for (const memberId of group.member_ids) result.set(memberId, group);
    }
    return result;
  }, [groups]);
  const groupFrames = useMemo<CanvasGroupFrame[]>(() => groups.flatMap((group, index) => {
    const members = group.member_ids
      .filter((memberId) => !hiddenSet.has(memberId) && !hiddenUploadSet.has(memberId))
      .map((memberId) => nodeBox(memberId, positions, uploadsById, nodeHeights))
      .filter((box): box is CanvasNodeBox => Boolean(box));
    if (members.length < 2) return [];
    const padding = 22;
    const labelHeight = 26;
    const left = Math.min(...members.map((box) => box.x)) - padding;
    const top = Math.min(...members.map((box) => box.y)) - padding - labelHeight;
    const right = Math.max(...members.map((box) => box.x + box.width)) + padding;
    const bottom = Math.max(...members.map((box) => box.y + box.height)) + padding;
    return [{ groupId: group.group_id, labelIndex: index + 1, x: left, y: top, width: right - left, height: bottom - top }];
  }), [groups, hiddenSet, hiddenUploadSet, nodeHeights, positions, uploadsById]);
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
        maxY: position.y + (nodeHeights[upload.reference_id] ?? UPLOAD_NODE_HEIGHT),
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
        maxY: position.y + (nodeHeights[creation.creation_id] ?? NODE_HEIGHT),
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
    ...subtitleTracks.flatMap((track) => {
      if (!showHidden && hiddenSet.has(track.subtitle_id)) return [];
      const position = positions[track.subtitle_id];
      if (!position) return [];
      return [{
        id: track.subtitle_id,
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
  ], [hiddenSet, nodeHeights, positions, projectName, showHidden, subtitleTracks, visibleCreations, visibleUploads]);
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
  const viewportRelationNodeIds = useMemo(
    () => new Set(viewportRenderNodes.map((node) => node.id)),
    [viewportRenderNodes],
  );
  const visibleRelationQuery = useMemo(() => relationGraph.query({
    mode: relationMode,
    selectedIds: activeRelationIds,
    visibleIds: viewportRelationNodeIds,
    maxRelations: RELATION_RENDER_LIMIT,
  }), [activeRelationIds, relationGraph, relationMode, viewportRelationNodeIds]);
  const sceneRelations = useMemo<CanvasRenderRelation[]>(() => visibleRelationQuery.relations.map((relation) => ({
    id: relation.id,
    sourceId: relation.sourceId,
    targetId: relation.targetId,
    active: relationMode === "selected"
      || activeRelationIds.has(relation.sourceId)
      || activeRelationIds.has(relation.targetId),
  })), [activeRelationIds, relationMode, visibleRelationQuery.relations]);
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
    const mergeIds = selectedIds.filter((id) => {
      const creation = creationsById.get(id);
      if (creation) {
        return creation.status === "succeeded"
          && Boolean(creation.media_path)
          && creationMediaType(creation) === "video";
      }
      return uploadsById.get(id)?.media_type === "video";
    });
    return mergeIds.length === selectedIds.length ? mergeIds : [];
  }, [creationsById, selectedIds, uploadsById]);
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

  const relationNodeLabel = useCallback((nodeId: string): string | null => {
    const creation = creationsById.get(nodeId);
    if (creation) return creationLabel(creation, t(`free_creation_${creation.output_type}`));
    const subtitle = subtitleTracks.find((track) => track.subtitle_id === nodeId);
    if (subtitle) return subtitle.cues[0]?.text || t("free_creation_subtitle_title");
    return uploadsById.get(nodeId)?.original_filename ?? null;
  }, [creationsById, subtitleTracks, t, uploadsById]);

  const relationPanelData = useMemo(() => {
    if (!relationPanelNodeId) return null;
    const label = relationNodeLabel(relationPanelNodeId);
    if (!label) return null;
    return {
      id: relationPanelNodeId,
      label,
      upstream: relationGraph.upstream(relationPanelNodeId),
      downstream: relationGraph.downstream(relationPanelNodeId),
    };
  }, [relationGraph, relationNodeLabel, relationPanelNodeId]);

  const changeRelationMode = useCallback((mode: CanvasRelationMode) => {
    setRelationMode(mode);
    writeRelationMode(projectName, mode);
    setRelationMenuOpen(false);
  }, [projectName]);

  const publishSelection = useCallback((ids: string[]) => {
    setSelectedIds(ids);
    const selectedCreations = creations.filter(
      (item) => ids.includes(item.creation_id) && item.status === "succeeded" && Boolean(item.media_path),
    );
    const requestIds = new Set(selectedCreations.map((item) => item.request_id).filter(Boolean));
    const selectedVideoIds = ids.filter((id) => {
      const creation = creations.find((item) => item.creation_id === id);
      if (creation) {
        return creation.status === "succeeded"
          && Boolean(creation.media_path)
          && creationMediaType(creation) === "video";
      }
      return uploads.find((item) => item.reference_id === id)?.media_type === "video";
    });
    useFreeCreationStore.getState().setSelection(
      selectedCreations.map((item) => item.creation_id),
      requestIds.size === 1 ? [...requestIds][0] ?? null : null,
      selectedVideoIds,
    );
  }, [creations, uploads]);

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
        setCanvasLoadError(false);
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
        setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, canvas.viewport.scale)));
        setHiddenIds(shared.hiddenCreationIds);
        setHiddenUploadIds(shared.hiddenReferenceIds);
        setGroups(shared.groups);
        setShowRelations(shared.showRelations);
        if (!hasStoredRelationModeRef.current) {
          const migratedMode: CanvasRelationMode = shared.showRelations ? "all" : "off";
          setRelationMode(migratedMode);
          writeRelationMode(projectName, migratedMode);
          hasStoredRelationModeRef.current = true;
        }
        revisionRef.current = canvas.revision;
        nodeRevisionsRef.current = canvas.node_revisions ?? {};
        lastCanvasEventSequenceRef.current = useFreeCreationStore.getState().canvasEvents.at(-1)?.sequence ?? 0;
        hydratedRef.current = true;
        setHydratedProject(projectName);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        hydratedRef.current = false;
        setHydratedProject(null);
        setCanvasLoadError(true);
      });
    return () => controller.abort();
  }, [canvasReloadToken, projectName]);

  useEffect(() => () => {
    disposedRef.current = true;
    if (viewportAnimationTimerRef.current !== null) window.clearTimeout(viewportAnimationTimerRef.current);
    if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current);
    if (touchHoldTimerRef.current !== null) window.clearTimeout(touchHoldTimerRef.current);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
  }, []);

  const visiblePlacementBounds = useCallback((): CanvasBounds => {
    const surface = surfaceRef.current;
    const width = surface?.clientWidth || 1280;
    const height = surface?.clientHeight || 720;
    const leftInset = width >= 900 ? 420 : 24;
    const safeBottomInset = height >= 620 ? bottomInset : Math.min(bottomInset, 80);
    return {
      left: (leftInset - pan.x) / scale,
      top: (64 - pan.y) / scale,
      right: (width - 24 - pan.x) / scale,
      bottom: (height - safeBottomInset - pan.y) / scale,
    };
  }, [bottomInset, pan.x, pan.y, scale]);

  const arrangeNodes = useCallback((scope: "all" | "selected") => {
    if (readOnly) return;
    const visibleIds = [
      ...visibleUploads.map((upload) => upload.reference_id),
      ...subtitleTracks
        .filter((track) => showHidden || !hiddenSet.has(track.subtitle_id))
        .map((track) => track.subtitle_id),
      ...visibleCreations.map((creation) => creation.creation_id),
    ];
    const visibleSet = new Set(visibleIds);
    const targetIds = scope === "selected"
      ? selectedIds.filter((id) => visibleSet.has(id))
      : visibleIds;
    if (targetIds.length < (scope === "selected" ? 2 : 1)) return;
    const next = arrangeCanvasNodes(
      targetIds,
      positionsRef.current,
      creations,
      uploads,
      nodeHeights,
      subtitleTracks,
    );
    const changed = targetIds.some((id) => {
      const current = positionsRef.current[id];
      const arranged = next[id];
      return current?.x !== arranged?.x || current?.y !== arranged?.y;
    });
    if (!changed) return;
    const before = captureHistoryState();
    commitHistoryState(before, { ...before, positions: { ...before.positions, ...next } });
    setContextMenu(null);
  }, [captureHistoryState, commitHistoryState, creations, hiddenSet, nodeHeights, readOnly, selectedIds, showHidden, subtitleTracks, uploads, visibleCreations, visibleUploads]);

  const fitView = useCallback((scope: "all" | "selected") => {
    const bounds = scope === "selected" ? selectedBounds : contentBounds;
    if (!bounds) return;
    const availableViewport = {
      width: viewportSize.width,
      height: Math.max(220, viewportSize.height - bottomInset),
    };
    const camera = fitCameraToBounds(bounds, availableViewport, {
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      padding: 72,
    });
    setViewportAnimating(true);
    setPan({ x: camera.x, y: camera.y });
    setScale(camera.scale);
    if (viewportAnimationTimerRef.current !== null) window.clearTimeout(viewportAnimationTimerRef.current);
    viewportAnimationTimerRef.current = window.setTimeout(() => setViewportAnimating(false), 240);
  }, [bottomInset, contentBounds, selectedBounds, viewportSize]);

  const focusCanvasPosition = useCallback((position: Point, nodeHeight = NODE_HEIGHT) => {
    const surface = surfaceRef.current;
    const width = surface?.clientWidth || 1280;
    const height = surface?.clientHeight || 720;
    const availableHeight = Math.max(220, height - bottomInset);
    setViewportAnimating(true);
    setPan({
      x: width / 2 - (position.x + NODE_WIDTH / 2) * scale,
      y: availableHeight / 2 - (position.y + nodeHeight / 2) * scale,
    });
    if (viewportAnimationTimerRef.current !== null) window.clearTimeout(viewportAnimationTimerRef.current);
    viewportAnimationTimerRef.current = window.setTimeout(() => setViewportAnimating(false), 240);
  }, [bottomInset, scale]);

  useEffect(() => {
    if (!canvasReady) return;
    // Nodes can arrive through SSE while the creator is arranging the canvas; keep existing coordinates intact.
    const missing = allNodes.filter((node) => !positions[node.id]);
    if (!missing.length) return;
    const next = { ...positions };
    const bounds = visiblePlacementBounds();
    let focusTarget: { position: Point; height: number } | null = null;
    if (missing.length > 32) {
      const placementIndex = new CanvasSpatialIndex(allNodes.flatMap((node) => {
        const position = next[node.id];
        if (!position) return [];
        const height = nodeHeights[node.id] ?? (node.kind === "upload" ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT);
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
        const nodeHeight = nodeHeights[node.id] ?? (node.kind === "upload" ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT);
        const subtitleTrack = node.kind === "subtitle"
          ? subtitleTracks.find((track) => track.subtitle_id === node.id)
          : undefined;
        const subtitleParent = subtitleTrack ? next[subtitleTrack.creation_id] : undefined;
        const siblingIndex = subtitleTrack
          ? subtitleTracks
            .filter((track) => track.creation_id === subtitleTrack.creation_id)
            .findIndex((track) => track.subtitle_id === subtitleTrack.subtitle_id)
          : 0;
        const preferred = subtitleParent
          ? subtitlePosition(subtitleParent, Math.max(0, siblingIndex))
          : derivedCreationPosition(node.kind === "creation" ? creationsById.get(node.id) : undefined, next);
        let candidate = preferred ?? initialPosition(slot);
        if (preferred && placementIndex.search({
          minX: candidate.x,
          minY: candidate.y,
          maxX: candidate.x + NODE_WIDTH,
          maxY: candidate.y + nodeHeight,
        }).length) candidate = initialPosition(slot);
        while (placementIndex.search({
          minX: candidate.x,
          minY: candidate.y,
          maxX: candidate.x + NODE_WIDTH,
          maxY: candidate.y + nodeHeight,
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
          maxY: candidate.y + nodeHeight + PLACEMENT_PADDING,
        });
        slot += 1;
      }
    } else {
      for (const [index, node] of missing.entries()) {
        const occupiedEntries = Object.entries(next);
        const occupied = occupiedEntries.map(([, position]) => position);
        const nodeHeight = nodeHeights[node.id] ?? (node.kind === "upload" ? UPLOAD_NODE_HEIGHT : NODE_HEIGHT);
        const subtitleTrack = node.kind === "subtitle"
          ? subtitleTracks.find((track) => track.subtitle_id === node.id)
          : undefined;
        const subtitleParent = subtitleTrack ? next[subtitleTrack.creation_id] : undefined;
        const siblingIndex = subtitleTrack
          ? subtitleTracks
            .filter((track) => track.creation_id === subtitleTrack.creation_id)
            .findIndex((track) => track.subtitle_id === subtitleTrack.subtitle_id)
          : 0;
        const preferred = subtitleParent
          ? subtitlePosition(subtitleParent, Math.max(0, siblingIndex))
          : derivedCreationPosition(node.kind === "creation" ? creationsById.get(node.id) : undefined, next);
        const result = occupied.length === 0 && index === 0
          ? { position: initialPosition(0), visible: true }
          : findOpenCanvasPosition(occupied, bounds, preferred, {
            candidateHeight: nodeHeight,
            occupiedHeights: occupiedEntries.map(([id]) => nodeHeights[id] ?? NODE_HEIGHT),
          });
        next[node.id] = result.position;
        if (!result.visible) focusTarget = { position: result.position, height: nodeHeight };
      }
    }
    // New nodes arrive from the project event stream, so placement synchronizes external state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPositions(next);
    if (focusTarget) focusCanvasPosition(focusTarget.position, focusTarget.height);
  }, [allNodes, canvasReady, creationsById, focusCanvasPosition, nodeHeights, positions, subtitleTracks, visiblePlacementBounds]);

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
          ...subtitleTracks
            .filter((track) => !hiddenSet.has(track.creation_id))
            .map((track) => track.subtitle_id),
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
  }, [hiddenSet, publishSelection, readOnly, redoCanvasChange, subtitleTracks, undoCanvasChange, visibleCreations, visibleUploads]);

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

  const beginNodeInteraction = (event: React.PointerEvent<HTMLElement>, nodeId: string) => {
    if (event.button !== 0 || readOnly) return;
    if (spacePressed) {
      beginCanvasPan(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const groupedIds = groupByMember.get(nodeId)?.member_ids ?? [];
    const nextSelection = event.shiftKey
      ? selectedSet.has(nodeId)
        ? selectedIds.filter((id) => id !== nodeId)
        : [...new Set([...selectedIds, nodeId])]
      : selectedSet.has(nodeId)
        ? [...new Set([...selectedIds, ...groupedIds])]
        : groupedIds.length ? groupedIds : [nodeId];
    const origins = Object.fromEntries(nextSelection.map((id) => [id, positions[id] ?? { x: 0, y: 0 }]));
    pointerRef.current = {
      kind: "nodes",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      start: { x: event.clientX, y: event.clientY },
      origins,
      selection: nextSelection,
      active: false,
      touchReady: event.pointerType !== "touch",
    };
    if (touchHoldTimerRef.current !== null) window.clearTimeout(touchHoldTimerRef.current);
    if (event.pointerType === "touch") {
      touchHoldTimerRef.current = window.setTimeout(() => {
        const operation = pointerRef.current;
        if (operation?.kind === "nodes" && operation.pointerId === event.pointerId) {
          pointerRef.current = { ...operation, touchReady: true };
        }
      }, TOUCH_DRAG_HOLD_MS);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginNodeDrag = (event: React.PointerEvent<HTMLElement>, creationId: string) => {
    beginNodeInteraction(event, creationId);
  };

  const beginUploadDrag = (event: React.PointerEvent<HTMLElement>, referenceId: string) => {
    beginNodeInteraction(event, referenceId);
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

  const applyPointerUpdate = (pointerId: number, clientX: number, clientY: number, snapDisabled = false) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== pointerId) return;
    if (operation.kind === "pan") {
      setSnapGuides([]);
      setPan({
        x: operation.origin.x + clientX - operation.start.x,
        y: operation.origin.y + clientY - operation.start.y,
      });
      return;
    }
    if (operation.kind === "nodes") {
      const distance = Math.hypot(clientX - operation.start.x, clientY - operation.start.y);
      const threshold = operation.pointerType === "touch" ? TOUCH_DRAG_THRESHOLD : DESKTOP_DRAG_THRESHOLD;
      if (!operation.active && (distance < threshold || !operation.touchReady)) return;
      if (!operation.active) {
        const activeOperation = { ...operation, active: true };
        pointerRef.current = activeOperation;
        publishSelection(operation.selection);
        setDraggingIds(operation.selection);
      }
      const dx = (clientX - operation.start.x) / scale;
      const dy = (clientY - operation.start.y) / scale;
      const updates = Object.fromEntries(
        Object.entries(operation.origins).map(([id, origin]) => [id, { x: origin.x + dx, y: origin.y + dy }]),
      );
      const snapped = snapCanvasPositions(operation.origins, updates, canvasNodes, {
        scale,
        enabled: snapEnabled && !snapDisabled,
      });
      positionsRef.current = { ...positionsRef.current, ...snapped.positions };
      setSnapGuides(snapped.guides);
      setPositions(positionsRef.current);
      return;
    }
    setSnapGuides([]);
    const current = { x: clientX, y: clientY };
    pointerRef.current = { ...operation, current };
    setMarquee({ start: operation.start, current });
  };

  const updatePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    pendingPointerRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, altKey: event.altKey };
    if (pointerFrameRef.current !== null) return;
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const pending = pendingPointerRef.current;
      pendingPointerRef.current = null;
      if (pending) applyPointerUpdate(pending.pointerId, pending.clientX, pending.clientY, pending.altKey);
    });
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    pendingPointerRef.current = null;
    applyPointerUpdate(event.pointerId, event.clientX, event.clientY, event.altKey);
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    if (touchHoldTimerRef.current !== null) {
      window.clearTimeout(touchHoldTimerRef.current);
      touchHoldTimerRef.current = null;
    }
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
      setSnapGuides([]);
      const moved = operation.active && Object.entries(operation.origins).some(([id, origin]) => {
        const current = positionsRef.current[id];
        return current && (current.x !== origin.x || current.y !== origin.y);
      });
      if (moved) {
        const after = captureHistoryState();
        recordHistory(
          { ...after, positions: { ...after.positions, ...operation.origins } },
          after,
        );
      } else if (!operation.active) {
        publishSelection(operation.selection);
      }
    } else if (operation.kind === "pan") {
      setPan({
        x: operation.origin.x + event.clientX - operation.start.x,
        y: operation.origin.y + event.clientY - operation.start.y,
      });
    }
    pointerRef.current = null;
    setDraggingIds([]);
    setSnapGuides([]);
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
      setScale(nextScale);
      setPan({
        x: cursorX - worldX * nextScale,
        y: cursorY - worldY * nextScale,
      });
      return;
    }
    setPan({
      x: pan.x - event.deltaX,
      y: pan.y - event.deltaY,
    });
  }, [pan.x, pan.y, scale]);

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
    let focusTarget: { position: Point; height: number } | null = null;
    for (const [index, upload] of uploaded.entries()) {
      const occupiedEntries = Object.entries(next);
      const result = findOpenCanvasPosition(
        occupiedEntries.map(([, position]) => position),
        bounds,
        { x: preferred.x + index * 20, y: preferred.y + index * 20 },
        {
          candidateHeight: UPLOAD_NODE_HEIGHT,
          occupiedHeights: occupiedEntries.map(([id]) => nodeHeights[id] ?? NODE_HEIGHT),
        },
      );
      next[upload.reference_id] = result.position;
      placements[upload.reference_id] = result.position;
      if (!result.visible) focusTarget = { position: result.position, height: UPLOAD_NODE_HEIGHT };
    }
    setPositions((current) => ({ ...current, ...placements }));
    if (focusTarget) focusCanvasPosition(focusTarget.position, focusTarget.height);
  };

  const hideNodes = (nodeIds: string[]) => {
    const before = captureHistoryState();
    const nodeSet = new Set(nodeIds);
    commitHistoryState(before, {
      ...before,
      hiddenCreationIds: [...new Set([
        ...before.hiddenCreationIds,
        ...nodeIds.filter((id) => creationsById.has(id) || subtitleIds.has(id)),
      ])],
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
  const activeContextSubtitle = contextMenu?.kind === "subtitle"
    ? subtitleTracks.find((track) => track.subtitle_id === contextMenu.nodeId) ?? null
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

  const selectNodeLabel = (nodeId: string, selected: boolean, additive: boolean) => {
    if (additive) {
      publishSelection(selected ? selectedIds.filter((id) => id !== nodeId) : [...selectedIds, nodeId]);
      return;
    }
    publishSelection([nodeId]);
  };

  const openNodeMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    kind: ContextMenuState["kind"],
    nodeId: string,
  ) => {
    event.stopPropagation();
    if (!selectedSet.has(nodeId)) publishSelection([nodeId]);
    const rect = event.currentTarget.getBoundingClientRect();
    const surface = surfaceRef.current?.getBoundingClientRect();
    const surfaceWidth = surface?.width ?? 260;
    const surfaceHeight = surface?.height ?? 200;
    setContextMenu({
      kind,
      nodeId,
      x: Math.min(Math.max(4, rect.right - (surface?.left ?? 0)), surfaceWidth - 196),
      y: Math.min(Math.max(4, rect.bottom - (surface?.top ?? 0)), surfaceHeight - 156),
    });
  };

  const renderRelationItem = (relation: CanvasRelation, direction: "upstream" | "downstream") => {
    const relatedId = direction === "upstream" ? relation.sourceId : relation.targetId;
    const label = relationNodeLabel(relatedId);
    const position = positions[relatedId];
    const hidden = hiddenSet.has(relatedId) || hiddenUploadSet.has(relatedId);
    const locatable = Boolean(label && position && (showHidden || !hidden));
    return (
      <button
        key={`${direction}:${relation.id}`}
        type="button"
        disabled={!locatable}
        onClick={() => {
          if (!position || !locatable) return;
          publishSelection([relatedId]);
          focusCanvasPosition(position, nodeHeights[relatedId]);
          setRelationPanelNodeId(relatedId);
        }}
        className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-white/[0.05] disabled:cursor-default disabled:opacity-55"
      >
        <span className="min-w-0">
          <span className="block truncate text-xs text-[var(--color-text-2)]">{locatable ? label : t("free_creation_relation_unavailable")}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {relation.roles.map((role) => <span key={role} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] leading-3 text-[var(--color-text-muted)]">{t(RELATION_ROLE_KEYS[role])}</span>)}
          </span>
        </span>
        {locatable ? <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" aria-hidden /> : null}
      </button>
    );
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
        if (!hit) {
          setContextMenu(null);
          return;
        }
        publishSelection(selectedSet.has(hit.id) ? selectedIds : [hit.id]);
        const rect = surfaceRef.current?.getBoundingClientRect();
        setContextMenu({
          kind: hit.kind,
          nodeId: hit.id,
          x: Math.min(Math.max(4, event.clientX - (rect?.left ?? 0)), (rect?.width ?? 260) - 196),
          y: Math.min(Math.max(4, event.clientY - (rect?.top ?? 0)), (rect?.height ?? 200) - 156),
        });
      }}
      onDoubleClick={(event) => {
        if (lod === "detail" || (event.target as HTMLElement).closest("[data-canvas-node='true']")) return;
        const hit = hitTestCanvas(event.clientX, event.clientY);
        if (!hit) return;
        if (hit.kind === "subtitle") {
          const track = subtitleTracks.find((item) => item.subtitle_id === hit.id);
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

      {canvasLoadError ? (
        <div className="absolute inset-0 z-[240] grid place-items-center bg-[var(--color-background)]/88 px-6 backdrop-blur-sm" role="alert">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] p-5 text-center shadow-2xl">
            <p className="text-sm leading-5 text-[var(--color-text-2)]">{t("free_creation_canvas_load_failed")}</p>
            <button type="button" onClick={() => setCanvasReloadToken((value) => value + 1)} className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--color-accent)]/50 px-3 text-xs font-medium text-[var(--color-accent-2)] hover:bg-[var(--color-accent-dim)]">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {t("free_creation_canvas_retry")}
            </button>
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
        <button type="button" onClick={() => setSnapEnabled((value) => !value)} className={`focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] ${snapEnabled ? "bg-[var(--color-accent-dim)] text-[var(--color-accent-2)]" : ""}`} title={t(snapEnabled ? "free_creation_snap_disable" : "free_creation_snap_enable")} aria-label={t(snapEnabled ? "free_creation_snap_disable" : "free_creation_snap_enable")} aria-pressed={snapEnabled}><Magnet className="h-4 w-4" aria-hidden /></button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setRelationMenuOpen((value) => !value)}
            className={`focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] ${relationMode !== "off" ? "bg-white/[0.06] text-[var(--color-text)]" : ""}`}
            title={t("free_creation_relations")}
            aria-label={t("free_creation_relations")}
            aria-expanded={relationMenuOpen}
            aria-haspopup="menu"
          >
            <Waypoints className="h-4 w-4" aria-hidden />
          </button>
          {relationMenuOpen ? (
            <div className="absolute right-0 top-[calc(100%+8px)] z-[210] w-48 rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] p-1.5 shadow-2xl" role="menu" aria-label={t("free_creation_relations")}>
              {(["all", "selected", "off"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={relationMode === mode}
                  onClick={() => changeRelationMode(mode)}
                  className={`focus-ring flex min-h-8 w-full items-center justify-between gap-3 rounded px-2.5 text-left text-xs ${relationMode === mode ? "bg-white/[0.07] text-[var(--color-text)]" : "text-[var(--color-text-2)] hover:bg-white/[0.04]"}`}
                >
                  <span>{t(`free_creation_relations_${mode}`)}</span>
                  {relationMode === mode ? <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden /> : null}
                </button>
              ))}
              {visibleRelationQuery.omitted ? <p className="px-2.5 pb-1 pt-2 text-[10px] leading-4 text-[var(--color-text-muted)]">{t("free_creation_relations_limited", { count: visibleRelationQuery.omitted })}</p> : null}
            </div>
          ) : null}
        </div>
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
                  [t("free_creation_shortcut_snap"), t("free_creation_shortcut_combo_snap")],
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
        camera={camera}
        viewport={viewportSize}
        nodes={viewportRenderNodes}
        groups={sceneGroups}
        relations={sceneRelations}
        selectedIds={selectedSet}
        lod={lod}
      />
      {snapGuides.map((guide, index) => guide.axis === "x" ? (
        <div
          key={`snap-x-${index}`}
          className="pointer-events-none absolute inset-y-0 z-[15] w-px border-l border-dashed border-[var(--color-accent-2)]/90"
          style={{ left: pan.x + guide.value * scale }}
          aria-hidden
        />
      ) : (
        <div
          key={`snap-y-${index}`}
          className="pointer-events-none absolute inset-x-0 z-[15] h-px border-t border-dashed border-[var(--color-accent-2)]/90"
          style={{ top: pan.y + guide.value * scale }}
          aria-hidden
        />
      ))}
      <div className="sr-only" aria-hidden>
        {sceneGroups.map((group) => <span key={group.id} data-canvas-group={group.id} />)}
      </div>
      <div className="absolute left-0 top-0" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`, transformOrigin: "0 0", transition: viewportAnimating ? "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)" : undefined }}>

        {renderedUploads.map((upload) => {
          const position = positions[upload.reference_id];
          if (!position) return null;
          const selected = selectedSet.has(upload.reference_id);
          const hidden = hiddenUploadSet.has(upload.reference_id);
          const dragging = draggingSet.has(upload.reference_id);
          const upstreamCount = relationGraph.upstream(upload.reference_id).length;
          const downstreamCount = relationGraph.downstream(upload.reference_id).length;
          const claim: FreeCreationReferenceClaim = {
            type: "upload",
            reference_id: upload.reference_id,
            role: freeCreationUploadRole(upload.media_type),
          };
          return (
            <div
              role="button"
              aria-pressed={selected}
              key={upload.reference_id}
              ref={(node) => { if (node) nodeRefs.current.set(upload.reference_id, node); else nodeRefs.current.delete(upload.reference_id); }}
              draggable={false}
              onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); nativeNodeDragRef.current = true; }}
              onDragEnd={() => { nativeNodeDragRef.current = false; }}
              data-canvas-node="true"
              data-canvas-id={upload.reference_id}
              data-selected={selected}
              data-dragging={dragging}
              tabIndex={0}
              aria-label={selected ? [upload.original_filename, t("free_creation_selected")].join(", ") : upload.original_filename}
              onKeyDown={(event) => {
                if (event.ctrlKey || event.metaKey) handleReferenceShortcut(event, claim, upload.original_filename);
                else handleNodeKeyboard(event, upload.reference_id, selected);
              }}
              className={`canvas-node-shell group/node absolute overflow-visible rounded-lg outline-none ${hidden ? "opacity-55" : ""}`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: nodeHeights[upload.reference_id] ?? UPLOAD_NODE_HEIGHT }}
              onPointerDown={(event) => {
                if (event.button === 0 && spacePressed) { beginCanvasPan(event); return; }
                if (event.button === 0 && (event.ctrlKey || event.metaKey)) { event.preventDefault(); return; }
                if (event.button === 0 && !isNodeControlTarget(event.target)) beginUploadDrag(event, upload.reference_id);
              }}
              onClick={(event) => handleReferenceShortcut(event, claim, upload.original_filename)}
              onPointerEnter={() => setHoveredNodeId(upload.reference_id)}
              onPointerLeave={() => setHoveredNodeId((current) => current === upload.reference_id ? null : current)}
              onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onPreview?.({ kind: "upload", upload }); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (readOnly) return; if (!selectedSet.has(upload.reference_id)) publishSelection([upload.reference_id]); const rect = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "upload", nodeId: upload.reference_id, x: Math.min(Math.max(4, event.clientX - (rect?.left ?? 0)), (rect?.width ?? 260) - 196), y: Math.min(Math.max(4, event.clientY - (rect?.top ?? 0)), (rect?.height ?? 200) - 156) }); }}
            >
              {lod === "detail" ? <CanvasNodeLabel label={upload.original_filename} mediaType={upload.media_type} scale={scale} selected={selected} title={`${upload.original_filename} · ${t("free_creation_reference")}`} onSelect={(additive) => selectNodeLabel(upload.reference_id, selected, additive)} /> : null}
              <div className="canvas-node-card relative h-full w-full overflow-hidden rounded-lg bg-[var(--color-surface-2)]" data-canvas-drag-surface="true">
                <CanvasMediaThumbnail
                  key={`${upload.reference_id}:${upload.path}`}
                  mediaType={upload.media_type}
                  label={upload.original_filename}
                  src={upload.media_type === "video" ? API.getFreeCreationReferenceProxyUrl(projectName, upload.reference_id) : upload.media_type === "text" ? undefined : uploadMediaUrl(projectName, upload)}
                  poster={upload.media_type === "video" ? API.getFreeCreationReferenceCoverUrl(projectName, upload.reference_id) : undefined}
                  mediaId={upload.reference_id}
                  textContent={t("media_type_text")}
                  playLabel={t("free_creation_video_play")}
                  pauseLabel={t("free_creation_video_pause")}
                  onIntrinsicSize={(width, height) => rememberMediaDimensions(upload.reference_id, width, height)}
                  onVideoLoadedMetadata={(video) => restoreVideoPlayback(upload.reference_id, video, 0.1)}
                  onVideoPlay={(video) => rememberVideoPlayback(upload.reference_id, video)}
                  onVideoPause={(video) => rememberVideoPlayback(upload.reference_id, video)}
                  onVideoTimeUpdate={(video) => rememberVideoPlayback(upload.reference_id, video)}
                />
                {selected && upstreamCount + downstreamCount > 0 ? <button type="button" className="focus-ring absolute left-2 top-2 z-30 inline-flex h-7 max-w-[170px] items-center gap-1.5 rounded-md bg-black/60 px-2 text-[10px] text-white/90 backdrop-blur-sm hover:bg-black/75" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setRelationPanelNodeId(upload.reference_id); }} aria-label={t("free_creation_relation_summary", { upstream: upstreamCount, downstream: downstreamCount })} title={t("free_creation_relation_summary", { upstream: upstreamCount, downstream: downstreamCount })}><Waypoints className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{t("free_creation_relation_summary_short", { upstream: upstreamCount, downstream: downstreamCount })}</span></button> : null}
                {!readOnly ? <div className="canvas-node-actions absolute bottom-2 right-2 z-30 rounded-md bg-black/55 p-0.5 backdrop-blur-sm" onPointerDown={(event) => event.stopPropagation()}><button type="button" className="focus-ring grid h-7 w-7 place-items-center rounded text-[var(--color-text-2)] hover:bg-white/10 hover:text-[var(--color-text)]" onClick={(event) => openNodeMenu(event, "upload", upload.reference_id)} aria-label={t("free_creation_more_actions")} title={t("free_creation_more_actions")}><MoreHorizontal className="h-4 w-4" aria-hidden /></button></div> : null}
              </div>
            </div>
          );
        })}

        {renderedCreations.map((creation) => {
          const position = positions[creation.creation_id];
          if (!position) return null;
          const selected = selectedSet.has(creation.creation_id);
          const hidden = hiddenSet.has(creation.creation_id);
          const dragging = draggingSet.has(creation.creation_id);
          const mediaType = creationMediaType(creation);
          const referenceRole = creationReferenceRole(creation);
          const statusLabel = t(`free_creation_status_${creation.status}`);
          const label = creationLabel(creation, t(`free_creation_${creation.output_type}`));
          const upstreamCount = relationGraph.upstream(creation.creation_id).length;
          const downstreamCount = relationGraph.downstream(creation.creation_id).length;
          const claim: FreeCreationReferenceClaim = {
            type: "creation",
            creation_id: creation.creation_id,
            version: creation.version,
            role: referenceRole,
          };
          const mediaUrl = creation.status === "succeeded" && creation.media_path
            ? mediaType === "video"
              ? API.getFreeCreationProxyUrl(projectName, creation.creation_id, creation.version)
              : API.getFreeCreationMediaUrl(projectName, creation.creation_id, creation.version)
            : undefined;
          return (
            <div
              key={creation.creation_id}
              ref={(node) => { if (node) nodeRefs.current.set(creation.creation_id, node); else nodeRefs.current.delete(creation.creation_id); }}
              data-canvas-node="true"
              draggable={false}
              onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); nativeNodeDragRef.current = true; }}
              onDragEnd={() => { nativeNodeDragRef.current = false; }}
              data-canvas-id={creation.creation_id}
              data-selected={selected}
              data-dragging={dragging}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={selected ? `${label}, ${statusLabel}, ${t("free_creation_selected")}` : `${label}, ${statusLabel}`}
              onKeyDown={(event) => {
                if (event.ctrlKey || event.metaKey) handleReferenceShortcut(event, claim, label);
                else handleNodeKeyboard(event, creation.creation_id, selected);
              }}
              className={`canvas-node-shell group/node absolute overflow-visible rounded-lg outline-none ${hidden ? "opacity-55" : ""}`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: nodeHeights[creation.creation_id] ?? NODE_HEIGHT }}
              onPointerDown={(event) => {
                if (event.button === 0 && spacePressed) {
                  beginCanvasPan(event);
                  return;
                }
                if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  return;
                }
                if (event.button === 0 && !isNodeControlTarget(event.target)) {
                  beginNodeDrag(event, creation.creation_id);
                }
              }}
              onClick={(event) => {
                if (creation.status === "succeeded" && creation.media_path) handleReferenceShortcut(event, claim, label);
              }}
              onPointerEnter={() => setHoveredNodeId(creation.creation_id)}
              onPointerLeave={() => setHoveredNodeId((current) => current === creation.creation_id ? null : current)}
              onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); if (creation.status === "succeeded" && creation.media_path) onPreview?.({ kind: "creation", creation }); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (readOnly) return; if (!selectedSet.has(creation.creation_id)) publishSelection([creation.creation_id]); const rect = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "creation", nodeId: creation.creation_id, x: Math.min(Math.max(4, event.clientX - (rect?.left ?? 0)), (rect?.width ?? 260) - 196), y: Math.min(Math.max(4, event.clientY - (rect?.top ?? 0)), (rect?.height ?? 200) - 156) }); }}
            >
              {lod === "detail" ? <CanvasNodeLabel label={label} mediaType={mediaType} scale={scale} selected={selected} title={[label, statusLabel, creation.error].filter(Boolean).join(" · ")} onSelect={(additive) => selectNodeLabel(creation.creation_id, selected, additive)} /> : null}
              <div className="canvas-node-card relative h-full w-full overflow-hidden rounded-lg bg-[var(--color-surface-2)]" data-canvas-drag-surface="true">
                <CanvasMediaThumbnail
                  key={`${creation.creation_id}:${creation.version ?? 0}:${creation.status}`}
                  mediaType={mediaType}
                  label={label}
                  src={mediaUrl}
                  poster={mediaType === "video" && mediaUrl ? API.getFreeCreationCoverUrl(projectName, creation.creation_id, creation.version) : undefined}
                  pending={["queued", "running", "cancelling"].includes(creation.status)}
                  failureMessage={creation.status === "failed" ? creation.error || t("free_creation_failed") : creation.status === "cancelled" ? statusLabel : undefined}
                  mediaId={creation.creation_id}
                  playLabel={t("free_creation_video_play")}
                  pauseLabel={t("free_creation_video_pause")}
                  onIntrinsicSize={(width, height) => rememberMediaDimensions(creation.creation_id, width, height)}
                  onVideoLoadedMetadata={(video) => restoreVideoPlayback(creation.creation_id, video, 0.1)}
                  onVideoPlay={(video) => rememberVideoPlayback(creation.creation_id, video)}
                  onVideoPause={(video) => rememberVideoPlayback(creation.creation_id, video)}
                  onVideoTimeUpdate={(video) => rememberVideoPlayback(creation.creation_id, video)}
                />
                <CanvasNodeStatusDot status={creation.status} label={statusLabel} />
                {selected && upstreamCount + downstreamCount > 0 ? <button type="button" className="focus-ring absolute left-2 top-2 z-30 inline-flex h-7 max-w-[170px] items-center gap-1.5 rounded-md bg-black/60 px-2 text-[10px] text-white/90 backdrop-blur-sm hover:bg-black/75" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setRelationPanelNodeId(creation.creation_id); }} aria-label={t("free_creation_relation_summary", { upstream: upstreamCount, downstream: downstreamCount })} title={t("free_creation_relation_summary", { upstream: upstreamCount, downstream: downstreamCount })}><Waypoints className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{t("free_creation_relation_summary_short", { upstream: upstreamCount, downstream: downstreamCount })}</span></button> : null}
                {!readOnly ? <div className="canvas-node-actions absolute bottom-2 right-2 z-30 flex items-center gap-0.5 rounded-md bg-black/55 p-0.5 backdrop-blur-sm" onPointerDown={(event) => event.stopPropagation()}>{renderActions(creation)}<button type="button" className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-2)] hover:bg-white/10 hover:text-[var(--color-text)]" onClick={(event) => openNodeMenu(event, "creation", creation.creation_id)} aria-label={t("free_creation_more_actions")} title={t("free_creation_more_actions")}><MoreHorizontal className="h-4 w-4" aria-hidden /></button></div> : null}
              </div>
            </div>
          );
        })}

        {subtitleTracks.map((track) => {
          if (!domNodeIds.has(track.subtitle_id)) return null;
          const position = positions[track.subtitle_id];
          if (!position || (!showHidden && hiddenSet.has(track.subtitle_id))) return null;
          const cuePreview = track.cues.slice(0, 3);
          const subtitleLabel = t("free_creation_subtitle_badge", { count: track.cues.length });
          const selected = selectedSet.has(track.subtitle_id);
          const dragging = draggingSet.has(track.subtitle_id);
          const upstreamCount = relationGraph.upstream(track.subtitle_id).length;
          const downstreamCount = relationGraph.downstream(track.subtitle_id).length;
          return (
            <div
              key={`subtitle-node-${track.subtitle_id}`}
              data-canvas-node="true"
              data-canvas-id={track.subtitle_id}
              data-selected={selected}
              data-dragging={dragging}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={subtitleLabel}
              className="canvas-node-shell group/node absolute overflow-visible rounded-lg outline-none"
              style={{ left: position.x, top: position.y, width: SUBTITLE_NODE_WIDTH, minHeight: SUBTITLE_NODE_HEIGHT }}
              onPointerDown={(event) => {
                if (event.button === 0 && spacePressed) {
                  beginCanvasPan(event);
                  return;
                }
                if (event.button === 0 && !isNodeControlTarget(event.target)) {
                  beginNodeDrag(event, track.subtitle_id);
                }
              }}
              onKeyDown={(event) => handleNodeKeyboard(event, track.subtitle_id, selected)}
              onPointerEnter={() => setHoveredNodeId(track.subtitle_id)}
              onPointerLeave={() => setHoveredNodeId((current) => current === track.subtitle_id ? null : current)}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onEditSubtitle?.(track.creation_id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (readOnly) return;
                if (!selectedSet.has(track.subtitle_id)) publishSelection([track.subtitle_id]);
                const rect = surfaceRef.current?.getBoundingClientRect();
                setContextMenu({
                  kind: "subtitle",
                  nodeId: track.subtitle_id,
                  x: Math.min(Math.max(4, event.clientX - (rect?.left ?? 0)), (rect?.width ?? 260) - 196),
                  y: Math.min(Math.max(4, event.clientY - (rect?.top ?? 0)), (rect?.height ?? 200) - 156),
                });
              }}
            >
              {lod === "detail" ? <CanvasNodeLabel label={subtitleLabel} mediaType="subtitle" scale={scale} selected={selected} title={t("free_creation_subtitle_title")} onSelect={(additive) => selectNodeLabel(track.subtitle_id, selected, additive)} /> : null}
              <div className="canvas-node-card relative h-full min-h-[166px] w-full overflow-hidden rounded-lg bg-[var(--color-surface-2)]" data-canvas-drag-surface="true">
                <div className="flex h-10 items-center gap-2 border-b border-[var(--color-hairline)] px-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/[0.06] text-[var(--color-text-2)]"><Captions className="h-3.5 w-3.5" aria-hidden /></span>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--color-text-2)]">{t("free_creation_subtitle_title")}</span>
                  <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{track.cues.length}</span>
                </div>
                <div className="space-y-2 px-3 py-3">
                  {cuePreview.length ? cuePreview.map((cue, cueIndex) => (
                    <div key={`${track.subtitle_id}-${cueIndex}`} className="grid grid-cols-[38px_minmax(0,1fr)] gap-2">
                      <span className="pt-px text-[9px] tabular-nums text-[var(--color-text-muted)]">{cue.start_seconds.toFixed(1)}s</span>
                      <p className="line-clamp-1 text-[11px] leading-4 text-[var(--color-text-2)]">{cue.text}</p>
                    </div>
                  )) : <p className="text-[11px] text-[var(--color-text-muted)]">{t("free_creation_subtitle_action")}</p>}
                </div>
                {selected && upstreamCount + downstreamCount > 0 ? <button type="button" className="focus-ring absolute bottom-2 left-2 z-30 inline-flex h-7 max-w-[138px] items-center gap-1.5 rounded-md bg-black/60 px-2 text-[10px] text-white/90 backdrop-blur-sm hover:bg-black/75" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setRelationPanelNodeId(track.subtitle_id); }} aria-label={t("free_creation_relation_summary", { upstream: upstreamCount, downstream: downstreamCount })} title={t("free_creation_relation_summary", { upstream: upstreamCount, downstream: downstreamCount })}><Waypoints className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{t("free_creation_relation_summary_short", { upstream: upstreamCount, downstream: downstreamCount })}</span></button> : null}
                {!readOnly ? <div className="canvas-node-actions absolute bottom-2 right-2 z-30 rounded-md bg-black/55 p-0.5 backdrop-blur-sm" onPointerDown={(event) => event.stopPropagation()}><button type="button" className="focus-ring grid h-7 w-7 place-items-center rounded text-[var(--color-text-2)] hover:bg-white/10 hover:text-[var(--color-text)]" onClick={(event) => openNodeMenu(event, "subtitle", track.subtitle_id)} aria-label={t("free_creation_more_actions")} title={t("free_creation_more_actions")}><MoreHorizontal className="h-4 w-4" aria-hidden /></button></div> : null}
              </div>
            </div>
          );
        })}
      </div>

      {marquee ? <div className="pointer-events-none fixed z-30 border border-[var(--color-accent)] bg-[var(--color-accent-dim)]" style={{ left: Math.min(marquee.start.x, marquee.current.x), top: Math.min(marquee.start.y, marquee.current.y), width: Math.abs(marquee.current.x - marquee.start.x), height: Math.abs(marquee.current.y - marquee.start.y) }} /> : null}

      {(activeContextCreation || activeContextUpload || activeContextSubtitle) && contextMenu ? (
        <div ref={contextMenuRef} tabIndex={-1} className="absolute z-[200] max-h-[min(70vh,520px)] min-w-44 max-w-[min(320px,calc(100vw-24px))] overflow-y-auto rounded-md border border-[var(--color-hairline)] p-1 shadow-2xl" style={{ left: Math.max(4, contextMenu.x), top: Math.max(4, contextMenu.y), background: "var(--color-surface-2)", opacity: 1 }} role="menu" aria-label={t("free_creation_more_actions")}>
          {activeContextCreation ? <>
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => contextSelectionIsHidden ? restoreNodes(contextSelectionIds) : hideNodes(contextSelectionIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]">{contextSelectionIsHidden ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}{t(contextSelectionIsHidden ? "free_creation_restore" : "free_creation_hide")}</button> : null}
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => arrangeNodes("selected")} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />{t("free_creation_arrange_selected")}</button> : null}
            {canGroupSelection ? <button type="button" role="menuitem" onClick={groupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Group className="h-3.5 w-3.5" aria-hidden />{t("free_creation_group_selected")}</button> : null}
            {activeContextGroup ? <button type="button" role="menuitem" onClick={ungroupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Ungroup className="h-3.5 w-3.5" aria-hidden />{t("free_creation_ungroup")}</button> : null}
            {selectedReferences.length >= 2 && selectedSet.has(activeContextCreation.creation_id) ? <button type="button" role="menuitem" onClick={() => { if (onReferences) onReferences(selectedReferences); else selectedReferences.forEach(({ claim, label }) => onReference(claim, label)); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_selected_references", { count: selectedReferences.length })}</button> : null}
            {onMerge && selectedMergeIds.length >= 2 && selectedMergeIds.includes(activeContextCreation.creation_id) ? <button type="button" role="menuitem" onClick={() => { onMerge(selectedMergeIds); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Clapperboard className="h-3.5 w-3.5" aria-hidden />{t("free_creation_merge_selected")}</button> : null}
            {onCompositeAudio && audioCompositePair ? <button type="button" role="menuitem" onClick={() => { onCompositeAudio(audioCompositePair.videoId, audioCompositePair.audioId); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><AudioLines className="h-3.5 w-3.5" aria-hidden />{t("free_creation_composite_audio")}</button> : null}
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path && creationMediaType(activeContextCreation) === "image" ? <button type="button" role="menuitem" onClick={() => { onEdit(activeContextCreation.creation_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Pencil className="h-3.5 w-3.5" aria-hidden />{t("free_creation_use_as_parent")}</button> : null}
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path ? <button type="button" role="menuitem" onClick={() => { onPreview?.({ kind: "creation", creation: activeContextCreation }); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_preview")}</button> : null}
            {onContinue && contextSelectionIds.length < 2 && activeContextCreation.status === "succeeded" && activeContextCreation.media_path && creationMediaType(activeContextCreation) !== "audio" ? <button type="button" role="menuitem" onClick={() => { onContinue(activeContextCreation.creation_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><ArrowUpRight className="h-3.5 w-3.5" aria-hidden />{t("free_creation_continue_from_result")}</button> : null}
            {contextSelectionIds.length < 2 && activeContextCreation.status === "succeeded" && activeContextCreation.media_path ? <button type="button" role="menuitem" onClick={() => { onReference({ type: "creation", creation_id: activeContextCreation.creation_id, version: activeContextCreation.version, role: creationReferenceRole(activeContextCreation) }, activeContextCreation.prompt || t("free_creation")); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button> : null}
            {contextSelectionIds.length < 2 ? (hiddenSet.has(activeContextCreation.creation_id) ? <button type="button" role="menuitem" onClick={() => restoreCreation(activeContextCreation.creation_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_restore")}</button> : <button type="button" role="menuitem" onClick={() => hideCreation(activeContextCreation.creation_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><EyeOff className="h-3.5 w-3.5" aria-hidden />{t("free_creation_hide")}</button>) : null}
            {showBatchDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes(deletableCreationIds, selectedUploadIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete_selected", { count: contextSelectionIds.length })}</button> : null}
            {showSingleCreationDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes([activeContextCreation.creation_id], [])} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete")}</button> : null}
          </> : null}
          {activeContextUpload ? <>
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => contextSelectionIsHidden ? restoreNodes(contextSelectionIds) : hideNodes(contextSelectionIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]">{contextSelectionIsHidden ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}{t(contextSelectionIsHidden ? "free_creation_restore" : "free_creation_hide")}</button> : null}
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => arrangeNodes("selected")} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />{t("free_creation_arrange_selected")}</button> : null}
            {canGroupSelection ? <button type="button" role="menuitem" onClick={groupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Group className="h-3.5 w-3.5" aria-hidden />{t("free_creation_group_selected")}</button> : null}
            {activeContextGroup ? <button type="button" role="menuitem" onClick={ungroupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Ungroup className="h-3.5 w-3.5" aria-hidden />{t("free_creation_ungroup")}</button> : null}
            {selectedReferences.length >= 2 && selectedSet.has(activeContextUpload.reference_id) ? <button type="button" role="menuitem" onClick={() => { if (onReferences) onReferences(selectedReferences); else selectedReferences.forEach(({ claim, label }) => onReference(claim, label)); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_selected_references", { count: selectedReferences.length })}</button> : null}
            {onMerge && selectedMergeIds.length >= 2 && selectedMergeIds.includes(activeContextUpload.reference_id) ? <button type="button" role="menuitem" onClick={() => { onMerge(selectedMergeIds); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Clapperboard className="h-3.5 w-3.5" aria-hidden />{t("free_creation_merge_selected")}</button> : null}
            <button type="button" role="menuitem" onClick={() => { onPreview?.({ kind: "upload", upload: activeContextUpload }); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_preview")}</button>
            {contextSelectionIds.length < 2 ? <button type="button" role="menuitem" onClick={() => { onReference({ type: "upload", reference_id: activeContextUpload.reference_id, role: freeCreationUploadRole(activeContextUpload.media_type) }, activeContextUpload.original_filename); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button> : null}
            {contextSelectionIds.length < 2 && (hiddenUploadSet.has(activeContextUpload.reference_id) ? <button type="button" role="menuitem" onClick={() => restoreUpload(activeContextUpload.reference_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_restore")}</button> : <button type="button" role="menuitem" onClick={() => hideUpload(activeContextUpload.reference_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><EyeOff className="h-3.5 w-3.5" aria-hidden />{t("free_creation_hide")}</button>)}
            {showBatchDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes(deletableCreationIds, selectedUploadIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete_selected", { count: contextSelectionIds.length })}</button> : null}
            {showSingleUploadDelete ? <button type="button" role="menuitem" onClick={() => deleteNodes([], [activeContextUpload.reference_id])} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_delete")}</button> : null}
          </> : null}
          {activeContextSubtitle ? <>
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => contextSelectionIsHidden ? restoreNodes(contextSelectionIds) : hideNodes(contextSelectionIds)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]">{contextSelectionIsHidden ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}{t(contextSelectionIsHidden ? "free_creation_restore" : "free_creation_hide")}</button> : null}
            {contextSelectionIds.length >= 2 ? <button type="button" role="menuitem" onClick={() => arrangeNodes("selected")} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />{t("free_creation_arrange_selected")}</button> : null}
            {canGroupSelection ? <button type="button" role="menuitem" onClick={groupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Group className="h-3.5 w-3.5" aria-hidden />{t("free_creation_group_selected")}</button> : null}
            {activeContextGroup ? <button type="button" role="menuitem" onClick={ungroupSelection} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Ungroup className="h-3.5 w-3.5" aria-hidden />{t("free_creation_ungroup")}</button> : null}
            <button type="button" role="menuitem" onClick={() => { onEditSubtitle?.(activeContextSubtitle.creation_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Pencil className="h-3.5 w-3.5" aria-hidden />{t("free_creation_subtitle_edit")}</button>
            {onRenderSubtitle ? <button type="button" role="menuitem" onClick={() => { onRenderSubtitle(activeContextSubtitle.subtitle_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Captions className="h-3.5 w-3.5" aria-hidden />{t("free_creation_subtitle_render")}</button> : null}
            {contextSelectionIds.length < 2 ? (hiddenSet.has(activeContextSubtitle.subtitle_id) ? <button type="button" role="menuitem" onClick={() => restoreNodes([activeContextSubtitle.subtitle_id])} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_restore")}</button> : <button type="button" role="menuitem" onClick={() => hideNodes([activeContextSubtitle.subtitle_id])} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><EyeOff className="h-3.5 w-3.5" aria-hidden />{t("free_creation_hide")}</button>) : null}
            {onDeleteSubtitle ? <button type="button" role="menuitem" onClick={() => { onDeleteSubtitle(activeContextSubtitle.subtitle_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_subtitle_delete")}</button> : null}
          </> : null}
        </div>
      ) : null}

      {relationPanelData ? (
        <aside className="absolute right-4 top-16 z-[180] flex max-h-[min(62vh,560px)] w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)]/98 shadow-2xl backdrop-blur-md" aria-labelledby="free-creation-relation-panel-title">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--color-hairline)] px-3 py-2.5">
            <div className="min-w-0">
              <h2 id="free-creation-relation-panel-title" className="text-xs font-semibold text-[var(--color-text)]">{t("free_creation_relation_details")}</h2>
              <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{relationPanelData.label}</p>
            </div>
            <button type="button" onClick={() => setRelationPanelNodeId(null)} className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded text-[var(--color-text-muted)] hover:bg-white/[0.05] hover:text-[var(--color-text)]" aria-label={t("free_creation_relation_close")} title={t("free_creation_relation_close")}><XCircle className="h-4 w-4" aria-hidden /></button>
          </div>
          <div className="min-h-0 overflow-y-auto p-2">
            <section aria-labelledby="free-creation-relation-upstream">
              <h3 id="free-creation-relation-upstream" className="px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-muted)]">{t("free_creation_relation_upstream", { count: relationPanelData.upstream.length })}</h3>
              {relationPanelData.upstream.length ? relationPanelData.upstream.map((relation) => renderRelationItem(relation, "upstream")) : <p className="px-2.5 py-2 text-[11px] text-[var(--color-text-muted)]">{t("free_creation_relation_no_upstream")}</p>}
            </section>
            <section className="mt-2 border-t border-[var(--color-hairline)] pt-2" aria-labelledby="free-creation-relation-downstream">
              <h3 id="free-creation-relation-downstream" className="px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-muted)]">{t("free_creation_relation_downstream", { count: relationPanelData.downstream.length })}</h3>
              {relationPanelData.downstream.length ? relationPanelData.downstream.map((relation) => renderRelationItem(relation, "downstream")) : <p className="px-2.5 py-2 text-[11px] text-[var(--color-text-muted)]">{t("free_creation_relation_no_downstream")}</p>}
            </section>
          </div>
        </aside>
      ) : null}

      {creations.length === 0 && uploads.length === 0 ? <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 pb-44 text-center"><div className="max-w-sm"><LocateFixed className="mx-auto mb-3 h-5 w-5 text-[var(--color-text-muted)]" aria-hidden /><p className="text-sm text-[var(--color-text-muted)]">{t("free_creation_empty")}</p></div></div> : null}
    </div>
  );
}
