import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FreeCreationPreviewDialog } from "@/components/canvas/FreeCreationPreviewDialog";
import type { FreeCreationUpload } from "@/types";

const imageUpload: FreeCreationUpload = {
  reference_id: "r_preview0123456789abcd",
  type: "upload",
  original_filename: "portrait.png",
  media_type: "image",
  path: "uploads/free_creation/portrait.png",
  size_bytes: 2048,
  created_at: "2026-08-24T00:00:00Z",
};

describe("FreeCreationPreviewDialog", () => {
  it("contains ultrawide visual media inside a bounded preview viewport", () => {
    render(
      <FreeCreationPreviewDialog
        projectName="demo"
        target={{ kind: "upload", upload: imageUpload }}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const viewport = screen.getByTestId("free-creation-visual-preview");
    const image = screen.getByRole("img", { name: "portrait.png" });
    expect(dialog).toHaveClass("w-[min(92vw,1200px)]");
    expect(dialog).not.toHaveClass("w-full");
    expect(viewport).toHaveClass("overflow-hidden", "items-center", "justify-center");
    expect(viewport).not.toHaveClass("overflow-auto");
    expect(image).toHaveClass("max-h-full", "max-w-full", "object-contain");
  });
});
