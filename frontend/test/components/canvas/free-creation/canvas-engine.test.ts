import { describe, expect, it } from "vitest";
import {
  CanvasSpatialIndex,
  computeContentBounds,
  fitCameraToBounds,
  selectCanvasLod,
} from "@/components/canvas/free-creation/canvas-engine";

describe("free creation canvas engine", () => {
  it("queries a 10k-node workspace without returning offscreen nodes", () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => ({
      id: `c_${index.toString(16).padStart(20, "0")}`,
      minX: (index % 100) * 360,
      minY: Math.floor(index / 100) * 380,
      maxX: (index % 100) * 360 + 272,
      maxY: Math.floor(index / 100) * 380 + 322,
      kind: "creation" as const,
    }));
    const index = new CanvasSpatialIndex(nodes);

    const visible = index.search({ minX: 0, minY: 0, maxX: 1280, maxY: 720 });

    expect(visible.map((node) => node.id)).toEqual([
      nodes[0]!.id,
      nodes[1]!.id,
      nodes[2]!.id,
      nodes[3]!.id,
      nodes[100]!.id,
      nodes[101]!.id,
      nodes[102]!.id,
      nodes[103]!.id,
    ]);
    expect(index.size).toBe(10_000);
  });

  it("uses hysteresis and a hard DOM budget when selecting LOD", () => {
    expect(selectCanvasLod({ projectedNodeWidth: 150, visibleCount: 80, previous: "detail" })).toBe("detail");
    expect(selectCanvasLod({ projectedNodeWidth: 100, visibleCount: 80, previous: "detail" })).toBe("overview");
    expect(selectCanvasLod({ projectedNodeWidth: 120, visibleCount: 80, previous: "overview" })).toBe("overview");
    expect(selectCanvasLod({ projectedNodeWidth: 132, visibleCount: 80, previous: "overview" })).toBe("overview");
    expect(selectCanvasLod({ projectedNodeWidth: 150, visibleCount: 80, previous: "overview" })).toBe("detail");
    expect(selectCanvasLod({ projectedNodeWidth: 150, visibleCount: 161, previous: "detail" })).toBe("overview");
    expect(selectCanvasLod({ projectedNodeWidth: 48, visibleCount: 2_000, previous: "overview" })).toBe("compact");
  });

  it("derives content bounds for explicit fit-to-content actions", () => {
    const nodes = [
      { id: "left", minX: -500, minY: -200, maxX: -228, maxY: 122, kind: "creation" },
      { id: "right", minX: 800, minY: 300, maxX: 1072, maxY: 622, kind: "creation" },
    ] as const;
    const bounds = computeContentBounds(nodes);

    expect(bounds).toEqual({ minX: -500, minY: -200, maxX: 1072, maxY: 622 });
  });

  it("fits content into the viewport while preserving scale limits", () => {
    expect(fitCameraToBounds(
      { minX: -500, minY: -200, maxX: 1500, maxY: 800 },
      { width: 1000, height: 600 },
      { minScale: 0.4, maxScale: 1.8, padding: 50 },
    )).toEqual({ x: 275, y: 165, scale: 0.45 });
  });

});
