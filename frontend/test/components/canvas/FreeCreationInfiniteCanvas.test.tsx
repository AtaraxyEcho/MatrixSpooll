import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import {
  arrangeCanvasNodes,
  buildCanvasDependencyEdges,
  createCanvasGroupId,
  createCanvasPatchId,
  dependencyLane,
  dependencyPath,
  FreeCreationInfiniteCanvas,
} from "@/components/canvas/FreeCreationInfiniteCanvas";
import i18n from "@/i18n";
import { useFreeCreationStore } from "@/stores/free-creation-store";
import type { FreeCreation, FreeCreationUpload } from "@/types";

const t = i18n.getFixedT("zh", "dashboard");
const creation: FreeCreation = {
  creation_id: "c_0123456789abcdef0123",
  request_id: "q_0123456789abcdef0123",
  output_type: "image",
  media_type: "image",
  status: "succeeded",
  prompt: "paper boat",
  media_path: "creations/c_0123456789abcdef0123.png",
  version: 1,
};

function renderCanvas(creations: FreeCreation[] = [creation]) {
  return render(
    <FreeCreationInfiniteCanvas
      projectName="demo"
      creations={creations}
      uploads={[]}
      readOnly={false}
      actingId={null}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
      onEdit={vi.fn()}
      onReference={vi.fn()}
    />,
  );
}

const textUpload: FreeCreationUpload = {
  reference_id: "r_0123456789abcdef0123",
  type: "upload",
  original_filename: "scene.md",
  media_type: "text",
  path: "uploads/free_creation/r_0123456789abcdef0123.md",
  size_bytes: 42,
  created_at: "2026-08-19T00:00:00Z",
};

const audioUpload: FreeCreationUpload = {
  reference_id: "r_abcdef0123456789abcdef",
  type: "upload",
  original_filename: "voiceover.mp3",
  media_type: "audio",
  path: "uploads/free_creation/r_abcdef0123456789abcdef.mp3",
  size_bytes: 128,
  created_at: "2026-08-19T00:00:00Z",
};

