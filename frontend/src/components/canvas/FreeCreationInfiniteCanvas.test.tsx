import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { FreeCreationInfiniteCanvas } from "@/components/canvas/FreeCreationInfiniteCanvas";
import i18n from "@/i18n";
import { useFreeCreationStore } from "@/stores/free-creation-store";
import type { FreeCreation } from "@/types";

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
});
