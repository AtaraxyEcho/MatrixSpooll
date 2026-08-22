import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API } from "@/api";
import { FreeCreationWorkspace } from "@/components/canvas/FreeCreationWorkspace";
import { GENERATION_MODEL_PREFERENCES_STORAGE_KEY } from "@/components/generation/generationModelPreference";
import i18n from "@/i18n";

vi.mock("@/components/copilot/AgentCopilot", () => ({
  AgentCopilot: ({ footerStart }: { footerStart?: React.ReactNode }) => (
    <div data-testid="embedded-agent">{footerStart}</div>
  ),
}));

const t = i18n.getFixedT("zh", "dashboard");

describe("FreeCreationWorkspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(API, "listFreeCreations").mockResolvedValue({ creations: [] });
    vi.spyOn(API, "listFreeCreationRequests").mockResolvedValue({ requests: [] });
    vi.spyOn(API, "listFreeSubtitleTracks").mockResolvedValue({ tracks: [] });
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
    vi.spyOn(API, "listFreeCreationReferences").mockResolvedValue({ references: [] });
    vi.spyOn(API, "getModelCandidates").mockResolvedValue({
      image: { default: ["ark/image-model"], buckets: {} },
      video: { default: ["ark/video-model"], buckets: {} },
      provider_names: {},
    });
    vi.spyOn(API, "getFreeCreationCapabilities").mockImplementation(async ({ outputType }) => ({
      output_type: outputType,
      model: outputType === "video" ? "ark/video-model" : "ark/image-model",
      ratios: ["16:9", "9:16"],
      resolutions: outputType === "video" ? ["720p", "1080p"] : ["1.5k", "2k"],
      durations: outputType === "video" ? [4, 8, 12] : [],
      max_reference_images: outputType === "video" ? 9 : null,
      max_reference_videos: outputType === "video" ? 3 : null,
      max_reference_media_count: outputType === "video" ? 9 : null,
      modes: outputType === "video"
        ? ["t2v", "first_frame", "first_last_frame", "reference_image", "reference_video"]
        : [],
      input_slots: outputType === "video"
        ? [
            { role: "first_frame", accepted_types: ["image"], max_count: 1 },
            { role: "last_frame", accepted_types: ["image"], max_count: 1 },
            { role: "reference_image", accepted_types: ["image"], max_count: 9 },
          ]
        : [],
    }));
  });

  it("submits image parameters from the bottom composer", async () => {
    const create = vi.spyOn(API, "createFreeCreation").mockResolvedValue({
      success: true,
      creation_id: "c_0123456789abcdef0123",
      task_id: "task-1",
    });
    render(<FreeCreationWorkspace projectName="demo" />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(await screen.findByRole("option", { name: t("free_creation_mode_image") }));
    const imageModel = await screen.findByRole("button", { name: t("free_creation_model") });
    fireEvent.click(imageModel);
    fireEvent.click(await screen.findByRole("option", { name: "image-model" }));
    const resolution = screen.getByLabelText(t("free_creation_resolution"));
    await waitFor(() => expect(resolution).toHaveTextContent("2k"));
    fireEvent.change(resolution, {
      target: { value: "2k" },
    });
    expect(screen.getByLabelText("W")).toHaveValue(2048);
    expect(screen.getByLabelText("H")).toHaveValue(1152);
    fireEvent.change(screen.getByLabelText(t("free_creation_quantity")), {
      target: { value: "3" },
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
        size: "2048x1152",
        quantity: 3,
      }),
    );
  });

  it("replaces the upper-left creation summary with the embedded agent", async () => {
    render(<FreeCreationWorkspace projectName="demo" />);

    expect(screen.getByTestId("free-creation-session-summary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(await screen.findByRole("option", { name: t("free_creation_mode_agent") }));

    expect(screen.queryByTestId("free-creation-session-summary")).not.toBeInTheDocument();
    expect(screen.getByTestId("embedded-agent")).toBeInTheDocument();
    const parameters = screen.getByRole("button", { name: t("free_creation_agent_parameters") });
    fireEvent.click(parameters);
    const panel = screen.getByRole("dialog", { name: t("free_creation_agent_parameters") });
    expect(panel).toHaveClass("home-param-popover--portal");
    expect(panel.parentElement).toBe(document.body);
  });

  it("restores the selected video model after the workspace remounts", async () => {
    vi.mocked(API.getModelCandidates).mockResolvedValue({
      image: { default: ["ark/image-model"], buckets: {} },
      video: { default: ["anyfast/seedance-2.5"], buckets: {} },
      provider_names: {},
    });
    const first = render(<FreeCreationWorkspace projectName="demo" />);

    const firstModel = await screen.findByRole("button", { name: t("home_model") });
    fireEvent.click(firstModel);
    fireEvent.click(await screen.findByRole("option", { name: "seedance-2.5" }));
    expect(JSON.parse(localStorage.getItem(GENERATION_MODEL_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual({
      image: "auto",
      video: "anyfast/seedance-2.5",
    });

    first.unmount();
    render(<FreeCreationWorkspace projectName="demo" />);
    await waitFor(() => expect(screen.getByRole("button", { name: t("home_model") })).toHaveTextContent("seedance-2.5"));
  });

  it("uses the project aspect ratio and restores project-scoped composer parameters", async () => {
    vi.mocked(API.getFreeCreationCapabilities).mockResolvedValue({
      output_type: "video",
      model: "ark/video-model",
      ratios: ["21:9", "9:16"],
      resolutions: ["480p", "1080p"],
      durations: [4, 8, 12],
      max_reference_images: 9,
      max_reference_videos: 3,
      max_reference_media_count: 9,
      modes: ["t2v"],
      input_slots: [],
    });
    const first = render(<FreeCreationWorkspace projectName="wide-project" initialAspectRatio="21:9" />);

    const videoSettings = await screen.findByRole("button", { name: t("home_video_settings") });
    await waitFor(() => expect(videoSettings).toHaveTextContent("21:9"));
    fireEvent.click(videoSettings);
    fireEvent.click(screen.getByRole("button", { name: /9:16/ }));
    fireEvent.click(screen.getByRole("button", { name: "480P" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: `${t("free_creation_duration")} control` }));
    fireEvent.change(screen.getByRole("slider", { name: `${t("free_creation_duration")} control` }), {
      target: { value: "12" },
    });
    first.unmount();

    render(<FreeCreationWorkspace projectName="wide-project" initialAspectRatio="21:9" />);
    const restoredVideoSettings = await screen.findByRole("button", { name: t("home_video_settings") });
    await waitFor(() => expect(restoredVideoSettings).toHaveTextContent("9:16"));
    expect(restoredVideoSettings).toHaveTextContent("480P");
    expect(restoredVideoSettings).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: `${t("free_creation_duration")} control` })).toHaveTextContent("12s");
  });

  it("uses the project video resolution before project-scoped composer parameters exist", async () => {
    render(<FreeCreationWorkspace projectName="resolution-project" initialResolution="720p" />);

    const videoSettings = await screen.findByRole("button", { name: t("home_video_settings") });
    await waitFor(() => expect(videoSettings).toHaveTextContent("720P"));
  });

  it("uses the declared duration bounds and snaps to a supported duration", async () => {
    const create = vi.spyOn(API, "createFreeCreation").mockResolvedValue({
      success: true,
      creation_id: "c_0123456789abcdef0124",
      task_id: "task-2",
    });
    render(<FreeCreationWorkspace projectName="demo" />);

    const duration = await screen.findByLabelText(t("free_creation_duration"));
    await waitFor(() => expect(duration).toHaveAttribute("max", "12"));
    expect(duration).toHaveAttribute("min", "0");
    expect(duration).toHaveAttribute("aria-valuemin", "4");
    fireEvent.change(duration, { target: { value: "9" } });
    expect(duration).toHaveValue("8");

    fireEvent.change(screen.getByPlaceholderText(t("free_creation_prompt")), {
      target: { value: "slow camera move through a quiet room" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_submit") }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({ output_type: "video", duration_seconds: 8 }),
    );
  });

  it("automatically uses a canvas image as an omni reference", async () => {
    vi.mocked(API.listFreeCreationReferences).mockResolvedValue({
      references: [{
        reference_id: "ref-1",
        type: "upload",
        original_filename: "hero.png",
        media_type: "image",
        path: "references/ref-1.png",
        size_bytes: 1024,
        created_at: "2026-08-19T00:00:00Z",
      }],
    });
    render(<FreeCreationWorkspace projectName="demo" />);

    const addButtons = await screen.findAllByRole("button", { name: t("free_creation_add_reference") });
    fireEvent.click(addButtons[0]!);

    const create = vi.spyOn(API, "createFreeCreation").mockResolvedValue({
      success: true,
      creation_id: "c_0123456789abcdef0127",
      task_id: "task-reference-role",
    });
    expect(screen.getAllByText("hero.png").length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox", {
      name: t("free_creation_reference_role_label", { name: "hero.png" }),
    })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(t("free_creation_prompt")), {
      target: { value: "use the hero image as a visual reference" },
    });
    const submit = screen.getByRole("button", { name: t("free_creation_submit") });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({
        references: [{ type: "upload", reference_id: "ref-1", role: "reference_image" }],
      }),
    );
  });

  it("assigns the first canvas image to the first-frame slot in frame mode", async () => {
    vi.mocked(API.listFreeCreationReferences).mockResolvedValue({
      references: [{
        reference_id: "ref-frames",
        type: "upload",
        original_filename: "opening.png",
        media_type: "image",
        path: "references/ref-frames.png",
        size_bytes: 1024,
        created_at: "2026-08-19T00:00:00Z",
      }],
    });
    const create = vi.spyOn(API, "createFreeCreation").mockResolvedValue({
      success: true,
      creation_id: "c_0123456789abcdef0128",
      task_id: "task-frames",
    });
    render(<FreeCreationWorkspace projectName="demo" />);

    const referenceMode = await screen.findByRole("button", { name: t("free_creation_reference_mode") });
    await waitFor(() => expect(referenceMode).toBeEnabled());
    fireEvent.click(referenceMode);
    fireEvent.click(await screen.findByRole("option", { name: t("free_creation_reference_mode_frames") }));
    const addButtons = await screen.findAllByRole("button", { name: t("free_creation_add_reference") });
    fireEvent.click(addButtons[0]!);
    fireEvent.change(screen.getByPlaceholderText(t("free_creation_prompt")), {
      target: { value: "start from the supplied opening frame" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_submit") }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({
        references: [{ type: "upload", reference_id: "ref-frames", role: "first_frame" }],
      }),
    );
  });

  it("does not expose unsupported video editing as a parent action", async () => {
    vi.mocked(API.listFreeCreations).mockResolvedValue({
      creations: [{
        creation_id: "c_0123456789abcdef0125",
        output_type: "video",
        media_type: "video",
        status: "succeeded",
        prompt: "source clip",
        media_path: "creations/c_0123456789abcdef0125.mp4",
      }],
    });
    const { container } = render(<FreeCreationWorkspace projectName="demo" />);

    await waitFor(() => expect(
      container.querySelector("[data-canvas-id='c_0123456789abcdef0125']"),
    ).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: t("free_creation_use_as_parent") })).not.toBeInTheDocument();
  });
});
