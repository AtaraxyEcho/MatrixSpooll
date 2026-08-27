import RBush from "rbush";

export interface CanvasCamera {
  x: number;
  y: number;
  scale: number;
}

export interface CanvasViewportSize {
  width: number;
  height: number;
}

export interface CanvasRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CanvasSpatialNode extends CanvasRect {
  id: string;
  kind: "creation" | "upload" | "subtitle";
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasSnapGuide {
  axis: "x" | "y";
  value: number;
  kind: "alignment";
}

export type CanvasLod = "detail" | "overview" | "compact";

export const MAX_DOM_NODES = 160;
const DETAIL_ENTER_WIDTH = 150;
const DETAIL_EXIT_WIDTH = 142;
const COMPACT_ENTER_WIDTH = 68;
const COMPACT_EXIT_WIDTH = 78;
const COMPACT_ENTER_NODE_COUNT = 1_000;
const COMPACT_EXIT_NODE_COUNT = 850;
const DEFAULT_SNAP_THRESHOLD_PX = 8;

export class CanvasSpatialIndex {
  private readonly tree = new RBush<CanvasSpatialNode>();

  constructor(nodes: readonly CanvasSpatialNode[] = []) {
    if (nodes.length) this.tree.load([...nodes]);
  }

  get size(): number {
    return this.tree.all().length;
  }

  replace(nodes: readonly CanvasSpatialNode[]): void {
    this.tree.clear();
    if (nodes.length) this.tree.load([...nodes]);
  }

  insert(node: CanvasSpatialNode): void {
    this.tree.insert(node);
  }

