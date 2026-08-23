import { useEffect, useRef } from "react";
import type { CanvasCamera, CanvasRect, CanvasSpatialNode, CanvasViewportSize } from "./canvas-engine";

interface CanvasMinimapProps {
  label: string;
  nodes: readonly CanvasSpatialNode[];
  bounds: CanvasRect;
  camera: CanvasCamera;
  viewport: CanvasViewportSize;
  onNavigate: (worldX: number, worldY: number) => void;
}

const WIDTH = 184;
const HEIGHT = 112;
const PADDING = 8;

export function CanvasMinimap({ label, nodes, bounds, camera, viewport, onNavigate }: CanvasMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((WIDTH - PADDING * 2) / contentWidth, (HEIGHT - PADDING * 2) / contentHeight);
  const offsetX = (WIDTH - contentWidth * scale) / 2 - bounds.minX * scale;
  const offsetY = (HEIGHT - contentHeight * scale) / 2 - bounds.minY * scale;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = "rgba(95, 111, 126, 0.58)";
    for (const node of nodes) {
      context.fillRect(
        node.minX * scale + offsetX,
        node.minY * scale + offsetY,
        Math.max(1, (node.maxX - node.minX) * scale),
        Math.max(1, (node.maxY - node.minY) * scale),
      );
    }
  }, [nodes, offsetX, offsetY, scale]);

  const worldLeft = -camera.x / camera.scale;
  const worldTop = -camera.y / camera.scale;
  const viewportStyle = {
    left: worldLeft * scale + offsetX,
    top: worldTop * scale + offsetY,
    width: viewport.width / camera.scale * scale,
    height: viewport.height / camera.scale * scale,
  };

  return (
    <button
      type="button"
      className="focus-ring absolute bottom-[310px] right-4 z-20 hidden h-[112px] w-[184px] overflow-hidden rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-surface)]/94 shadow-lg backdrop-blur-sm lg:block"
      aria-label={label}
      title={label}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onNavigate(
          (event.clientX - rect.left - offsetX) / scale,
          (event.clientY - rect.top - offsetY) / scale,
        );
      }}
    >
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="h-full w-full" aria-hidden />
      <span
        className="pointer-events-none absolute border border-[var(--color-accent-2)]"
        style={viewportStyle}
        aria-hidden
      />
    </button>
  );
}
