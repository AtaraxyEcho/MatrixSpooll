import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import {
  arrangeCanvasNodes,
  buildCanvasDependencyEdges,
  createCanvasGroupId,
  createCanvasPatchId,
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

function selectCanvasNode(node: HTMLElement, pointerId: number, shiftKey = false) {
  const point = { clientX: 100, clientY: 100 };
  fireEvent.pointerDown(node, { button: 0, pointerId, shiftKey, ...point });
  fireEvent.pointerUp(screen.getByTestId("free-creation-canvas"), { pointerId, shiftKey, ...point });
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

  it("uses media-only card chrome with floating labels and exceptional status dots", async () => {
    const failed = {
      ...creation,
      creation_id: "c_failed0123456789abcde",
      status: "failed" as const,
      media_path: undefined,
      prompt: "failed frame",
      error: "provider rejected the frame",
    };
    const running = {
      ...creation,
      creation_id: "c_running123456789abcde",
      status: "running" as const,
      media_path: undefined,
      prompt: "running frame",
    };
    const { container } = renderCanvas([creation, failed, running]);
    const successCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const failedCard = container.querySelector<HTMLElement>(`[data-canvas-id='${failed.creation_id}']`)!;
    const runningCard = container.querySelector<HTMLElement>(`[data-canvas-id='${running.creation_id}']`)!;
    const mediaCard = successCard.querySelector<HTMLElement>("[data-canvas-drag-surface='true']");
    const floatingLabel = successCard.querySelector<HTMLElement>(".canvas-node-label");

    expect(mediaCard).toHaveClass("rounded-lg", "overflow-hidden");
    expect(mediaCard?.className).not.toContain("border");
    expect(floatingLabel).toHaveStyle({ "--canvas-label-inverse-scale": "1" });
    expect(successCard.querySelector("[data-canvas-status]")).not.toBeInTheDocument();
    expect(failedCard.querySelector("[data-canvas-status='failed']")).toBeInTheDocument();
    expect(runningCard.querySelector("[data-canvas-status='running']")).toBeInTheDocument();
  });

  it("shows loading, ready, and decode-error states without leaving a blank media card", async () => {
    const { container } = renderCanvas();
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const media = card.querySelector<HTMLElement>("[data-canvas-media-state]")!;
    const image = card.querySelector<HTMLImageElement>("img")!;

    expect(media).toHaveAttribute("data-canvas-media-state", "loading");
    fireEvent.load(image);
    expect(media).toHaveAttribute("data-canvas-media-state", "ready");
    fireEvent.error(image);
    expect(media).toHaveAttribute("data-canvas-media-state", "error");
    expect(screen.getAllByText("paper boat").length).toBeGreaterThan(0);
  });

  it("sizes visual cards from their declared and intrinsic media aspect ratios", async () => {
    const { container } = renderCanvas([{ ...creation, aspect_ratio: "16:9" }]);
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const media = card.querySelector<HTMLElement>("[data-canvas-media-state]")!;
    const image = card.querySelector<HTMLImageElement>("img")!;

    expect(card).toHaveStyle({ height: "153px" });
    expect(media.className).not.toContain("bg-black");

    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 600 },
      naturalHeight: { configurable: true, value: 1800 },
    });
    fireEvent.load(image);
    await waitFor(() => expect(card).toHaveStyle({ height: "816px" }));
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
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
    fireEvent.loadedMetadata(video!);
    expect(video?.currentTime).toBe(0.1);
  });

  it("plays a generated video from the card without turning the video frame into a drag blocker", async () => {
    const videoCreation: FreeCreation = {
      ...creation,
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0123.mp4",
    };
    const { container } = renderCanvas([videoCreation]);
    const video = await waitFor(() => {
      const element = container.querySelector<HTMLVideoElement>("video");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const play = vi.spyOn(video, "play").mockResolvedValue();

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_video_play") }));

    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(video).toHaveClass("pointer-events-none");
  });

  it("keeps the default cursor, reserves blank left drag for selection, and freely pans beyond content bounds", async () => {
    renderCanvas();
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
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 5_010, clientY: -4_990 });
    await waitFor(() => expect(transformLayer?.style.transform).toContain("translate3d(5000px, -5000px, 0)"));
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 5_010, clientY: -4_990 });
    await waitFor(() => expect(transformLayer?.style.transform).toContain("translate3d(5000px, -5000px, 0)"));

  });

  it("moves a card from its media surface only after the desktop drag threshold", async () => {
    const { container } = renderCanvas();
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>("[data-canvas-id='c_0123456789abcdef0123']");
      expect(element).toHaveStyle({ left: "96px" });
      return element!;
    });
    const dragSurface = card.querySelector<HTMLElement>("[data-canvas-drag-surface='true']");
    expect(dragSurface).toBeInTheDocument();
    const surface = screen.getByTestId("free-creation-canvas");

    fireEvent.pointerDown(dragSurface!, { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 103, clientY: 100 });
    expect(card).toHaveStyle({ left: "96px", top: "88px" });
    expect(card).toHaveAttribute("data-dragging", "false");
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 148, clientY: 132 });
    await waitFor(() => expect(card).toHaveAttribute("data-dragging", "true"));
    fireEvent.pointerUp(surface, { pointerId: 3, clientX: 148, clientY: 132 });

    await waitFor(() => expect(card).toHaveStyle({ left: "144px", top: "120px" }));
    expect(useFreeCreationStore.getState().selectedIds).toEqual([creation.creation_id]);
    expect(useFreeCreationStore.getState().selectedRequestId).toBe(creation.request_id);
  });

  it("moves a video card when dragging directly from the video frame", async () => {
    const videoCreation: FreeCreation = {
      ...creation,
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0123.mp4",
    };
    const { container } = renderCanvas([videoCreation]);
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toHaveStyle({ left: "96px", top: "88px" });
      return element!;
    });
    const video = card.querySelector<HTMLVideoElement>("video")!;
    const surface = screen.getByTestId("free-creation-canvas");

    fireEvent.pointerDown(video, { button: 0, pointerId: 31, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 31, clientX: 148, clientY: 132 });
    fireEvent.pointerUp(surface, { pointerId: 31, clientX: 148, clientY: 132 });

    await waitFor(() => expect(card).toHaveStyle({ left: "144px", top: "120px" }));
  });

  it("requires a short hold and the wider threshold before dragging with touch", async () => {
    const { container } = renderCanvas();
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toHaveStyle({ left: "96px", top: "88px" });
      return element!;
    });
    const dragSurface = card.querySelector<HTMLElement>("[data-canvas-drag-surface='true']")!;
    const surface = screen.getByTestId("free-creation-canvas");

    fireEvent.pointerDown(dragSurface, { button: 0, pointerId: 4, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 4, pointerType: "touch", clientX: 120, clientY: 100 });
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    expect(card).toHaveStyle({ left: "96px", top: "88px" });

    await new Promise((resolve) => window.setTimeout(resolve, 230));
    fireEvent.pointerMove(surface, { pointerId: 4, pointerType: "touch", clientX: 124, clientY: 100 });
    await waitFor(() => expect(card).toHaveStyle({ left: "120px", top: "88px" }));
    fireEvent.pointerUp(surface, { pointerId: 4, pointerType: "touch", clientX: 124, clientY: 100 });
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

  it("keeps destructive actions last in both image and video context menus", async () => {
    for (const mediaType of ["image", "video"] as const) {
      const item: FreeCreation = {
        ...creation,
        output_type: mediaType,
        media_type: mediaType,
        media_path: `creations/c_0123456789abcdef0123.${mediaType === "video" ? "mp4" : "png"}`,
      };
      const { container, unmount } = render(
        <FreeCreationInfiniteCanvas
          projectName="demo"
          creations={[item]}
          uploads={[]}
          readOnly={false}
          actingId={null}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          onEdit={vi.fn()}
          onReference={vi.fn()}
          onDeleteCreations={vi.fn()}
        />,
      );
      const card = await waitFor(() => {
        const element = container.querySelector<HTMLElement>(`[data-canvas-id='${item.creation_id}']`);
        expect(element).toBeInTheDocument();
        return element!;
      });

      fireEvent.contextMenu(card, { clientX: 120, clientY: 120 });
      const menuItems = within(screen.getByRole("menu")).getAllByRole("menuitem");
      expect(menuItems.at(-1)).toHaveTextContent(t("free_creation_delete"));
      expect(menuItems.filter((menuItem) => menuItem.textContent === t("free_creation_delete"))).toHaveLength(1);
      unmount();
    }
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
    selectCanvasNode(firstCard!, 20);
    selectCanvasNode(secondCard!, 21, true);
    fireEvent.contextMenu(secondCard!, { clientX: 120, clientY: 120 });

    const mergeAction = await screen.findByRole("menuitem", { name: t("free_creation_merge_selected") });
    fireEvent.click(mergeAction);
    expect(onMerge).toHaveBeenCalledWith([first.creation_id, second.creation_id]);
  });

  it("merges selected uploaded videos in canvas order", async () => {
    const first: FreeCreationUpload = {
      ...textUpload,
      reference_id: "r_11111111111111111111",
      original_filename: "opening.mp4",
      media_type: "video",
      path: "uploads/free_creation/r_11111111111111111111.mp4",
    };
    const second: FreeCreationUpload = {
      ...first,
      reference_id: "r_22222222222222222222",
      original_filename: "ending.mov",
      path: "uploads/free_creation/r_22222222222222222222.mov",
    };
    const onMerge = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[]}
        uploads={[first, second]}
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
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${first.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    const secondCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${second.reference_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });
    selectCanvasNode(firstCard, 22);
    selectCanvasNode(secondCard, 23, true);
    fireEvent.contextMenu(secondCard, { clientX: 120, clientY: 120 });

    fireEvent.click(await screen.findByRole("menuitem", { name: t("free_creation_merge_selected") }));
    expect(onMerge).toHaveBeenCalledWith([first.reference_id, second.reference_id]);
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

    selectCanvasNode(videoCard!, 60);
    selectCanvasNode(audioCard!, 61, true);
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

    selectCanvasNode(firstCard!, 70);
    selectCanvasNode(secondCard!, 71, true);
    fireEvent.contextMenu(secondCard!, { clientX: 120, clientY: 120 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t("free_creation_group_selected") }));
    expect(document.querySelector("[data-canvas-group]")).toBeInTheDocument();
    expect(screen.getByTestId("free-creation-canvas")).toBeInTheDocument();

    const firstDragSurface = firstCard!.querySelector<HTMLElement>("[data-canvas-drag-surface='true']");
    expect(firstDragSurface).toBeInTheDocument();
    const surface = screen.getByTestId("free-creation-canvas");
    fireEvent.pointerDown(firstDragSurface!, { button: 0, pointerId: 72, clientX: 100, clientY: 100 });
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

  it("treats subtitle tracks as draggable canvas nodes with explicit actions", async () => {
    const video: FreeCreation = {
      ...creation,
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0123.mp4",
    };
    const renderedVideo: FreeCreation = {
      ...video,
      creation_id: "c_0123456789abcdef0124",
      effective_mode: "subtitle_burn",
      subtitle_id: "sub_0123456789abcdef0123",
      parent_creation_id: video.creation_id,
      reference_claims: [{
        type: "creation",
        creation_id: video.creation_id,
        role: "reference_video",
      }],
    };
    const onEditSubtitle = vi.fn();
    const onRenderSubtitle = vi.fn();
    const onDeleteSubtitle = vi.fn();
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[video, renderedVideo]}
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
        onRenderSubtitle={onRenderSubtitle}
        onDeleteSubtitle={onDeleteSubtitle}
      />,
    );

    const subtitleCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>("[data-canvas-id='sub_0123456789abcdef0123']");
      expect(element).toBeInTheDocument();
      return element!;
    });
    expect(screen.getByText("The train arrives.")).toBeInTheDocument();
    const renderedCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${renderedVideo.creation_id}']`);
      expect(element).toBeInTheDocument();
      expect(Number.parseInt(element?.style.left ?? "0", 10)).toBeGreaterThan(
        Number.parseInt(subtitleCard.style.left, 10),
      );
      return element!;
    });
    expect(renderedCard).toHaveStyle({ top: subtitleCard.style.top });

    selectCanvasNode(subtitleCard, 70);
    expect(onEditSubtitle).not.toHaveBeenCalled();
    expect(subtitleCard).toHaveAttribute("data-selected", "true");

    fireEvent.doubleClick(subtitleCard);
    expect(onEditSubtitle).toHaveBeenCalledWith(video.creation_id);

    const surface = screen.getByTestId("free-creation-canvas");
    const originalLeft = subtitleCard.style.left;
    fireEvent.pointerDown(subtitleCard, { button: 0, pointerId: 71, clientX: 450, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 71, clientX: 510, clientY: 140 });
    fireEvent.pointerUp(surface, { pointerId: 71, clientX: 510, clientY: 140 });
    await waitFor(() => expect(subtitleCard.style.left).not.toBe(originalLeft));

    fireEvent.contextMenu(subtitleCard, { clientX: 480, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_subtitle_render") }));
    expect(onRenderSubtitle).toHaveBeenCalledWith("sub_0123456789abcdef0123");

    fireEvent.contextMenu(subtitleCard, { clientX: 480, clientY: 120 });
    const menuItems = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(menuItems.at(-1)).toHaveTextContent(t("free_creation_subtitle_delete"));
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_subtitle_delete") }));
    expect(onDeleteSubtitle).toHaveBeenCalledWith("sub_0123456789abcdef0123");
  });

  it("groups a subtitle with video and hides the subtitle independently", async () => {
    const video: FreeCreation = {
      ...creation,
      output_type: "video",
      media_type: "video",
      media_path: "creations/c_0123456789abcdef0123.mp4",
    };
    const subtitleId = "sub_0123456789abcdef0123";
    const { container } = render(
      <FreeCreationInfiniteCanvas
        projectName="demo"
        creations={[video]}
        uploads={[]}
        subtitleTracks={[{
          subtitle_id: subtitleId,
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
      />,
    );

    await waitFor(() => expect(container.querySelector(
      `[data-canvas-id='${video.creation_id}']`,
    )).toBeInTheDocument());
    await waitFor(() => expect(container.querySelector(
      `[data-canvas-id='${subtitleId}']`,
    )).toBeInTheDocument());
    const videoCard = container.querySelector<HTMLElement>(`[data-canvas-id='${video.creation_id}']`)!;
    const subtitleCard = container.querySelector<HTMLElement>(`[data-canvas-id='${subtitleId}']`)!;
    selectCanvasNode(videoCard, 72);
    selectCanvasNode(subtitleCard, 73, true);

    fireEvent.contextMenu(subtitleCard, { clientX: 480, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_group_selected") }));
    fireEvent.contextMenu(subtitleCard, { clientX: 480, clientY: 120 });
    expect(screen.getByRole("menuitem", { name: t("free_creation_ungroup") })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_ungroup") }));

    const surface = screen.getByTestId("free-creation-canvas");
    fireEvent.pointerDown(surface, { button: 0, pointerId: 74, clientX: 8, clientY: 8 });
    fireEvent.pointerUp(surface, { pointerId: 74, clientX: 8, clientY: 8 });
    fireEvent.contextMenu(subtitleCard, { clientX: 480, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_hide") }));

    await waitFor(() => expect(container.querySelector(`[data-canvas-id='${subtitleId}']`)).not.toBeInTheDocument());
    expect(container.querySelector(`[data-canvas-id='${video.creation_id}']`)).toBeInTheDocument();
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
    const dragSurface = card.querySelector<HTMLElement>("[data-canvas-drag-surface='true']");
    expect(dragSurface).toBeInTheDocument();
    const surface = screen.getByTestId("free-creation-canvas");
    const transformLayer = Array.from(surface.querySelectorAll<HTMLDivElement>("div"))
      .find((element) => element.style.transform.includes("translate3d"));

    fireEvent.keyDown(window, { code: "Space", key: " " });
    fireEvent.pointerDown(dragSurface!, { button: 0, pointerId: 52, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 52, clientX: 148, clientY: 132 });
    fireEvent.pointerUp(surface, { pointerId: 52, clientX: 148, clientY: 132 });
    fireEvent.keyUp(window, { code: "Space", key: " " });

    await waitFor(() => expect(transformLayer?.style.transform).toContain("translate3d(48px, 32px, 0)"));
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
    selectCanvasNode(card!, 53);
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
    selectCanvasNode(card!, 54);
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

    selectCanvasNode(firstCard, 30);
    selectCanvasNode(secondCard, 31, true);
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
    expect(screen.queryByRole("menuitem", { name: t("free_creation_add_reference") })).not.toBeInTheDocument();
  });

  it("shows read-only relationships for the selection and switches the view locally", async () => {
    localStorage.setItem(
      "matrixspooll:freeCreationCanvasView:demo",
      JSON.stringify({ relationMode: "selected" }),
    );
    const source: FreeCreation = {
      ...creation,
      creation_id: "c_source0123456789abcde",
      prompt: "source frame",
    };
    const derived: FreeCreation = {
      ...creation,
      creation_id: "c_derived123456789abcde",
      output_type: "video",
      media_type: "video",
      prompt: "derived shot",
      reference_claims: [{
        type: "creation",
        creation_id: source.creation_id,
        version: 1,
        role: "first_frame",
      }],
    };
    const { container } = renderCanvas([source, derived]);
    const relationButton = screen.getByRole("button", { name: t("free_creation_relations") });
    fireEvent.click(relationButton);
    const relationOptions = screen.getAllByRole("menuitemradio");
    expect(relationOptions.map((option) => option.textContent?.trim())).toEqual([
      t("free_creation_relations_all"),
      t("free_creation_relations_selected"),
      t("free_creation_relations_off"),
    ]);
    expect(screen.getByRole("menuitemradio", {
      name: t("free_creation_relations_all"),
    })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(relationButton);
    const derivedCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${derived.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });

    selectCanvasNode(derivedCard, 34);
    const summary = await screen.findByRole("button", {
      name: t("free_creation_relation_summary", { upstream: 1, downstream: 0 }),
    });
    fireEvent.click(summary);
    expect(screen.getByRole("heading", { name: t("free_creation_relation_details") })).toBeInTheDocument();
    expect(screen.getByText(t("free_creation_relation_role_first_frame"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_relations") }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: t("free_creation_relations_off") }));
    expect(JSON.parse(localStorage.getItem("matrixspooll:freeCreationCanvasView:demo") ?? "{}")).toEqual({
      relationMode: "off",
      version: 2,
    });
    expect(API.saveFreeCreationCanvas).not.toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({ show_relations: false }),
    );
  });

  it("offers continuation only for one completed visual result", async () => {
    const onContinue = vi.fn();
    const { container } = render(
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
        onContinue={onContinue}
      />,
    );
    const card = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(`[data-canvas-id='${creation.creation_id}']`);
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.contextMenu(card, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_continue_from_result") }));
    expect(onContinue).toHaveBeenCalledWith(creation.creation_id);
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

    selectCanvasNode(firstCard, 32);
    selectCanvasNode(secondCard, 33, true);
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
    selectCanvasNode(firstCard!, 41);
    selectCanvasNode(secondCard!, 42, true);
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
      expect(creationCard).toHaveAttribute("data-selected", "true");
      expect(uploadCard).toHaveAttribute("data-selected", "true");
    });

    fireEvent.keyDown(window, { key: "Escape" });
    const editor = screen.getByRole("textbox", { name: "editor" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    expect(creationCard).toHaveAttribute("data-selected", "false");
    expect(uploadCard).toHaveAttribute("data-selected", "false");
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

    fireEvent.wheel(surface, { deltaY: 10_000, altKey: true });
    await waitFor(() => expect(screen.getByText("40%")).toBeInTheDocument());

    const browserZoom = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
    });
    surface.dispatchEvent(browserZoom);
    expect(browserZoom.defaultPrevented).toBe(true);
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("clamps a legacy saved viewport to the 40% minimum zoom", async () => {
    vi.mocked(API.getFreeCreationCanvas).mockResolvedValue({
      canvas: {
        revision: 1,
        viewport: { x: 0, y: 0, scale: 0.05 },
        positions: {},
        hidden_creation_ids: [],
        updated_at: null,
      },
    });

    renderCanvas();

    expect(await screen.findByText("40%")).toBeInTheDocument();
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
    fireEvent.click(card!);
    expect(onReference).not.toHaveBeenCalled();
    fireEvent.click(card!, { ctrlKey: true });
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

  it("renders voiceover uploads with native playback and the shared reference shortcut", async () => {
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
    fireEvent.click(card!, { ctrlKey: true });
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