  search(rect: CanvasRect): CanvasSpatialNode[] {
    return this.tree.search(rect).sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function computeContentBounds(nodes: readonly CanvasRect[]): CanvasRect {
  if (!nodes.length) return { minX: -240, minY: -180, maxX: 240, maxY: 180 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.minX);
    minY = Math.min(minY, node.minY);
    maxX = Math.max(maxX, node.maxX);
    maxY = Math.max(maxY, node.maxY);
  }
  return { minX, minY, maxX, maxY };
}

export function viewportWorldRect(
  camera: CanvasCamera,
  viewport: CanvasViewportSize,
  overscanPixels = 320,
): CanvasRect {
  const scale = Math.max(camera.scale, Number.EPSILON);
  return {
    minX: (-camera.x - overscanPixels) / scale,
    minY: (-camera.y - overscanPixels) / scale,
    maxX: (viewport.width - camera.x + overscanPixels) / scale,
    maxY: (viewport.height - camera.y + overscanPixels) / scale,
  };
}

export function selectCanvasLod(options: {
  projectedNodeWidth: number;
  visibleCount: number;
  previous: CanvasLod;
}): CanvasLod {
  const { projectedNodeWidth, visibleCount, previous } = options;
  if (previous === "compact") {
    if (projectedNodeWidth < COMPACT_EXIT_WIDTH || visibleCount > COMPACT_EXIT_NODE_COUNT) return "compact";
  } else if (projectedNodeWidth < COMPACT_ENTER_WIDTH || visibleCount > COMPACT_ENTER_NODE_COUNT) {
    return "compact";
  }
  if (visibleCount > MAX_DOM_NODES) return "overview";
  if (previous === "detail") {
    return projectedNodeWidth < DETAIL_EXIT_WIDTH ? "overview" : "detail";
  }
  return projectedNodeWidth >= DETAIL_ENTER_WIDTH ? "detail" : "overview";
}

interface SnapAnchor {
  value: number;
}

function nearestSnap(values: readonly SnapAnchor[], target: number, threshold: number): (SnapAnchor & { shift: number }) | null {
  let nearest: (SnapAnchor & { shift: number }) | null = null;
  let distance = threshold;
  for (const candidate of values) {
    const nextDistance = Math.abs(candidate.value - target);
    if (nextDistance <= distance) {
      nearest = { ...candidate, shift: candidate.value - target };
      distance = nextDistance;
    }
  }
  return nearest;
}

/**
 * Snap a dragged node set to nearby node edges or center lines without changing
 * the relative positions inside the set. No background grid is involved.
 */
export function snapCanvasPositions(
  origins: Readonly<Record<string, CanvasPoint>>,
  desired: Readonly<Record<string, CanvasPoint>>,
  nodes: readonly CanvasSpatialNode[],
  options: {
    scale: number;
    enabled?: boolean;
    thresholdPixels?: number;
  },
): { positions: Record<string, CanvasPoint>; guides: CanvasSnapGuide[] } {
  const positions = { ...desired };
  const selectedIds = new Set(Object.keys(origins));
  if (!selectedIds.size || options.enabled === false) return { positions, guides: [] };

  const selected = nodes.filter((node) => selectedIds.has(node.id));
  if (!selected.length) return { positions, guides: [] };
  const movedBounds = selected.reduce<CanvasRect>((bounds, node) => {
    const position = desired[node.id] ?? { x: node.minX, y: node.minY };
    const width = node.maxX - node.minX;
    const height = node.maxY - node.minY;
    return {
      minX: Math.min(bounds.minX, position.x),
      minY: Math.min(bounds.minY, position.y),
      maxX: Math.max(bounds.maxX, position.x + width),
      maxY: Math.max(bounds.maxY, position.y + height),
    };
  }, {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
  const targets = nodes.filter((node) => !selectedIds.has(node.id));
  const threshold = (options.thresholdPixels ?? DEFAULT_SNAP_THRESHOLD_PX) / Math.max(options.scale, Number.EPSILON);
  const xAnchors = [movedBounds.minX, (movedBounds.minX + movedBounds.maxX) / 2, movedBounds.maxX];
  const yAnchors = [movedBounds.minY, (movedBounds.minY + movedBounds.maxY) / 2, movedBounds.maxY];
  const xTargets = targets.flatMap((node) => [
    { value: node.minX },
    { value: (node.minX + node.maxX) / 2 },
    { value: node.maxX },
  ]);
  const yTargets = targets.flatMap((node) => [
    { value: node.minY },
    { value: (node.minY + node.maxY) / 2 },
    { value: node.maxY },
  ]);
  const xAlignment = xAnchors.flatMap((anchor) => {
    const candidate = nearestSnap(xTargets, anchor, threshold);
    return candidate === null ? [] : [candidate];
  }).sort((left, right) => Math.abs(left.shift) - Math.abs(right.shift))[0];
  const yAlignment = yAnchors.flatMap((anchor) => {
    const candidate = nearestSnap(yTargets, anchor, threshold);
    return candidate === null ? [] : [candidate];
  }).sort((left, right) => Math.abs(left.shift) - Math.abs(right.shift))[0];

  if (!xAlignment && !yAlignment) return { positions, guides: [] };
  const shiftX = xAlignment?.shift ?? 0;
  const shiftY = yAlignment?.shift ?? 0;
  const nextPositions = Object.fromEntries(
    Object.entries(desired).map(([id, position]) => [id, { x: position.x + shiftX, y: position.y + shiftY }]),
  );
  const guides: CanvasSnapGuide[] = [];
  if (xAlignment) {
    guides.push({
      axis: "x",
      value: xAlignment.value,
      kind: "alignment",
    });
  }
  if (yAlignment) {
    guides.push({
      axis: "y",
      value: yAlignment.value,
      kind: "alignment",
    });
  }
  return { positions: nextPositions, guides };
}

export function fitCameraToBounds(
  bounds: CanvasRect,
  viewport: CanvasViewportSize,
  options: { minScale: number; maxScale: number; padding: number },
): CanvasCamera {
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, viewport.width - options.padding * 2);
  const availableHeight = Math.max(1, viewport.height - options.padding * 2);
  const scale = Math.min(
    options.maxScale,
    Math.max(options.minScale, Math.min(availableWidth / contentWidth, availableHeight / contentHeight)),
  );
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    x: viewport.width / 2 - centerX * scale,
    y: viewport.height / 2 - centerY * scale,
    scale: Math.round(scale * 10_000) / 10_000,
  };
}
