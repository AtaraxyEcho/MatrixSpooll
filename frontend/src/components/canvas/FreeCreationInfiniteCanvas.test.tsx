import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { FreeCreationInfiniteCanvas } from "@/components/canvas/FreeCreationInfiniteCanvas";
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
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_hide_from_canvas") }));
    expect(container.querySelector(selector)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) }));
    const restoredCard = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(selector);
      expect(element).toBeInTheDocument();
      return element!;
    });
    fireEvent.contextMenu(restoredCard, { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_restore_to_canvas") }));

    expect(container.querySelector(selector)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) })).not.toBeInTheDocument();
  });

  it("does not expose media actions for unfinished cards", async () => {
    renderCanvas([{ ...creation, status: "failed", media_path: undefined }]);
    const card = await waitFor(() => screen.getByText("paper boat").closest("article"));
    fireEvent.contextMenu(card!, { clientX: 120, clientY: 120 });

    expect(screen.queryByRole("menuitem", { name: t("free_creation_use_as_parent") })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: t("free_creation_add_reference") })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: t("free_creation_hide_from_canvas") })).toBeInTheDocument();
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
      name: t("free_creation_hide_selected", { count: 2 }),
    }));

    expect(container.querySelector(`[data-canvas-id='${creation.creation_id}']`)).not.toBeInTheDocument();
    expect(container.querySelector(`[data-canvas-id='${second.creation_id}']`)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("free_creation_show_hidden", { count: 2 }) })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_hide_from_canvas") }));

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
    fireEvent.click(screen.getByRole("menuitem", { name: t("free_creation_hide_from_canvas") }));
    expect(container.querySelector(selector)).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => expect(container.querySelector(selector)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: t("free_creation_show_hidden", { count: 1 }) })).not.toBeInTheDocument();
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

    const card = await waitFor(() => screen.getByText(textUpload.original_filename).closest("article"));
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

    const card = await waitFor(() => screen.getByText(audioUpload.original_filename).closest("article"));
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
