import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Settings2 } from "lucide-react";
import { API } from "@/api";
import i18n from "@/i18n";
import { HomeSelect, videoDurationsForModel } from "@/components/generation/GenerationComposer";
import { HomeHeroComposer } from "@/components/pages/HomeHeroComposer";
import { useAssistantStore } from "@/stores/assistant-store";

const t = i18n.getFixedT("zh", "dashboard");

describe("HomeHeroComposer", () => {
  beforeEach(() => {
    useAssistantStore.setState(useAssistantStore.getInitialState(), true);
    vi.restoreAllMocks();
    vi.spyOn(API, "getModelCandidates").mockRejectedValue(new Error("offline"));
    vi.spyOn(API, "getSystemConfig").mockRejectedValue(new Error("offline"));
    vi.spyOn(API, "getFreeCreationCapabilities").mockImplementation(async ({ outputType }) => ({
      output_type: outputType,
      model: outputType === "video" ? "ark/video-model" : "ark/image-model",
      ratios: ["16:9", "9:16", "1:1"],
      resolutions: outputType === "video" ? ["720p", "1080p"] : ["512px", "1.5k", "2k", "4k"],
      durations: outputType === "video" ? [4, 5, 6, 8, 10, 12, 15] : [],
      max_reference_images: outputType === "video" ? 9 : null,
      max_reference_videos: outputType === "video" ? 0 : null,
      max_reference_media_count: outputType === "video" ? 9 : null,
      modes: outputType === "video" ? ["t2v", "first_frame", "first_last_frame", "reference_image"] : ["t2i", "i2i"],
      input_slots: outputType === "video"
        ? [
            { role: "first_frame", accepted_types: ["image"], max_count: 1 },
            { role: "last_frame", accepted_types: ["image"], max_count: 1 },
            { role: "reference_image", accepted_types: ["image"], max_count: 9 },
            { role: "prompt_context", accepted_types: ["text"], max_count: 1 },
          ]
        : [
            { role: "reference_image", accepted_types: ["image"], max_count: 32 },
            { role: "prompt_context", accepted_types: ["text"], max_count: 1 },
          ],
    }));
  });

  it("exposes the full 4-30 second range when Seedance 2.5 capabilities are stale", () => {
    expect(videoDurationsForModel("anyfast/seedance-2.5", [4, 8, 12, 15])).toEqual(
      Array.from({ length: 27 }, (_, index) => index + 4),
    );
  });

  it("updates the image dimensions from the grouped ratio and resolution controls", async () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(screen.getByRole("option", { name: t("free_creation_mode_image") }));
    await waitFor(() => expect(API.getFreeCreationCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ outputType: "image" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));
    await screen.findByRole("button", { name: t("aspect_ratio_1_1") });
    fireEvent.click(screen.getByRole("button", { name: t("aspect_ratio_1_1") }));
    fireEvent.click(screen.getByRole("button", { name: "2K" }));

    expect(screen.queryByRole("button", { name: "512PX" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: t("home_width") })).toHaveValue(1440);
    expect(screen.getByRole("spinbutton", { name: t("home_height") })).toHaveValue(1440);
    expect(screen.getByRole("button", { name: t("home_image_settings") })).toHaveTextContent("1440");
    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));
    expect(screen.getByRole("button", { name: "2K" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("spinbutton", { name: t("home_width") })).toHaveValue(1440);
    expect(screen.getByRole("spinbutton", { name: t("home_height") })).toHaveValue(1440);
    expect(screen.queryByRole("button", { name: t("home_duration") })).not.toBeInTheDocument();
  });

  it("submits a manual image size after linking the other edge to the active ratio", async () => {
    const create = vi.spyOn(API, "createFreeProject").mockResolvedValue({
      success: true,
      name: "manual-size-project",
      creation_id: "c_0123456789abcdef0123",
      task_id: "task-manual-size",
    });
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(screen.getByRole("option", { name: t("free_creation_mode_image") }));
    fireEvent.click(await screen.findByRole("button", { name: t("home_image_settings") }));
    fireEvent.click(await screen.findByRole("button", { name: "2K" }));
    const width = screen.getByRole("spinbutton", { name: t("home_width") });
    fireEvent.change(width, { target: { value: "1600" } });
    fireEvent.blur(width);

    expect(screen.getByRole("spinbutton", { name: t("home_width") })).toHaveValue(1536);
    expect(screen.getByRole("spinbutton", { name: t("home_height") })).toHaveValue(864);
    fireEvent.change(screen.getByLabelText(t("home_prompt_label")), {
      target: { value: "A clean product photograph" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("home_generate") }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      creation: expect.objectContaining({ resolution: "2k", size: "1536x864" }),
    }));
  });

  it("groups video ratio, resolution, and quantity in one compact control", async () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: t("home_generate") })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: t("home_video_settings") }));

    const panel = screen.getByRole("dialog", { name: t("home_video_settings") });
    expect(panel).toHaveClass("home-param-popover--portal");
    expect(panel.parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: t("aspect_ratio_1_1") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1080P" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: t("home_image_settings") })).not.toBeInTheDocument();
  });

  it("keeps grouped parameters open for internal clicks and closes only outside or from the trigger", async () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: t("home_video_settings") });
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: t("home_video_settings") });

    fireEvent.pointerDown(within(panel).getByText(t("home_ratio")));
    fireEvent.blur(trigger, { relatedTarget: null });
    expect(screen.getByRole("dialog", { name: t("home_video_settings") })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: t("home_video_settings") })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: t("home_video_settings") })).not.toBeInTheDocument();
  });

  it("orders the four primary video controls consistently", async () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    const strip = document.querySelector(".home-composer-param-strip");
    expect(strip).not.toBeNull();
    await waitFor(() => expect(strip!.querySelectorAll("button").length).toBeGreaterThanOrEqual(4));
    expect(Array.from(strip!.querySelectorAll("button")).slice(0, 4).map((button) => button.getAttribute("aria-label"))).toEqual([
      t("free_creation_mode"),
      t("free_creation_reference_mode"),
      t("home_model"),
      t("free_creation_reference_assets"),
    ]);
  });

  it("uses keyboard letters to focus a matching model and shows the hint", () => {
    render(
      <HomeSelect
        label={t("home_model")}
        value="auto"
        icon={Settings2}
        hint={t("home_model_keyboard_hint")}
        options={[
          { value: "auto", label: t("home_model_auto") },
          { value: "veo-3", label: "veo-3" },
          { value: "sora-2", label: "sora-2" },
        ]}
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: t("home_model") });
    expect(screen.getByText(t("home_model_keyboard_hint"))).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "v" });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "veo-3" })).toHaveFocus();
  });

  it("uses a custom tooltip for the selected model instead of the native title popup", () => {
    render(
      <HomeSelect
        label={t("home_model")}
        value="veo-3"
        icon={Settings2}
        searchable
        options={[{ value: "veo-3", label: "veo-3-fast-preview" }]}
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: t("home_model") });
    expect(trigger).not.toHaveAttribute("title");
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent("veo-3-fast-preview");
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("filters a long model list through the search input", () => {
    render(
      <HomeSelect
        label={t("home_model")}
        value="auto"
        icon={Settings2}
        searchable
        searchPlaceholder={t("home_model_search")}
        emptyLabel={t("home_model_no_results")}
        className="home-model-control"
        options={[
          { value: "auto", label: t("home_model_auto") },
          { value: "veo-3", label: "veo-3-fast-preview" },
          { value: "seedance", label: "seedance-1-5-pro-ultra-long-model-name" },
          { value: "sora-2", label: "sora-2" },
        ]}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: t("home_model") }));
    const search = screen.getByRole("searchbox", { name: t("home_model_search") });
    expect(screen.getByRole("listbox", { name: t("home_model") })).toHaveClass("home-param-options");
    const longModelOption = screen.getByRole("option", { name: "veo-3-fast-preview" });
    expect(longModelOption).toHaveClass("home-param-option--model");
    expect(longModelOption).toHaveAttribute("data-model-name", "veo-3-fast-preview");

    fireEvent.change(search, { target: { value: "seedance" } });
    expect(screen.getByRole("option", { name: "seedance-1-5-pro-ultra-long-model-name" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "sora-2" })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing-model" } });
    expect(screen.getByText(t("home_model_no_results"))).toBeInTheDocument();
  });

  it("creates an agent project and carries the prompt into the embedded agent composer", async () => {
    const createProject = vi.spyOn(API, "createProject").mockResolvedValue({
      success: true,
      name: "agent-project",
      project: {} as never,
    });
    const createFreeProject = vi.spyOn(API, "createFreeProject");
    const onCreated = vi.fn();
    render(<HomeHeroComposer onCreated={onCreated} />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(screen.getByRole("option", { name: t("free_creation_mode_agent") }));
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_agent_parameters") }));
    fireEvent.click(screen.getByRole("switch", { name: t("free_creation_agent_auto_mode") }));
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_agent_preference_image") }));
    fireEvent.click(screen.getByRole("button", { name: t("aspect_ratio_1_1") }));
    fireEvent.change(screen.getByLabelText(t("home_prompt_label")), {
      target: { value: "Plan a short launch video" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("home_generate") }));

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith({
      title: "Plan a short launch video",
      content_mode: "free",
      generation_mode: null,
      aspect_ratio: "1:1",
    });
    expect(createFreeProject).not.toHaveBeenCalled();
    expect(useAssistantStore.getState().pendingHandoff).toEqual(expect.objectContaining({
      projectName: "agent-project",
      content: "Plan a short launch video",
      generationPolicy: expect.objectContaining({
        schema_version: 1,
        mode: "custom",
        output_type: "image",
        aspect_ratio: "1:1",
      }),
    }));
    expect(onCreated).toHaveBeenCalledWith("agent-project", "agent");
  });

  it("defaults Agent model and resolution to automatic and allows manual capability-aware overrides", async () => {
    vi.mocked(API.getModelCandidates).mockResolvedValue({
      image: { default: ["ark/seedream-image"], buckets: {} },
      video: { default: ["ark/seedance-video"], buckets: {} },
      provider_names: {},
    });
    vi.mocked(API.getSystemConfig).mockResolvedValue({ settings: {} } as never);
    vi.mocked(API.getFreeCreationCapabilities).mockImplementation(async ({ outputType, model }) => ({
      output_type: outputType,
      model: model ?? (outputType === "image" ? "ark/seedream-image" : "ark/seedance-video"),
      ratios: ["16:9"],
      resolutions: outputType === "image" ? ["1K", "2K"] : ["720p", "1080p"],
      durations: outputType === "video" ? [4] : [],
      max_reference_images: 0,
      max_reference_videos: 0,
      max_reference_media_count: 0,
    }));
    vi.spyOn(API, "createProject").mockResolvedValue({
      success: true,
      name: "agent-manual-project",
      project: {} as never,
    });
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(screen.getByRole("option", { name: t("free_creation_mode_agent") }));
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_agent_parameters") }));

    expect(screen.getByRole("switch", { name: t("free_creation_agent_auto_mode") })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: t("free_creation_agent_auto_mode") }));
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_agent_model") }));

    fireEvent.change(screen.getByRole("searchbox", { name: t("free_creation_agent_model_search") }), {
      target: { value: "seedance" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /seedance-video/i }));
    fireEvent.click(await screen.findByRole("button", { name: "1080P" }));
    fireEvent.change(screen.getByLabelText(t("home_prompt_label")), {
      target: { value: "Create a product reveal" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("home_generate") }));

    await waitFor(() => expect(useAssistantStore.getState().pendingHandoff).not.toBeNull());
    expect(useAssistantStore.getState().pendingHandoff?.generationPolicy).toEqual(expect.objectContaining({
      mode: "custom",
      output_type: "video",
      model: "ark/seedance-video",
      resolution: "1080p",
    }));
  });

  it("builds an automatic Agent handoff from mixed mock references without leaking manual defaults", async () => {
    vi.mocked(API.getModelCandidates).mockResolvedValue({
      image: { default: ["mock/image-model"], buckets: {} },
      video: { default: ["mock/video-model"], buckets: {} },
      provider_names: { mock: "Mock Provider" },
    });
    vi.mocked(API.getSystemConfig).mockResolvedValue({ settings: {} } as never);
    vi.mocked(API.getFreeCreationCapabilities).mockImplementation(async ({ outputType }) => ({
      output_type: outputType,
      model: outputType === "video" ? "mock/video-model" : "mock/image-model",
      ratios: ["16:9", "9:16"],
      resolutions: outputType === "video" ? ["720p", "1080p"] : ["1K", "2K"],
      durations: outputType === "video" ? [5, 10] : [],
      max_reference_images: 4,
      max_reference_videos: 2,
      max_reference_media_count: 8,
      modes: ["t2v", "reference_image", "reference_video"],
      input_slots: [
        { role: "reference_image", accepted_types: ["image"], max_count: 4 },
        { role: "reference_video", accepted_types: ["video"], max_count: 2 },
        { role: "reference_audio", accepted_types: ["audio"], max_count: 1 },
        { role: "prompt_context", accepted_types: ["text"], max_count: 1 },
      ],
    }));
    vi.spyOn(API, "createProject").mockResolvedValue({
      success: true,
      name: "mock-agent-project",
      project_id: "11111111-1111-4111-8111-111111111111",
      project: {} as never,
    });
    const referenceIds: Record<string, string> = {
      "character.png": "r_11111111111111111111",
      "motion.mp4": "r_22222222222222222222",
      "voice.mp3": "r_33333333333333333333",
      "story.md": "r_44444444444444444444",
    };
    const upload = vi.spyOn(API, "uploadFreeCreationReference").mockImplementation(async (_project, file) => ({
      success: true,
      reference: {
        reference_id: referenceIds[file.name]!,
        type: "upload",
        original_filename: file.name,
        media_type: file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
            ? "video"
            : file.type.startsWith("audio/") ? "audio" : "text",
        path: `references/${file.name}`,
        size_bytes: file.size,
        created_at: "2026-08-27T00:00:00Z",
      },
      url: `/mock/${file.name}`,
    }));
    const onCreated = vi.fn();
    render(<HomeHeroComposer onCreated={onCreated} />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(screen.getByRole("option", { name: t("free_creation_mode_agent") }));
    await waitFor(() => expect(
      screen.getByRole("button", { name: t("free_creation_upload_reference") }),
    ).toBeEnabled());
    const references = [
      new File(["image"], "character.png", { type: "image/png", lastModified: 1 }),
      new File(["video"], "motion.mp4", { type: "video/mp4", lastModified: 2 }),
      new File(["audio"], "voice.mp3", { type: "audio/mpeg", lastModified: 3 }),
      new File(["# Story"], "story.md", { type: "text/markdown", lastModified: 4 }),
    ];
    fireEvent.change(screen.getByLabelText(t("free_creation_upload_reference"), { selector: "input" }), {
      target: { files: references },
    });
    for (const reference of references) {
      expect(screen.getByTitle(reference.name)).toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText(t("home_prompt_label")), {
      target: { value: "Use the supplied mock material to plan a launch clip" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("home_generate") }));

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
    expect(useAssistantStore.getState().pendingHandoff).toEqual({
      projectName: "11111111-1111-4111-8111-111111111111",
      content: "Use the supplied mock material to plan a launch clip",
      generationPolicy: {
        schema_version: 1,
        mode: "auto",
        references: [
          { type: "upload", reference_id: "r_11111111111111111111", role: "reference_image" },
          { type: "upload", reference_id: "r_22222222222222222222", role: "reference_video" },
          { type: "upload", reference_id: "r_33333333333333333333", role: "reference_audio" },
          { type: "upload", reference_id: "r_44444444444444444444", role: "prompt_context" },
        ],
      },
    });
    expect(onCreated).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "agent");
  });

  it("recomputes image dimensions when a model narrows its resolution capabilities", async () => {
    vi.mocked(API.getModelCandidates).mockResolvedValue({
      image: { default: ["ark/image-wide", "ark/image-small"], buckets: {} },
      video: { default: [], buckets: {} },
      provider_names: {},
    });
    vi.mocked(API.getSystemConfig).mockResolvedValue({ settings: {} } as never);
    vi.mocked(API.getFreeCreationCapabilities).mockImplementation(async ({ outputType, model }) => ({
      output_type: outputType,
      model: model ?? "ark/image-wide",
      ratios: ["16:9"],
      resolutions: model === "ark/image-small" ? ["1K"] : ["1K", "2K"],
      durations: outputType === "video" ? [4] : [],
      max_reference_images: null,
      max_reference_videos: null,
      max_reference_media_count: null,
    }));
    const create = vi.spyOn(API, "createFreeProject").mockResolvedValue({
      success: true,
      name: "small-image-project",
      creation_id: "c_0123456789abcdef0123",
      task_id: "task-1",
    });
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(screen.getByRole("option", { name: t("free_creation_mode_image") }));
    fireEvent.click(await screen.findByRole("button", { name: t("home_model") }));
    fireEvent.click(await screen.findByRole("option", { name: "image-wide" }));
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));
    fireEvent.click(await screen.findByRole("button", { name: "2K" }));
    fireEvent.click(screen.getByRole("button", { name: t("home_image_settings") }));

    fireEvent.click(screen.getByRole("button", { name: t("home_model") }));
    fireEvent.click(await screen.findByRole("option", { name: "image-small" }));
    await waitFor(() => expect(screen.getByRole("button", { name: t("home_image_settings") })).toHaveTextContent("1K"));
    expect(screen.getByRole("button", { name: t("home_image_settings") })).toHaveTextContent("1792 × 1008");

    fireEvent.change(screen.getByLabelText(t("home_prompt_label")), { target: { value: "Small capability image" } });
    fireEvent.click(screen.getByRole("button", { name: t("home_generate") }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      creation: expect.objectContaining({ resolution: "1K" }),
    }));
    expect(create.mock.calls[0]?.[0].creation).not.toHaveProperty("size");
  });

  it("uploads homepage references before creating the first free task", async () => {
    const createProject = vi.spyOn(API, "createProject").mockResolvedValue({
      success: true,
      name: "reference-project",
      project: {} as never,
    });
    const upload = vi.spyOn(API, "uploadFreeCreationReference").mockResolvedValue({
      success: true,
      reference: {
        reference_id: "ref-home",
        type: "upload",
        original_filename: "opening.png",
        media_type: "image",
        path: "references/ref-home.png",
        size_bytes: 128,
        created_at: "2026-08-19T00:00:00Z",
      },
      url: "/files/ref-home.png",
    });
    const createCreation = vi.spyOn(API, "createFreeCreation").mockResolvedValue({
      success: true,
      creation_id: "c_0123456789abcdef0123",
      task_id: "task-reference",
    });
    const createFreeProject = vi.spyOn(API, "createFreeProject");
    const onCreated = vi.fn();
    render(<HomeHeroComposer onCreated={onCreated} />);

    await waitFor(() => expect(
      screen.getByRole("button", { name: t("free_creation_upload_reference") }),
    ).toBeEnabled());
    const file = new File(["image"], "opening.png", { type: "image/png", lastModified: 1 });
    fireEvent.change(screen.getByLabelText(t("free_creation_upload_reference"), { selector: "input" }), {
      target: { files: [file] },
    });
    const referenceChip = screen.getByTitle("opening.png");
    const promptInput = screen.getByLabelText(t("home_prompt_label"));
    expect(referenceChip.compareDocumentPosition(promptInput) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    fireEvent.change(screen.getByLabelText(t("home_prompt_label")), {
      target: { value: "Animate the opening frame" },
    });
    expect(screen.queryByRole("combobox", {
      name: t("free_creation_reference_role_label", { name: "opening.png" }),
    })).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: t("home_generate") });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(createCreation).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ content_mode: "free" }));
    expect(upload).toHaveBeenCalledWith("reference-project", file);
    expect(createCreation).toHaveBeenCalledWith(
      "reference-project",
      expect.objectContaining({
        references: [{ type: "upload", reference_id: "ref-home", role: "reference_image" }],
      }),
    );
    expect(createFreeProject).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith("reference-project", "video");
  });

  it("previews an uploaded first-frame image in the frame slot", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:first-frame"),
    });
    render(<HomeHeroComposer onCreated={vi.fn()} />);
    await waitFor(() => expect(
      screen.getByRole("button", { name: t("free_creation_upload_reference") }),
    ).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: t("free_creation_reference_mode") }));
    fireEvent.click(await screen.findByRole("option", {
      name: t("free_creation_reference_mode_frames"),
    }));
    const firstFrameButton = screen.getByRole("button", {
      name: t("free_creation_add_frame", { frame: t("free_creation_first_frame") }),
    });
    await waitFor(() => expect(firstFrameButton).toBeEnabled());
    fireEvent.click(firstFrameButton);

    const file = new File(["frame"], "opening.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(t("free_creation_upload_reference"), { selector: "input" }), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText("opening.png")).toBeInTheDocument());
    expect(document.querySelector(".free-reference-input img")).toHaveAttribute("src", expect.stringMatching(/^blob:/));
  });

  it("accepts dropped files as automatic omni references", async () => {
    render(<HomeHeroComposer onCreated={vi.fn()} />);
    await waitFor(() => expect(
      screen.getByRole("button", { name: t("free_creation_upload_reference") }),
    ).toBeEnabled());
    const file = new File(["image"], "dropped.png", { type: "image/png", lastModified: 2 });
    const dropZone = screen.getByLabelText(t("home_prompt_label")).closest(".free-reference-input");
    expect(dropZone).not.toBeNull();
    fireEvent.dragEnter(dropZone!, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.getByText(t("free_creation_drop_reference"))).toBeInTheDocument();
    fireEvent.drop(dropZone!, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.getByText("dropped.png")).toBeInTheDocument();
  });

  it("imports an image from the shared asset library into the reference bubbles", async () => {
    const asset = {
      id: "asset-1",
      type: "character" as const,
      name: "Hero",
      description: "Main character",
      voice_style: "",
      image_path: "_global_assets/character/hero.png",
      audio_path: null,
      source_project: null,
      owner_user_id: null,
      owner: null,
      updated_at: "2026-08-20T00:00:00Z",
    };
    vi.spyOn(API, "listAssets").mockResolvedValue({ items: [asset] });
    const file = new File(["image"], "Hero.png", { type: "image/png", lastModified: 3 });
    const getFile = vi.spyOn(API, "getGlobalAssetFile").mockResolvedValue(file);
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: t("free_creation_reference_assets") })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: t("free_creation_reference_assets") }));
    const dialog = await screen.findByRole("dialog", { name: t("free_creation_asset_picker_title") });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Hero/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: t("free_creation_reference_assets") }));

    await waitFor(() => expect(getFile).toHaveBeenCalledWith(asset));
    expect(await screen.findByText("Hero.png")).toBeInTheDocument();
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

  it("updates the duration range when switching to a 30-second Seedance model", async () => {
    vi.mocked(API.getModelCandidates).mockResolvedValue({
      image: { default: [], buckets: {} },
      video: { default: ["anyfast/seedance-2.0", "anyfast/seedance-2.5"], buckets: {} },
      provider_names: {},
    });
    vi.mocked(API.getSystemConfig).mockResolvedValue({ settings: {} } as never);
    vi.mocked(API.getFreeCreationCapabilities).mockImplementation(async ({ outputType, model }) => ({
      output_type: outputType,
      model: model ?? "anyfast/seedance-2.0",
      ratios: ["16:9"],
      resolutions: ["1080p"],
      durations: model?.includes("2.5") ? Array.from({ length: 27 }, (_, index) => index + 4) : [4, 5, 10, 15],
      max_reference_images: 4,
      max_reference_videos: 1,
      max_reference_media_count: 4,
      input_slots: [{ role: "reference_image", accepted_types: ["image"], max_count: 4 }],
    }));
    render(<HomeHeroComposer onCreated={vi.fn()} />);

    const model = await screen.findByRole("button", { name: t("home_model") });
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "seedance-2.5" }));
    await waitFor(() => expect(API.getFreeCreationCapabilities).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "anyfast/seedance-2.5" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: t("home_duration") }));
    await waitFor(() => expect(screen.getByRole("slider", { name: t("home_duration") })).toHaveAttribute("max", "30"));
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
