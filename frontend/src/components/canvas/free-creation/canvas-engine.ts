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

export type CanvasLod = "detail" | "overview" | "compact";

export const MAX_DOM_NODES = 160;
const DETAIL_ENTER_WIDTH = 130;
const DETAIL_EXIT_WIDTH = 110;
const COMPACT_WIDTH = 64;
const COMPACT_NODE_COUNT = 1_000;

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
  if (projectedNodeWidth < COMPACT_WIDTH || visibleCount > COMPACT_NODE_COUNT) return "compact";
  if (visibleCount > MAX_DOM_NODES) return "overview";
  if (previous === "detail") {
    return projectedNodeWidth < DETAIL_EXIT_WIDTH ? "overview" : "detail";
  }
  return projectedNodeWidth >= DETAIL_ENTER_WIDTH ? "detail" : "overview";
}

export function clampCameraToBounds(
  camera: CanvasCamera,
  bounds: CanvasRect,
  viewport: CanvasViewportSize,
): CanvasCamera {
  const scale = camera.scale;
  const minX = viewport.width / 2 - bounds.maxX * scale;
  const maxX = viewport.width / 2 - bounds.minX * scale;
  const minY = viewport.height / 2 - bounds.maxY * scale;
  const maxY = viewport.height / 2 - bounds.minY * scale;
  return {
    x: Math.min(maxX, Math.max(minX, camera.x)),
    y: Math.min(maxY, Math.max(minY, camera.y)),
    scale,
  };
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

export function orthogonalEdgePoints(source: CanvasRect, target: CanvasRect, lane: number): Array<{ x: number; y: number }> {
  const laneOffset = lane * 18;
  const sourceCenterX = (source.minX + source.maxX) / 2;
  const targetCenterX = (target.minX + target.maxX) / 2;
  const sourceCenterY = (source.minY + source.maxY) / 2;
  const targetCenterY = (target.minY + target.maxY) / 2;
  const horizontallySeparated = source.maxX <= target.minX || target.maxX <= source.minX;
  if (horizontallySeparated) {
    const forward = sourceCenterX <= targetCenterX;
    const sourceX = forward ? source.maxX : source.minX;
    const targetX = forward ? target.minX : target.maxX;
    if (lane === 0 && Math.abs(sourceCenterY - targetCenterY) < 10) {
      return [{ x: sourceX, y: sourceCenterY }, { x: targetX, y: targetCenterY }];
    }
    const elbowX = (sourceX + targetX) / 2 + laneOffset * (forward ? 1 : -1);
    return [
      { x: sourceX, y: sourceCenterY },
      { x: elbowX, y: sourceCenterY },
      { x: elbowX, y: targetCenterY },
      { x: targetX, y: targetCenterY },
    ];
  }
  const forward = sourceCenterY <= targetCenterY;
  const sourceY = forward ? source.maxY : source.minY;
  const targetY = forward ? target.minY : target.maxY;
  if (lane === 0 && Math.abs(sourceCenterX - targetCenterX) < 10) {
    return [{ x: sourceCenterX, y: sourceY }, { x: targetCenterX, y: targetY }];
  }
  const elbowY = (sourceY + targetY) / 2 + laneOffset * (forward ? 1 : -1);
  return [
    { x: sourceCenterX, y: sourceY },
    { x: sourceCenterX, y: elbowY },
    { x: targetCenterX, y: elbowY },
    { x: targetCenterX, y: targetY },
  ];
}
