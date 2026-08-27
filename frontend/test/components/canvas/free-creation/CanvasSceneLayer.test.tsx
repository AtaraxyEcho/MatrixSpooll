import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  CanvasSceneLayer,
  type CanvasRenderNode,
  type CanvasRenderRelation,
} from "@/components/canvas/free-creation/CanvasSceneLayer";

describe("CanvasSceneLayer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("uses borderless type markers and only draws exceptional status in overview LOD", async () => {
    const nodes: CanvasRenderNode[] = [
      {
        id: "c_success",
        kind: "creation",
        minX: 0,
        minY: 0,
        maxX: 272,
        maxY: 322,
        label: "success",
        mediaType: "image",
        status: "succeeded",
      },
      {
        id: "c_failed",
        kind: "creation",
        minX: 360,
        minY: 0,
        maxX: 632,
        maxY: 322,
        label: "failed",
        mediaType: "video",
        status: "failed",
      },
    ];

    render(
      <CanvasSceneLayer
        camera={{ x: 0, y: 0, scale: 0.5 }}
        viewport={{ width: 800, height: 600 }}
        nodes={nodes}
        groups={[]}
        selectedIds={new Set()}
        lod="overview"
      />,
    );

    await waitFor(() => expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled());
    const context = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results.at(-1)?.value;
    expect(context?.strokeRect).not.toHaveBeenCalled();
    expect(context?.fillText).not.toHaveBeenCalled();
    expect(context?.fillRect).toHaveBeenCalledTimes(5);
  });

  it("keeps media thumbnails visible in overview LOD", async () => {
    class LoadedImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 320;
      naturalHeight = 180;
      private value = "";

      get src() {
        return this.value;
      }

      set src(value: string) {
        this.value = value;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);

    render(
      <CanvasSceneLayer
        camera={{ x: 0, y: 0, scale: 0.4 }}
        viewport={{ width: 800, height: 600 }}
        nodes={[{
          id: "r_thumbnail",
          kind: "upload",
          minX: 0,
          minY: 0,
          maxX: 272,
          maxY: 153,
          label: "thumbnail",
          mediaType: "image",
          thumbnailUrl: "/api/v1/files/project/thumbnail.png",
        }]}
        groups={[]}
        selectedIds={new Set()}
        lod="overview"
      />,
    );

    const context = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results.at(-1)?.value;
    await waitFor(() => expect(context?.drawImage).toHaveBeenCalledTimes(1));
  });

  it("draws smooth, non-interactive relations before detail cards", async () => {
    const nodes: CanvasRenderNode[] = [
      {
        id: "r_source",
        kind: "upload",
        minX: 0,
        minY: 0,
        maxX: 100,
        maxY: 100,
        label: "source",
        mediaType: "image",
      },
      {
        id: "c_target",
        kind: "creation",
        minX: 300,
        minY: 100,
        maxX: 500,
        maxY: 300,
        label: "target",
        mediaType: "video",
      },
    ];
    const relations: CanvasRenderRelation[] = [{
      id: "r_source->c_target",
      sourceId: "r_source",
      targetId: "c_target",
      active: true,
    }];
    const { container } = render(
      <CanvasSceneLayer
        camera={{ x: 0, y: 0, scale: 1 }}
        viewport={{ width: 800, height: 600 }}
        nodes={nodes}
        groups={[]}
        relations={relations}
        selectedIds={new Set(["c_target"])}
        lod="detail"
      />,
    );

    await waitFor(() => expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled());
    const context = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results.at(-1)?.value;
    expect(context?.bezierCurveTo).toHaveBeenCalledTimes(1);
    expect(context?.arc).toHaveBeenCalledTimes(1);
    expect(container.querySelector("canvas")).toHaveClass("pointer-events-none");
  });
});
