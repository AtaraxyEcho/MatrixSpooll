import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { CanvasSceneLayer, type CanvasRenderNode } from "@/components/canvas/free-creation/CanvasSceneLayer";

describe("CanvasSceneLayer", () => {
  beforeEach(() => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockClear();
  });

  it("draws group frames without drawing dependency lines", async () => {
    const nodes: CanvasRenderNode[] = [
      {
        id: "r_first",
        kind: "upload",
        minX: 0,
        minY: 0,
        maxX: 100,
        maxY: 100,
        label: "first",
        mediaType: "image",
      },
    ];

    render(
      <CanvasSceneLayer
        camera={{ x: 0, y: 0, scale: 1 }}
        viewport={{ width: 800, height: 600 }}
        nodes={nodes}
        groups={[{ id: "group-1", minX: -20, minY: -20, maxX: 120, maxY: 120 }]}
        selectedIds={new Set()}
        lod="detail"
      />,
    );

    await waitFor(() => expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled());
    const context = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results.at(-1)?.value;
    expect(context?.strokeRect).toHaveBeenCalledTimes(1);
    expect(context?.lineTo).not.toHaveBeenCalled();
  });
});
