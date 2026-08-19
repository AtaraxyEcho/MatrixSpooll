import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import i18n from "@/i18n";
import { HomeHeroComposer } from "@/components/pages/HomeHeroComposer";

const t = i18n.getFixedT("zh", "dashboard");

describe("HomeHeroComposer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(API, "getModelCandidates").mockRejectedValue(new Error("offline"));
    vi.spyOn(API, "getSystemConfig").mockRejectedValue(new Error("offline"));
    vi.spyOn(API, "getFreeCreationCapabilities").mockImplementation(async ({ outputType }) => ({
      output_type: outputType,
      model: outputType === "video" ? "ark/video-model" : "ark/image-model",
      ratios: outputType === "video" ? ["16:9", "9:16", "1:1"] : [],
      resolutions: outputType === "video" ? ["720p", "1080p"] : ["1.5k", "2k", "4k"],
      durations: outputType === "video" ? [4, 5, 6, 8, 10, 12, 15] : [],
      max_reference_images: outputType === "video" ? 9 : null,
      max_reference_videos: outputType === "video" ? 0 : null,
      max_reference_media_count: outputType === "video" ? 9 : null,
    }));
  });

  it("updates the image dimensions from the grouped ratio and resolution controls", () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: t("home_image") }));
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));
    fireEvent.click(screen.getByRole("button", { name: t("aspect_ratio_1_1") }));
    fireEvent.click(screen.getByRole("button", { name: "2K" }));

    const widthInput = screen.getByRole("spinbutton", { name: t("home_width") });
    const heightInput = screen.getByRole("spinbutton", { name: t("home_height") });
    expect(widthInput).toHaveValue(2048);
    expect(heightInput).toHaveValue(2048);

    fireEvent.change(widthInput, { target: { value: "1600" } });
    fireEvent.change(heightInput, { target: { value: "1200" } });
    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));
    expect(screen.getByRole("spinbutton", { name: t("home_width") })).toHaveValue(1600);
    expect(screen.getByRole("spinbutton", { name: t("home_height") })).toHaveValue(1200);
    expect(screen.queryByRole("button", { name: t("home_duration") })).not.toBeInTheDocument();
  });

  it("groups video ratio, resolution, and quantity in one compact control", async () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: t("home_generate") })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: t("home_video_settings") }));

    expect(screen.getByRole("button", { name: t("aspect_ratio_1_1") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1080P" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: t("home_image_settings") })).not.toBeInTheDocument();
  });

  it("shows the disabled pre-minimum interval and clamps to model-supported durations", async () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    await waitFor(() => expect(API.getFreeCreationCapabilities).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: t("home_duration") }));
    const slider = screen.getByRole("slider", { name: t("home_duration") });

    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("aria-valuemin", "4");
    expect(slider).toHaveValue("4");
    fireEvent.change(slider, { target: { value: "2" } });
    expect(slider).toHaveValue("4");
    fireEvent.change(slider, { target: { value: "15" } });
    expect(slider).toHaveValue("15");
  });

  it("uses declared video capabilities and creates the project with its first task atomically", async () => {
    vi.mocked(API.getFreeCreationCapabilities).mockResolvedValueOnce({
      output_type: "video",
      model: "ark/video-model",
      ratios: ["21:9"],
      resolutions: ["720p"],
      durations: [6, 10],
      max_reference_images: 0,
      max_reference_videos: 0,
      max_reference_media_count: null,
    });
    const create = vi.spyOn(API, "createFreeProject").mockResolvedValue({
      success: true,
      name: "wide-city-at-night",
      creation_id: "c_0123456789abcdef0123",
      task_id: "task-1",
    });
    const onCreated = vi.fn();
    render(<HomeHeroComposer onCreated={onCreated} />);

    const videoSettings = screen.getByRole("button", { name: t("home_video_settings") });
    await waitFor(() => expect(videoSettings).toHaveTextContent("21:9"));
    fireEvent.click(videoSettings);
    expect(screen.getByRole("button", { name: /21:9/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "720P" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("aspect_ratio_1_1") })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("home_duration") }));
    const slider = screen.getByRole("slider", { name: t("home_duration") });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("aria-valuemin", "6");
    expect(slider).toHaveAttribute("max", "10");

    fireEvent.change(screen.getByLabelText(t("home_prompt_label")), {
      target: { value: "Wide city at night with slow camera movement" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("home_generate") }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      title: "Wide city at night with slow cam",
      creation: expect.objectContaining({
        output_type: "video",
        aspect_ratio: "21:9",
        resolution: "720p",
        duration_seconds: 6,
      }),
    });
    expect(onCreated).toHaveBeenCalledWith("wide-city-at-night", "video");
  });
});
