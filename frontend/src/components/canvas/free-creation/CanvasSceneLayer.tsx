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
        const selected = selectedIds.has(node.id);
        context.save();
        if (selected) {
          context.shadowColor = "rgba(185, 157, 238, 0.72)";
          context.shadowBlur = 18 / camera.scale;
        }
        context.fillStyle = nodeFillColor(node.mediaType, lod === "compact");
        context.fillRect(node.minX, node.minY, nodeWidth, nodeHeight);
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
  }, [camera.scale, camera.x, camera.y, groups, lod, nodes, selectedIds, viewport]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}
