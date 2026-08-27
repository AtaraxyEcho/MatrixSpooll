import { useEffect, useRef, useState } from "react";
import type {
  CanvasCamera,
  CanvasLod,
  CanvasSpatialNode,
  CanvasViewportSize,
} from "./canvas-engine";

export interface CanvasRenderNode extends CanvasSpatialNode {
  label: string;
  mediaType: "image" | "video" | "audio" | "text";
  status?: string;
  thumbnailUrl?: string;
}

export interface CanvasRenderRelation {
  id: string;
  sourceId: string;
  targetId: string;
  active: boolean;
}

interface CanvasRenderGroup {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface CanvasSceneLayerProps {
  camera: CanvasCamera;
  viewport: CanvasViewportSize;
  nodes: CanvasRenderNode[];
  groups: CanvasRenderGroup[];
  relations?: CanvasRenderRelation[];
  selectedIds: ReadonlySet<string>;
  lod: CanvasLod;
}

interface RelationCurve {
  source: { x: number; y: number };
  sourceControl: { x: number; y: number };
  targetControl: { x: number; y: number };
  target: { x: number; y: number };
}

interface ThumbnailCacheEntry {
  image: HTMLImageElement;
  status: "loading" | "ready" | "failed";
}

const MAX_RETAINED_THUMBNAILS = 512;

function relationCurve(source: CanvasRenderNode, target: CanvasRenderNode): RelationCurve {
  const sourceCenter = {
    x: (source.minX + source.maxX) / 2,
    y: (source.minY + source.maxY) / 2,
  };
  const targetCenter = {
    x: (target.minX + target.maxX) / 2,
    y: (target.minY + target.maxY) / 2,
  };
  const deltaX = targetCenter.x - sourceCenter.x;
  const deltaY = targetCenter.y - sourceCenter.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    const direction = deltaX >= 0 ? 1 : -1;
    const start = { x: direction > 0 ? source.maxX : source.minX, y: sourceCenter.y };
    const end = { x: direction > 0 ? target.minX : target.maxX, y: targetCenter.y };
    const controlDistance = Math.max(36, Math.abs(end.x - start.x) * 0.42);
    return {
      source: start,
      sourceControl: { x: start.x + direction * controlDistance, y: start.y },
      targetControl: { x: end.x - direction * controlDistance, y: end.y },
      target: end,
    };
  }
  const direction = deltaY >= 0 ? 1 : -1;
  const start = { x: sourceCenter.x, y: direction > 0 ? source.maxY : source.minY };
  const end = { x: targetCenter.x, y: direction > 0 ? target.minY : target.maxY };
  const controlDistance = Math.max(36, Math.abs(end.y - start.y) * 0.42);
  return {
    source: start,
    sourceControl: { x: start.x, y: start.y + direction * controlDistance },
    targetControl: { x: end.x, y: end.y - direction * controlDistance },
    target: end,
  };
}

function nodeFillColor(mediaType: CanvasRenderNode["mediaType"], compact: boolean): string {
  const alpha = compact ? 0.76 : 0.34;
  if (mediaType === "video") return `rgba(74, 164, 159, ${alpha})`;
  if (mediaType === "audio") return `rgba(194, 143, 67, ${alpha})`;
  if (mediaType === "text") return `rgba(124, 132, 146, ${alpha})`;
  return `rgba(151, 126, 204, ${alpha})`;
}

function typeMarkerColor(mediaType: CanvasRenderNode["mediaType"]): string {
  if (mediaType === "video") return "rgba(104, 211, 202, 0.95)";
  if (mediaType === "audio") return "rgba(239, 181, 89, 0.95)";
  if (mediaType === "text") return "rgba(191, 199, 211, 0.95)";
  return "rgba(192, 166, 244, 0.95)";
}

function drawThumbnailCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  node: CanvasRenderNode,
): void {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const targetWidth = node.maxX - node.minX;
  const targetHeight = node.maxY - node.minY;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  const cropWidth = sourceRatio > targetRatio ? sourceHeight * targetRatio : sourceWidth;
  const cropHeight = sourceRatio > targetRatio ? sourceHeight : sourceWidth / targetRatio;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  context.drawImage(
    image,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    node.minX,
    node.minY,
    targetWidth,
    targetHeight,
  );
}

