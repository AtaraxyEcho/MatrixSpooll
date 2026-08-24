import { useEffect, useRef } from "react";
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
  selectedIds: ReadonlySet<string>;
  lod: CanvasLod;
}

const imageCache = new Map<string, HTMLImageElement>();
const IMAGE_CACHE_LIMIT = 256;

function cacheImage(url: string, image: HTMLImageElement): void {
  imageCache.delete(url);
  imageCache.set(url, image);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (typeof oldest === "string") imageCache.delete(oldest);
  }
}

function statusColor(status?: string): string {
  if (status === "failed" || status === "cancelled") return "#e25555";
  if (status === "running" || status === "queued" || status === "cancelling") return "#d49b46";
  return "#4fa785";
}

function drawImageContain(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  const drawWidth = sourceRatio > targetRatio ? width : height * sourceRatio;
  const drawHeight = sourceRatio > targetRatio ? width / sourceRatio : height;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

export function CanvasSceneLayer({
  camera,
  viewport,
  nodes,
  groups,
  selectedIds,
  lod,
}: CanvasSceneLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.width <= 0 || viewport.height <= 0) return;
    let disposed = false;
    let frame = 0;

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

      if (lod === "detail") return;
      for (const node of nodes) {
        const nodeWidth = node.maxX - node.minX;
        const nodeHeight = node.maxY - node.minY;
        context.fillStyle = "rgba(24, 29, 36, 0.96)";
        context.fillRect(node.minX, node.minY, nodeWidth, nodeHeight);
        if (node.thumbnailUrl) {
          let image = imageCache.get(node.thumbnailUrl);
          if (!image) {
            image = new Image();
            image.decoding = "async";
            image.src = node.thumbnailUrl;
            cacheImage(node.thumbnailUrl, image);
            image.addEventListener("load", () => {
              if (!disposed) frame = window.requestAnimationFrame(draw);
            }, { once: true });
          }
          if (image.complete && image.naturalWidth > 0) {
            const mediaHeight = Math.max(1, nodeHeight - 28);
            drawImageContain(context, image, node.minX, node.minY, nodeWidth, mediaHeight);
          }
        }
        context.fillStyle = statusColor(node.status);
        context.fillRect(node.minX, node.maxY - 6 / camera.scale, nodeWidth, 6 / camera.scale);
        context.strokeStyle = selectedIds.has(node.id) ? "#69c6ea" : "rgba(255,255,255,0.18)";
        context.lineWidth = (selectedIds.has(node.id) ? 3 : 1) / camera.scale;
        context.strokeRect(node.minX, node.minY, nodeWidth, nodeHeight);
        if (lod === "overview" && nodeWidth * camera.scale >= 86) {
          context.fillStyle = "rgba(245,248,251,0.88)";
          context.font = `${12 / camera.scale}px system-ui, sans-serif`;
          context.fillText(node.label.slice(0, 28), node.minX + 10 / camera.scale, node.maxY - 14 / camera.scale);
        }
      }
    };

    draw();
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [camera.scale, camera.x, camera.y, groups, lod, nodes, selectedIds, viewport]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}
