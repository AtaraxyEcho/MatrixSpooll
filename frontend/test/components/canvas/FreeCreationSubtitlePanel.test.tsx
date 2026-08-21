import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { FreeCreationSubtitlePanel } from "@/components/canvas/FreeCreationSubtitlePanel";
import i18n from "@/i18n";
import type { FreeCreation, FreeSubtitleTrack } from "@/types";

const t = i18n.getFixedT("zh", "dashboard");
const video: FreeCreation = {
  creation_id: "c_0123456789abcdef0123",
  output_type: "video",
  media_type: "video",
  status: "succeeded",
  prompt: "rainy station",
  media_path: "creations/c_0123456789abcdef0123.mp4",
  duration_seconds: 8,
};

describe("FreeCreationSubtitlePanel", () => {
  it("saves multiline cues and renders a derived subtitled video", async () => {
    const createdTrack: FreeSubtitleTrack = {
      subtitle_id: "sub_0123456789abcdef0123",
      creation_id: video.creation_id,
      revision: 1,
      cues: [{ start_seconds: 0, end_seconds: 8, text: "First line\nSecond line" }],
      created_at: "2026-08-19T00:00:00Z",
      updated_at: "2026-08-19T00:00:00Z",
    };
    const create = vi.spyOn(API, "createFreeSubtitleTrack").mockResolvedValue({
      success: true,
      track: createdTrack,
    });
    const update = vi.spyOn(API, "updateFreeSubtitleTrack").mockResolvedValue({
      success: true,
      track: { ...createdTrack, revision: 2 },
    });
    const renderTrack = vi.spyOn(API, "renderFreeSubtitleTrack").mockResolvedValue({
      success: true,
      creation: { ...video, creation_id: "c_0123456789abcdef0124" },
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <FreeCreationSubtitlePanel
        projectName="demo"
        open
        creations={[video]}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(screen.getByLabelText(t("free_creation_subtitle_text")), {
      target: { value: "First line\nSecond line" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_subtitle_render") }));

    await waitFor(() => expect(renderTrack).toHaveBeenCalledWith("demo", createdTrack.subtitle_id));
    expect(create).toHaveBeenCalledWith("demo", {
      creation_id: video.creation_id,
      text: "First line\nSecond line",
      duration_seconds: 8,
    });
    expect(update).toHaveBeenCalledWith("demo", createdTrack.subtitle_id, {
      cues: [
        { start_seconds: 0, end_seconds: 4, text: "First line" },
        { start_seconds: 4, end_seconds: 8, text: "Second line" },
      ],
      expected_revision: 1,
    });
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