export function CanvasSceneLayer({
  camera,
  viewport,
  nodes,
  groups,
  relations = [],
  selectedIds,
  lod,
}: CanvasSceneLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbnailCacheRef = useRef(new Map<string, ThumbnailCacheEntry>());
  const [thumbnailRevision, setThumbnailRevision] = useState(0);

  useEffect(() => {
    if (lod === "detail") return;
    const cache = thumbnailCacheRef.current;
    const activeUrls = new Set(nodes.flatMap((node) => node.thumbnailUrl ? [node.thumbnailUrl] : []));
    for (const url of activeUrls) {
      if (cache.has(url)) continue;
      const image = new Image();
      const entry: ThumbnailCacheEntry = { image, status: "loading" };
      cache.set(url, entry);
      image.decoding = "async";
      image.onload = () => {
        entry.status = "ready";
        if (canvasRef.current) setThumbnailRevision((value) => value + 1);
      };
      image.onerror = () => {
        entry.status = "failed";
      };
      image.src = url;
    }
    if (cache.size <= MAX_RETAINED_THUMBNAILS) return;
    for (const url of cache.keys()) {
      if (cache.size <= MAX_RETAINED_THUMBNAILS) break;
      if (!activeUrls.has(url)) cache.delete(url);
    }
  }, [lod, nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.width <= 0 || viewport.height <= 0) return;
    let disposed = false;
    const draw = () => {
      if (disposed) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(viewport.width * dpr));
      const height = Math.max(1, Math.round(viewport.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.setTransform(
        dpr * camera.scale,
        0,
        0,
        dpr * camera.scale,
        dpr * camera.x,
        dpr * camera.y,
      );

      context.lineCap = "round";
      context.lineJoin = "round";
      for (const group of groups) {
        context.fillStyle = "rgba(61, 155, 196, 0.06)";
        context.strokeStyle = "rgba(89, 181, 219, 0.42)";
        context.lineWidth = 1.5 / camera.scale;
        context.setLineDash([8 / camera.scale, 6 / camera.scale]);
        context.fillRect(group.minX, group.minY, group.maxX - group.minX, group.maxY - group.minY);
        context.strokeRect(group.minX, group.minY, group.maxX - group.minX, group.maxY - group.minY);
      }
      context.setLineDash([]);

      if (relations.length) {
        const nodesById = new Map(nodes.map((node) => [node.id, node]));
        for (const relation of relations) {
          const source = nodesById.get(relation.sourceId);
          const target = nodesById.get(relation.targetId);
          if (!source || !target) continue;
          const curve = relationCurve(source, target);
          context.beginPath();
          context.moveTo(curve.source.x, curve.source.y);
          context.bezierCurveTo(
            curve.sourceControl.x,
            curve.sourceControl.y,
            curve.targetControl.x,
            curve.targetControl.y,
            curve.target.x,
            curve.target.y,
          );
          context.strokeStyle = relation.active
            ? "rgba(255, 255, 255, 0.76)"
            : "rgba(255, 255, 255, 0.24)";
          context.lineWidth = (relation.active ? 1.75 : 1.1) / camera.scale;
          context.stroke();
          context.beginPath();
          context.arc(curve.target.x, curve.target.y, (relation.active ? 2.5 : 1.8) / camera.scale, 0, Math.PI * 2);
          context.fillStyle = relation.active
            ? "rgba(255, 255, 255, 0.9)"
            : "rgba(255, 255, 255, 0.42)";
          context.fill();
        }
      }

      if (lod === "detail") return;
      for (const node of nodes) {
        const nodeWidth = node.maxX - node.minX;
        const nodeHeight = node.maxY - node.minY;
        const selected = selectedIds.has(node.id);
        context.save();
        if (selected) {
          context.shadowColor = "rgba(185, 157, 238, 0.72)";
          context.shadowBlur = 18 / camera.scale;
        }
        context.fillStyle = nodeFillColor(node.mediaType, lod === "compact");
        context.fillRect(node.minX, node.minY, nodeWidth, nodeHeight);
        const thumbnail = node.thumbnailUrl ? thumbnailCacheRef.current.get(node.thumbnailUrl) : undefined;
        if (thumbnail?.status === "ready") drawThumbnailCover(context, thumbnail.image, node);
        context.restore();
        if (selected) {
          context.strokeStyle = "rgba(192, 166, 244, 0.98)";
          context.lineWidth = 2 / camera.scale;
          context.strokeRect(node.minX, node.minY, nodeWidth, nodeHeight);
        }
        if (lod === "overview") {
          const markerSize = 9 / camera.scale;
          context.fillStyle = typeMarkerColor(node.mediaType);
          context.fillRect(node.minX + 10 / camera.scale, node.minY + 10 / camera.scale, markerSize, markerSize);
          if (node.status === "failed" || node.status === "running") {
            context.fillStyle = node.status === "failed" ? "rgba(224, 82, 82, 0.98)" : "rgba(192, 166, 244, 0.98)";
            context.fillRect(node.maxX - 19 / camera.scale, node.minY + 10 / camera.scale, markerSize, markerSize);
          }
        }
      }
    };

    draw();
    return () => {
      disposed = true;
    };
  }, [camera.scale, camera.x, camera.y, groups, lod, nodes, relations, selectedIds, thumbnailRevision, viewport]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}
