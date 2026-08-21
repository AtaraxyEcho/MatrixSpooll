import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { FreeCreationCanvas } from "@/components/canvas/FreeCreationCanvas";
import i18n from "@/i18n";

const t = i18n.getFixedT("zh", "dashboard");

describe("FreeCreationCanvas", () => {
  beforeEach(() => {
    vi.spyOn(API, "listFreeCreations").mockResolvedValue({ creations: [] });
    vi.spyOn(API, "getModelCandidates").mockResolvedValue({
      image: { default: ["ark/image-model"], buckets: {} },
      video: { default: ["ark/video-model"], buckets: {} },
      provider_names: {},
    });
  });

  it("submits model, resolution, size, and quantity from the project canvas", async () => {
    const create = vi.spyOn(API, "createFreeCreation").mockResolvedValue({
      success: true,
      creation_id: "c_0123456789abcdef0123",
      task_id: "task-1",
    });
    render(<FreeCreationCanvas projectName="demo" />);

    const model = await screen.findByLabelText(t("free_creation_model"));
    fireEvent.change(model, { target: { value: "ark/image-model" } });
    fireEvent.change(screen.getByLabelText(t("free_creation_resolution")), {
      target: { value: "2k" },
    });
    fireEvent.change(screen.getByLabelText(t("free_creation_quantity")), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(t("free_creation_size")), {
      target: { value: "2048x2048" },
    });
    fireEvent.change(screen.getByPlaceholderText(t("free_creation_prompt")), {
      target: { value: "a paper boat on a quiet lake" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_submit") }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({
        output_type: "image",
        model: "ark/image-model",
        resolution: "2k",
        size: "2048x2048",
        quantity: 3,
      }),
    );
  });
});