describe("FreeCreationInfiniteCanvas", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useFreeCreationStore.getState().clearSelection();
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(API, "getFreeCreationCanvas").mockResolvedValue({
      canvas: {
        revision: 0,
        viewport: { x: 0, y: 0, scale: 1 },
        positions: {},
        hidden_creation_ids: [],
        updated_at: null,
      },
    });
    vi.spyOn(API, "saveFreeCreationCanvas").mockImplementation(async (_projectName, canvas) => ({
      success: true,
      canvas: {
        revision: 1,
        viewport: canvas.viewport,
        positions: canvas.positions,
        hidden_creation_ids: canvas.hidden_creation_ids,
        updated_at: "2026-08-19T00:00:00Z",
      },
    }));
  });

  it("shows the actionable provider reason on a failed creation card", async () => {
    const reason = "首帧未通过供应商审核：图片可能包含真人肖像或隐私信息。";
    renderCanvas([{
      ...creation,
      status: "failed",
      media_path: undefined,
      error_code: "video_first_frame_content_rejected",
      error: reason,
    }]);

    expect(await screen.findByText(reason)).toBeInTheDocument();
  });

  it("shows a generated video cover before playback", async () => {
    const videoCreation: FreeCreation = {
      ...creation,
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0123.mp4",
      prompt: "train arriving",
      version: 3,
    };
    const { container } = renderCanvas([videoCreation]);

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const video = container.querySelector<HTMLVideoElement>("video");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video?.getAttribute("poster")).toContain(
      "/projects/demo/creations/c_0123456789abcdef0123/cover?v=3",
    );
  });

  it("keeps the default cursor, reserves blank left drag for selection, and pans with the middle button", async () => {
    const { container } = renderCanvas();
    const surface = screen.getByTestId("free-creation-canvas");
    expect(surface).toHaveStyle({ cursor: "default" });

    const transformLayer = Array.from(surface.querySelectorAll<HTMLDivElement>("div"))
      .find((element) => element.style.transform.includes("translate3d"));
    expect(transformLayer).toBeDefined();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 50, clientY: 60 });
    expect(transformLayer?.style.transform).toContain("translate3d(0px, 0px, 0)");
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 50, clientY: 60 });

    fireEvent.pointerDown(surface, { button: 1, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 40, clientY: 60 });
    await waitFor(() => expect(transformLayer?.style.transform).toContain("translate3d(30px, 50px, 0)"));
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 40, clientY: 60 });

    expect(container.querySelector("[data-canvas-id='c_0123456789abcdef0123']")).toBeInTheDocument();
  });

  it("moves a card only from its header and publishes completed selections for export", async () => {
    const { container } = renderCanvas();
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>("[data-canvas-id='c_0123456789abcdef0123']");
      expect(element).toHaveStyle({ left: "96px" });
      return element!;
    });
    const header = card.firstElementChild as HTMLElement;
    const surface = screen.getByTestId("free-creation-canvas");

    fireEvent.pointerDown(header, { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 148, clientY: 132 });
    fireEvent.pointerUp(surface, { pointerId: 3, clientX: 148, clientY: 132 });

    await waitFor(() => expect(card).toHaveStyle({ left: "144px", top: "120px" }));
    expect(useFreeCreationStore.getState().selectedIds).toEqual([creation.creation_id]);
    expect(useFreeCreationStore.getState().selectedRequestId).toBe(creation.request_id);
  });

  it("places a newly uploaded file in the visible canvas without overlapping saved work", async () => {
    vi.mocked(API.getFreeCreationCanvas).mockResolvedValue({
      canvas: {
        revision: 3,
        viewport: { x: 0, y: 0, scale: 1 },
        positions: { [creation.creation_id]: { x: 96, y: 88 } },
        hidden_creation_ids: [],
        updated_at: "2026-08-19T00:00:00Z",
      },
    });
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[creation]}
        uploads={[textUpload]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
      />,
    );

    const creationCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toHaveStyle({ left: "96px", top: "88px" });
      return element!;
    });
    const uploadCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${textUpload.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(`${uploadCard?.style.left}:${uploadCard?.style.top}`).not.toBe(
      `${creationCard.style.left}:${creationCard.style.top}`,
    );
  });

  it("uploads files dropped on the canvas and places them near an open visible position", async () => {
    const onUploadFiles = vi.fn().mockResolvedValue([textUpload]);
    render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[creation]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onUploadFiles={onUploadFiles}
      />,
    );
    const surface = screen.getByTestId("free-creation-canvas");
    const file = new File(["scene"], "scene.md", { type: "text/markdown" });
    fireEvent.dragEnter(surface, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.getByText(t("free_creation_drop_on_canvas"))).toBeInTheDocument();
    fireEvent.drop(surface, {
      clientX: 720,
      clientY: 180,
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledWith([file]));
    expect(screen.queryByText(t("free_creation_drop_on_canvas"))).not.toBeInTheDocument();
  });

  it("uses a reversible canvas hide action and restores hidden work", async () => {
    const { container } = renderCanvas();
    const selector = "[data-canvas-id='c_0123456789abcdef0123']";
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(selector);
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.contextMenu(card, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_hide") }));
    expect(container.querySelector(selector)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) }));
    const restoredCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(selector);
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.contextMenu(restoredCard, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_restore") }));

    expect(container.querySelector(selector)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) })).not.toBeInTheDocument();
  });

  it("does not expose media actions for unfinished cards", async () => {
    renderCanvas([{ ...creation, status: "failed", media_path: undefined }]);
    const card = await waitFor(() => {
      const element = screen.getByText("paper boat").closest<HTMLElement>("[data-canvas-node='true']");
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.contextMenu(card!, { clientX: 120, clientY: 120 });

    expect(screen.queryByRole("menuitem", { name: t("free_creation_use_as_parent") })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: t("free_creation_add_reference") })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: t("free_creation_hide") })).toBeInTheDocument();
  });

  it("opens the card menu from the more button and removes a failed card", async () => {
    const failedCreation = { ...creation, status: "failed" as const, media_path: undefined };
    const onDeleteCreations = vi.fn();
    const onRestoreCreations = vi.fn();
    render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[failedCreation]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onDeleteCreations={onDeleteCreations}
        onRestoreCreations={onRestoreCreations}
      />,
    );
    const card = await waitFor(() => {
      const element = screen.getByText("paper boat").closest<HTMLElement>("[data-canvas-node='true']");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const moreButton = screen.getByRole("button", { name: t("free_creation_more_actions") });

    fireEvent.pointerDown(moreButton, { button: 0, pointerId: 11 });
    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_delete") }));

    await waitFor(() => expect(onDeleteCreations).toHaveBeenCalledWith([failedCreation.creation_id]));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(onRestoreCreations).toHaveBeenCalledWith([failedCreation.creation_id]));
    expect(card).toBeTruthy();
  });

  it("deletes a marquee selection containing generated images and videos", async () => {
    const videoCreation: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0124",
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0124.mp4",
      prompt: "paper boat sailing",
    };
    const onDeleteItems = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[creation, videoCreation]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onDeleteItems={onDeleteItems}
      />,
    );
    const imageCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const videoCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${videoCreation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    vi.spyOn(imageCard!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 272, 322));
    vi.spyOn(videoCard!, "getBoundingClientRect").mockReturnValue(new DOMRect(450, 100, 272, 322));

    const surface = screen.getByTestId("free-creation-canvas");
    fireEvent.pointerDown(surface, { button: 0, pointerId: 12, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(surface, { pointerId: 12, clientX: 780, clientY: 470 });
    fireEvent.pointerUp(surface, { pointerId: 12, clientX: 780, clientY: 470 });
    fireEvent.contextMenu(videoCard!, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", {
      name: t("free_creation_delete_selected", { count: 2 }),
    }));

    await waitFor(() => expect(onDeleteItems).toHaveBeenCalledTimes(1));
    expect(onDeleteItems).toHaveBeenCalledWith({
      creationIds: [creation.creation_id, videoCreation.creation_id],
      referenceIds: [],
    });
    expect(screen.queryByRole("button", { name: t("free_creation_show_hidden", { count: 2 }) })).not.toBeInTheDocument();
  });

  it("shows the canvas keyboard shortcut panel", async () => {
    renderCanvas();
    const shortcutButton = await screen.findByRole("button", { name: t("free_creation_shortcuts") });
    fireEvent.click(shortcutButton);

    expect(screen.getByRole("dialog", { name: t("free_creation_shortcuts") })).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_shortcut_undo"))).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_shortcut_reference"))).toBeInTheDocument();
  });

  it("keeps a multi-selection on right click and exposes video merge", async () => {
    const first: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0123",
      output_type: "video",
      media_type: "video",
      prompt: "first clip",
    };
    const second: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0124",
      output_type: "video",
      media_type: "video",
      prompt: "second clip",
    };
    const onMerge = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[first, second]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onMerge={onMerge}
      />,
    );
    const firstCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${first.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const secondCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${second.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.pointerDown(firstCard!, { button: 0, pointerId: 20, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(secondCard!, { button: 0, pointerId: 21, shiftKey: true, clientX: 100, clientY: 100 });
    fireEvent.contextMenu(secondCard!, { clientX: 120, clientY: 120 });

    const mergeAction = await screen.findByRole("menuitem", { name: t("free_creation_merge_selected") });
    fireEvent.click(mergeAction);
    expect(onMerge).toHaveBeenCalledWith([first.creation_id, second.creation_id]);
  });

  it("offers voice compositing for exactly one selected video and one audio artifact", async () => {
    const video: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0124",
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0124.mp4",
      prompt: "station clip",
    };
    const audio: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0125",
      output_type: "audio",
      media_type: "audio",
      media_path: "audio/segment_c_0123456789abcdef0125.wav",
      prompt: "station voice",
    };
    const onCompositeAudio = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[video, audio]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onCompositeAudio={onCompositeAudio}
      />,
    );
    const videoCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${video.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const audioCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${audio.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.pointerDown(videoCard!, { button: 0, pointerId: 60 });
    fireEvent.pointerDown(audioCard!, { button: 0, pointerId: 61, shiftKey: true });
    fireEvent.contextMenu(audioCard!, { clientX: 120, clientY: 120 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t("free_creation_composite_audio") }));

    expect(onCompositeAudio).toHaveBeenCalledWith(video.creation_id, audio.creation_id);
  });

  it("groups selected cards and moves the group from any member", async () => {
    const second: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0124",
      prompt: "second image",
    };
    const { container } = renderCanvas([creation, second]);
    const firstCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const secondCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${second.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.pointerDown(firstCard!, { button: 0, pointerId: 70 });
    fireEvent.pointerDown(secondCard!, { button: 0, pointerId: 71, shiftKey: true });
    fireEvent.contextMenu(secondCard!, { clientX: 120, clientY: 120 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t("free_creation_group_selected") }));
    expect(document.querySelector("[data-canvas-group]")).toBeInTheDocument();
    expect(screen.getByTestId("free-creation-canvas")).toBeInTheDocument();

    const firstHeader = firstCard!.firstElementChild as HTMLElement;
    const surface = screen.getByTestId("free-creation-canvas");
    fireEvent.pointerDown(firstHeader, { button: 0, pointerId: 72, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 72, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(surface, { pointerId: 72, clientX: 140, clientY: 130 });

    await waitFor(() => expect(firstCard).toHaveStyle({ left: "136px", top: "118px" }));
    expect(secondCard).toHaveStyle({ left: "480px", top: "118px" });
  });

  it("creates a valid group id without crypto.randomUUID", () => {
    const originalRandomUuid = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      expect(createCanvasGroupId()).toMatch(/^g_[a-f0-9]{20}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUuid });
    }
  });

  it("creates a valid patch UUID without crypto.randomUUID", () => {
    const originalRandomUuid = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      expect(createCanvasPatchId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUuid });
    }
  });

  it("deduplicates dependency edges and arranges connected nodes from inputs to outputs", () => {
    const source: FreeCreation = { ...creation, creation_id: "c_source0123456789abcd", prompt: "source" };
    const target: FreeCreation = {
      ...creation,
      creation_id: "c_target0123456789abcd",
      output_type: "video",
      media_type: "video",
      prompt: "target",
      reference_claims: [
        { type: "creation", creation_id: source.creation_id, role: "reference_image" },
        { type: "creation", creation_id: source.creation_id, role: "first_frame" },
      ],
    };
    const edges = buildCanvasDependencyEdges([source, target]);
    expect(edges).toEqual([{ sourceId: source.creation_id, targetId: target.creation_id }]);

    const arranged = arrangeCanvasNodes(
      [source.creation_id, target.creation_id],
      {
        [source.creation_id]: { x: 96, y: 88 },
        [target.creation_id]: { x: 96, y: 88 },
      },
      [source, target],
      [],
    );
    expect(arranged[target.creation_id].x).toBeGreaterThan(arranged[source.creation_id].x);
    expect(arranged[source.creation_id].y).toBe(88);
    expect(arranged[target.creation_id].y).toBe(88);
  });

  it("routes relations with straight segments instead of curved paths", () => {
    const source = { x: 0, y: 0, width: 100, height: 80 };
    const target = { x: 240, y: 120, width: 100, height: 80 };
    const path = dependencyPath(source, target, 0);

    expect(path).toBe("M 100 40 L 170 40 L 170 160 L 240 160");
    expect(path).not.toMatch(/[CSQ]/);
  });

  it("assigns relation lanes per target instead of using the global edge order", () => {
    const edges = [
      { sourceId: "c_source_b", targetId: "c_target" },
      { sourceId: "c_other", targetId: "c_other_target" },
      { sourceId: "c_source_a", targetId: "c_target" },
    ];

    expect(dependencyLane(edges[2], edges)).toBe(0);
    expect(dependencyLane(edges[0], edges)).toBe(-1);
  });

  it("arranges the canvas from the toolbar and keeps the change undoable", async () => {
    const source: FreeCreation = { ...creation, creation_id: "c_source0123456789abcd", prompt: "source" };
    const target: FreeCreation = {
      ...creation,
      creation_id: "c_target0123456789abcd",
      output_type: "video",
      media_type: "video",
      prompt: "target",
      reference_claims: [{ type: "creation", creation_id: source.creation_id, role: "reference_image" }],
    };
    vi.mocked(API.getFreeCreationCanvas).mockResolvedValue({
      canvas: {
        revision: 2,
        viewport: { x: 0, y: 0, scale: 1 },
        positions: {
          [source.creation_id]: { x: 96, y: 88 },
          [target.creation_id]: { x: 96, y: 88 },
        },
        hidden_creation_ids: [],
        updated_at: "2026-08-19T00:00:00Z",
      },
    });
    const { container } = renderCanvas([source, target]);
    await waitFor(() => expect(container.querySelectorAll("[data-canvas-node='true']")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_arrange_all") }));

    await waitFor(() => {
      const sourceCard = container.querySelector<HTMLElement>(`[data-canvas-id='${source.creation_id}']`);
      const targetCard = container.querySelector<HTMLElement>(`[data-canvas-id='${target.creation_id}']`);
      expect(Number.parseInt(targetCard?.style.left ?? "0", 10)).toBeGreaterThan(Number.parseInt(sourceCard?.style.left ?? "0", 10));
    });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(container.querySelector<HTMLElement>(`[data-canvas-id='${target.creation_id}']`)).toHaveStyle({ left: "96px" }));
  });

  it("projects subtitle tracks as visible editable canvas cards", async () => {
    const video: FreeCreation = {
      ...creation,
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0123.mp4",
    };
    const onEditSubtitle = vi.fn();
    render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[video]}
        uploads={[]}
        subtitleTracks={[{
          subtitle_id: "sub_0123456789abcdef0123",
          creation_id: video.creation_id,
          revision: 1,
          cues: [{ start_seconds: 0, end_seconds: 4, text: "The train arrives." }],
          created_at: "2026-08-19T00:00:00Z",
          updated_at: "2026-08-19T00:00:00Z",
        }]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onEditSubtitle={onEditSubtitle}
      />,
    );

    const subtitleCard = await screen.findByRole("button", { name: t("free_creation_subtitle_title") });
    expect(screen.getByText("The train arrives.")).toBeInTheDocument();
    fireEvent.click(subtitleCard);
    expect(onEditSubtitle).toHaveBeenCalledWith(video.creation_id);
  });

  it("synchronizes selection when opening a card menu from the more button", async () => {
    const second: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0124",
      prompt: "second image",
    };
    const { container } = renderCanvas([creation, second]);
    await waitFor(() => expect(container.querySelectorAll("[data-canvas-node='true']")).toHaveLength(2));

    const moreButtons = screen.getAllByRole("button", { name: t("free_creation_more_actions") });
    fireEvent.click(moreButtons[1]);

    expect(useFreeCreationStore.getState().selectedIds).toEqual([second.creation_id]);
    expect(document.activeElement).toHaveAttribute("role", "menuitem");
  });

  it("pans instead of moving a card while Space is held", async () => {
    const { container } = renderCanvas();
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const header = card.firstElementChild as HTMLElement;
    const surface = screen.getByTestId("free-creation-canvas");
    const transformLayer = Array.from(surface.querySelectorAll<HTMLDivElement>("div"))
      .find((element) => element.style.transform.includes("translate3d"));

    fireEvent.keyDown(window, { code: "Space", key: " " });
    fireEvent.pointerDown(header, { button: 0, pointerId: 52, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 52, clientX: 148, clientY: 132 });
    fireEvent.pointerUp(surface, { pointerId: 52, clientX: 148, clientY: 132 });
    fireEvent.keyUp(window, { code: "Space", key: " " });

    await waitFor(() => expect(transformLayer?.style.transform).toContain("translate3d(272px, 32px, 0)"));
    expect(card).toHaveStyle({ left: "96px", top: "88px" });
  });

  it("does not clear selection when Escape is pressed in an editor", async () => {
    const { container } = render(
      <>
        <input aria-label="editor" />
        <FreeCreationInfiniteCanvas
          projectName="demo"
          creations={[creation]}
          uploads={[]}
          readOnly={false}
          actingId={null}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          onEdit={vi.fn()}
          onReference={vi.fn()}
        />
      </>,
    );
    const card = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(node).toBeInTheDocument();
      return node;
    });
    fireEvent.pointerDown(card!, { button: 0, pointerId: 53 });
    const editor = screen.getByRole("textbox", { name: "editor" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape" });

    expect(useFreeCreationStore.getState().selectedIds).toEqual([creation.creation_id]);
  });

  it("prunes selection when a node disappears from refreshed canvas data", async () => {
    const view = renderCanvas([creation]);
    const card = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(node).toBeInTheDocument();
      return node;
    });
    fireEvent.pointerDown(card!, { button: 0, pointerId: 54 });
    expect(useFreeCreationStore.getState().selectedIds).toEqual([creation.creation_id]);

    view.rerender(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
      />,
    );
    await waitFor(() => expect(useFreeCreationStore.getState().selectedIds).toEqual([]));
  });

  it("waits for a delete operation before allowing its undo", async () => {
    let resolveDelete: ((value: boolean) => void) | undefined;
    const onDeleteCreations = vi.fn(() => new Promise<boolean>((resolve) => { resolveDelete = resolve; }));
    const onRestoreCreations = vi.fn(() => true);
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[{ ...creation, status: "failed", media_path: undefined }]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onDeleteCreations={onDeleteCreations}
        onRestoreCreations={onRestoreCreations}
      />,
    );
    const card = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(node).toBeInTheDocument();
      return node;
    });
    fireEvent.contextMenu(card!, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_delete") }));
    await waitFor(() => expect(onDeleteCreations).toHaveBeenCalledWith([creation.creation_id]));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(onRestoreCreations).not.toHaveBeenCalled();
    resolveDelete?.(true);
    await waitFor(() => expect(onDeleteCreations).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(onRestoreCreations).toHaveBeenCalledWith([creation.creation_id]));
  });

  it("adds every compatible item in a multi-selection as a reference", async () => {
    const second: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0124",
      prompt: "second image",
    };
    const onReferences = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[creation, second]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onReferences={onReferences}
      />,
    );
    const firstCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const secondCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${second.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.pointerDown(firstCard, { button: 0, pointerId: 30 });
    fireEvent.pointerDown(secondCard, { button: 0, pointerId: 31, shiftKey: true });
    fireEvent.contextMenu(secondCard, { clientX: 120, clientY: 120 });
    fireEvent.click(await screen.findByRole("menuitem", {
      name: t("free_creation_add_selected_references", { count: 2 }),
    }));

    expect(onReferences).toHaveBeenCalledWith([
      {
        claim: { type: "creation", creation_id: creation.creation_id, version: creation.version, role: "reference_image" },
        label: creation.prompt,
      },
      {
        claim: { type: "creation", creation_id: second.creation_id, version: second.version, role: "reference_image" },
        label: second.prompt,
      },
    ]);
  });

  it("hides every item in a multi-selection from one context action", async () => {
    const second: FreeCreation = {
      ...creation,
      creation_id: "c_0123456789abcdef0124",
      prompt: "second image",
    };
    const { container } = renderCanvas([creation, second]);
    const firstCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const secondCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${second.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.pointerDown(firstCard, { button: 0, pointerId: 32 });
    fireEvent.pointerDown(secondCard, { button: 0, pointerId: 33, shiftKey: true });
    fireEvent.contextMenu(secondCard, { clientX: 120, clientY: 120 });
    fireEvent.click(await screen.findByRole("menuitem", {
      name: t("free_creation_hide"),
    }));

    expect(container.querySelector(`[data-canvas-id='${creation.creation_id}']`)).not.toBeInTheDocument();
    expect(container.querySelector(`[data-canvas-id='${second.creation_id}']`)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("free_creation_show_hidden", { count: 2 }) })).toBeInTheDocument();
  });

  it("removes every selected upload from the workspace in one context action", async () => {
    const secondUpload = { ...textUpload, reference_id: "r_abcdef0123456789abcde", original_filename: "character.md" };
    const onDeleteItems = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[textUpload, secondUpload]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onDeleteItems={onDeleteItems}
      />,
    );
    const firstCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${textUpload.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const secondCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${secondUpload.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.pointerDown(firstCard!, { button: 0, pointerId: 41 });
    fireEvent.pointerDown(secondCard!, { button: 0, pointerId: 42, shiftKey: true });
    fireEvent.contextMenu(secondCard!, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", {
      name: t("free_creation_delete_selected", { count: 2 }),
    }));

    await waitFor(() => expect(onDeleteItems).toHaveBeenCalledTimes(1));
    expect(onDeleteItems).toHaveBeenCalledWith({
      creationIds: [],
      referenceIds: [textUpload.reference_id, secondUpload.reference_id],
    });
  });

  it("restores hidden uploads from an explicit toolbar action", async () => {
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[textUpload]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
      />,
    );
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${textUpload.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.contextMenu(card, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_hide") }));

    expect(container.querySelector(`[data-canvas-id='${textUpload.reference_id}']`)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_restore_all_hidden", { count: 1 }) }));

    expect(await screen.findByText(textUpload.original_filename)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) })).not.toBeInTheDocument();
  });

  it("selects every visible canvas item with Ctrl/Cmd+A without hijacking text inputs", async () => {
    const { container } = render(
      <>
        <input aria-label="editor" />
        <FreeCreationInfiniteCanvas
          projectName="demo"
          creations={[creation]}
          uploads={[textUpload]}
          readOnly={false}
          actingId={null}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          onEdit={vi.fn()}
          onReference={vi.fn()}
        />
      </>,
    );
    const creationCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const uploadCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${textUpload.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    await waitFor(() => {
      expect(creationCard).toHaveClass("border-[var(--color-accent)]");
      expect(uploadCard).toHaveClass("border-[var(--color-accent)]");
    });

    fireEvent.keyDown(window, { key: "Escape" });
    const editor = screen.getByRole("textbox", { name: "editor" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    expect(creationCard).not.toHaveClass("border-[var(--color-accent)]");
    expect(uploadCard).not.toHaveClass("border-[var(--color-accent)]");
  });

  it("undoes the latest canvas content change with Ctrl/Cmd+Z", async () => {
    const { container } = renderCanvas();
    const selector = `[data-canvas-id='${creation.creation_id}']`;
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(selector);
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.contextMenu(card, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_hide") }));
    expect(container.querySelector(selector)).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => expect(container.querySelector(selector)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(container.querySelector(selector)).not.toBeInTheDocument());
  });

  it("restores a removed reference with Ctrl/Cmd+Z", async () => {
    const onDeleteUpload = vi.fn();
    const onRestoreUpload = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[textUpload]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onDeleteUpload={onDeleteUpload}
        onRestoreUpload={onRestoreUpload}
      />,
    );
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${textUpload.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.contextMenu(card!, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_delete") }));
    await waitFor(() => expect(onDeleteUpload).toHaveBeenCalledWith(textUpload.reference_id));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(onRestoreUpload).toHaveBeenCalledWith(textUpload.reference_id));
  });

  it("zooms the canvas with Alt+wheel and blocks browser Ctrl/Cmd+wheel zoom", async () => {
    renderCanvas();
    const surface = screen.getByTestId("free-creation-canvas");
    await waitFor(() => expect(screen.getByText("100%")).toBeInTheDocument());

    fireEvent.wheel(surface, { deltaY: -100, altKey: true });
    await waitFor(() => expect(screen.getByText("120%")).toBeInTheDocument());

    const browserZoom = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
    });
    surface.dispatchEvent(browserZoom);
    expect(browserZoom.defaultPrevented).toBe(true);
    expect(screen.getByText("120%")).toBeInTheDocument();
  });

  it("uses Ctrl/Cmd-click for references and double-click for previews", async () => {
    const onReference = vi.fn();
    const onPreview = vi.fn();
    render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[textUpload]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={onReference}
        onPreview={onPreview}
      />,
    );

    const card = await waitFor(() => {
      const element = screen.getByText(textUpload.original_filename).closest<HTMLElement>("[data-canvas-node='true']");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const media = card?.querySelector<HTMLElement>('[role="button"]');
    expect(media).toBeTruthy();
    fireEvent.click(media!);
    expect(onReference).not.toHaveBeenCalled();
    fireEvent.click(media!, { ctrlKey: true });
    expect(onReference).toHaveBeenCalledWith(
      { type: "upload", reference_id: textUpload.reference_id, role: "prompt_context" },
      textUpload.original_filename,
    );
    fireEvent.doubleClick(card!);
    expect(onPreview).toHaveBeenCalledWith({ kind: "upload", upload: textUpload });
  });

  it("does not treat an internal card drag as a file upload", async () => {
    const onUploadFiles = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[textUpload]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={vi.fn()}
        onUploadFiles={onUploadFiles}
      />,
    );
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${textUpload.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const surface = screen.getByTestId("free-creation-canvas");
    const file = new File(["scene"], "scene.md", { type: "text/markdown" });
    fireEvent.dragStart(card!, { dataTransfer: { types: ["Files"], files: [file] } });
    const dropTarget = card?.querySelector("svg") ?? surface;
    fireEvent.drop(dropTarget, {
      clientX: 720,
      clientY: 180,
      dataTransfer: { types: ["Files"], files: [file] },
    });

    expect(onUploadFiles).not.toHaveBeenCalled();
  });

  it("renders voiceover uploads with native playback and an explicit reference action", async () => {
    const onReference = vi.fn();
    render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[audioUpload]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={onReference}
      />,
    );

    const card = await waitFor(() => {
      const element = screen.getByText(audioUpload.original_filename).closest<HTMLElement>("[data-canvas-node='true']");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const audio = card?.querySelector("audio");
    expect(audio).toBeInTheDocument();
    expect(audio).toHaveAttribute("src", expect.stringContaining(audioUpload.path));
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_add_reference") }));
    expect(onReference).toHaveBeenCalledWith(
      { type: "upload", reference_id: audioUpload.reference_id, role: "reference_audio" },
      audioUpload.original_filename,
    );
  });

  it("renders generated voice as a versioned canvas artifact", async () => {
    const voice: FreeCreation = {
      ...creation,
      creation_id: "c_audio0123456789abcdef",
      output_type: "audio",
      media_type: "audio",
      prompt: "voiceover line",
      media_path: "audio/segment_c_audio0123456789abcdef.wav",
    };
    const onReference = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[voice]}
        uploads={[]}
        readOnly={false}
        actingId={null}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onReference={onReference}
      />,
    );

    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${voice.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(card?.querySelector("audio")).toHaveAttribute("src", expect.stringContaining(voice.creation_id));
    fireEvent.contextMenu(card!, { clientX: 120, clientY: 120 });
    expect(screen.queryByRole("menuitem", { name: t("free_creation_use_as_parent") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_add_reference") }));
    expect(onReference).toHaveBeenCalledWith(
      { type: "creation", creation_id: voice.creation_id, version: voice.version, role: "reference_audio" },
      voice.prompt,
    );
  });
});
