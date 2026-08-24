import { describe, expect, it } from "vitest";
import { selectCanvasLod, snapCanvasPositions, type CanvasSpatialNode } from "@/components/canvas/free-creation/canvas-engine";

const nodes: CanvasSpatialNode[] = [
  { id: "c_selected", kind: "creation", minX: 100, minY: 100, maxX: 200, maxY: 200 },
  { id: "c_target", kind: "creation", minX: 300, minY: 420, maxX: 400, maxY: 520 },
];

describe("snapCanvasPositions", () => {
  it("snaps a dragged card to a nearby element edge and returns an x guide", () => {
    const result = snapCanvasPositions(
      { c_selected: { x: 100, y: 100 } },
      { c_selected: { x: 202, y: 100 } },
      nodes,
      { scale: 1 },
    );

    expect(result.positions.c_selected).toEqual({ x: 200, y: 100 });
    expect(result.guides).toEqual([
      { axis: "x", value: 300, kind: "alignment" },
    ]);
  });

  it("keeps a free drag unchanged when no element alignment is near", () => {
    const result = snapCanvasPositions(
      { c_selected: { x: 100, y: 100 } },
      { c_selected: { x: 230, y: 265 } },
      nodes,
      { scale: 1 },
    );

    expect(result.positions.c_selected).toEqual({ x: 230, y: 265 });
    expect(result.guides).toEqual([]);
  });

  it("moves a multi-selection as one group and supports temporary disabling", () => {
    const origins = {
      c_selected: { x: 100, y: 100 },
      c_second: { x: 220, y: 100 },
    };
    const desired = {
      c_selected: { x: 202, y: 100 },
      c_second: { x: 302, y: 100 },
    };
    const result = snapCanvasPositions(
      origins,
      desired,
      [...nodes, { id: "c_second", kind: "creation", minX: 220, minY: 100, maxX: 320, maxY: 200 }],
      { scale: 1 },
    );

    expect(result.positions).toMatchObject({
      c_selected: { x: 200, y: 100 },
      c_second: { x: 300, y: 100 },
    });

    const disabled = snapCanvasPositions(origins, desired, nodes, { scale: 1, enabled: false });
    expect(disabled.positions).toEqual(desired);
    expect(disabled.guides).toEqual([]);
  });
});

describe("selectCanvasLod", () => {
  it("keeps compact mode until both exit thresholds are cleared", () => {
    expect(selectCanvasLod({ projectedNodeWidth: 70, visibleCount: 900, previous: "compact" })).toBe("compact");
    expect(selectCanvasLod({ projectedNodeWidth: 80, visibleCount: 840, previous: "compact" })).toBe("overview");
  });

  it("enters compact mode only at the lower threshold", () => {
    expect(selectCanvasLod({ projectedNodeWidth: 63, visibleCount: 100, previous: "overview" })).toBe("compact");
    expect(selectCanvasLod({ projectedNodeWidth: 70, visibleCount: 999, previous: "overview" })).toBe("overview");
  });
});
