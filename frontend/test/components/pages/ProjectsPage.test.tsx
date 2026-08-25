import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { API } from "@/api";
import i18n from "@/i18n";
import { useAppStore } from "@/stores/app-store";
import { useProjectsStore } from "@/stores/projects-store";
import { ProjectsPage } from "@/components/pages/ProjectsPage";

const t = i18n.getFixedT("zh", "dashboard");

vi.mock("@/components/pages/CreateProjectModal", () => ({
  CreateProjectModal: () => <div data-testid="create-project-modal">Create Project Modal</div>,
}));

function renderPage(mode: "home" | "list" = "home") {
  const location = memoryLocation({ path: mode === "list" ? "/app/projects" : "/app", record: true });
  return {
    ...render(
      <Router hook={location.hook}>
        <ProjectsPage mode={mode} />
      </Router>,
    ),
    location,
  };
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows loading state while projects are being fetched", () => {
    vi.spyOn(API, "listProjects").mockImplementation(
      () => new Promise(() => {}),
    );

    renderPage();
    expect(screen.getByText("加载项目列表...")).toBeInTheDocument();
  });

  it("shows empty state when no projects exist", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage();

    // 0 项目时仅渲染 NewProjectTile 占位卡（lobby_new_project_title）
    expect(await screen.findByText("新建项目")).toBeInTheDocument();
  });

  it("renders a dedicated project list without the homepage composer", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage("list");

    expect(await screen.findByTestId("project-list-page")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "鍥剧墖鐢熸垚" })).not.toBeInTheDocument();
  });

  it("creates an image free project from the homepage composer", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    vi.spyOn(API, "getModelCandidates").mockRejectedValue(new Error("offline"));
    vi.spyOn(API, "getSystemConfig").mockRejectedValue(new Error("offline"));
    vi.spyOn(API, "getFreeCreationCapabilities").mockImplementation(async ({ outputType }) => ({
      output_type: outputType,
      model: "ark/image-model",
      ratios: ["16:9", "9:16", "1:1"],
      resolutions: outputType === "image" ? ["1.5k", "2k", "4k"] : [],
      durations: [],
      max_reference_images: null,
      max_reference_videos: null,
      max_reference_media_count: null,
    }));
    const createProject = vi.spyOn(API, "createFreeProject").mockResolvedValue({
      success: true,
      name: "paper-plane",
      creation_id: "c_0123456789abcdef0123",
      task_id: "task-1",
    });

    const { location } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: t("free_creation_mode") }));
    fireEvent.click(screen.getByRole("option", { name: t("free_creation_mode_image") }));
    fireEvent.change(screen.getByRole("textbox", { name: t("home_prompt_label") }), {
      target: { value: "纸飞机穿过云层" },
    });
    const submit = screen.getByRole("button", { name: t("home_generate") });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    expect(createProject).toHaveBeenCalledWith({
      title: "纸飞机穿过云层",
      creation: expect.objectContaining({
        output_type: "image",
        prompt: "纸飞机穿过云层",
        aspect_ratio: "16:9",
        resolution: "1.5k",
        size: "1536x864",
        quantity: 1,
      }),
    });
    expect(location.history?.at(-1)).toBe("/app/projects/paper-plane?mode=image");
  });

  it("renders project cards when data exists", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Demo Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          content_mode: "free",
          thumbnail: null,
          status: {
            phase: "production",
            phase_progress: 0.5,
            needs_repair: false,
            repair_reason: null,
            assets: {
              character: { total: 2, available: 2, stale: 0 },
              scene: { total: 1, available: 1, stale: 0 },
              prop: { total: 1, available: 0, stale: 0 },
            },
            episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    // Title may render twice (cinemascope poster overlay + heading) in the
    // featured "Now Editing" card — see ProjectsPage.tsx Darkroom design.
    expect((await screen.findAllByText("Demo Project")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("project-content-mode")).toHaveTextContent(t("free_creation"));
    expect(screen.getAllByText("商业动画 京都").length).toBeGreaterThan(0);
    // 阶段名与工作台同一套词：卡片胶囊、筛选胶囊、Hero 计数格都读「制作」
    expect(screen.getAllByText("制作").length).toBeGreaterThan(0);
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("hides project settings from viewers and opens the members dialog", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "shared",
          title: "Shared Project",
          style: "Anime",
          current_role: "viewer",
          thumbnail: null,
          status: {},
        },
      ],
    });
    const listMembers = vi.spyOn(API, "listProjectMembers").mockResolvedValue({
      members: [
        { user_id: "owner-1", username: "owner", role: "owner", is_owner: true },
        { user_id: "viewer-1", username: "viewer", role: "viewer", is_owner: false },
      ],
    });

    renderPage("list");
    fireEvent.click(await screen.findByRole("button", { name: /项目操作.*Shared Project/ }));

    expect(screen.queryByRole("link", { name: /项目设置/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /项目成员/ }));

    const dialog = await screen.findByRole("dialog", { name: "项目成员" });
    expect(dialog).toHaveClass("w-fit");
    expect(dialog).toHaveClass("max-w-[min(56rem,calc(100vw-2rem))]");
    await waitFor(() => expect(listMembers).toHaveBeenCalledWith("shared"));
  });

  it("links editors to project settings from the project menu", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "editable",
          title: "Editable Project",
          style: "Anime",
          current_role: "editor",
          thumbnail: null,
          status: {},
        },
      ],
    });

    const { location } = renderPage("list");
    fireEvent.click(await screen.findByRole("button", { name: /项目操作.*Editable Project/ }));
    fireEvent.click(screen.getByRole("link", { name: /项目设置/ }));

    expect(location.history?.at(-1)).toBe("/app/projects/editable/settings");
  });

  it("filters by the four merged phases and counts each pill", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "writing",
          title: "Writing Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: {
            phase: "script" as const,
            phase_progress: 0.5,
            needs_repair: false,
            repair_reason: null,
            assets: { character: { total: 1, available: 1, stale: 0 } },
            episodes_summary: { total: 2, scripted: 1, in_production: 0, completed: 0 },
          },
        },
        {
          name: "shooting",
          title: "Shooting Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: {
            phase: "production" as const,
            phase_progress: 0.4,
            needs_repair: false,
            repair_reason: null,
            assets: { character: { total: 1, available: 1, stale: 0 } },
            episodes_summary: { total: 2, scripted: 2, in_production: 1, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    const scriptPill = await screen.findByRole("button", { name: /脚本/ });
    fireEvent.click(scriptPill);

    await waitFor(() => {
      expect(screen.queryByText("Shooting Project")).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("Writing Project").length).toBeGreaterThan(0);
  });

  it("keeps content filters available when a mode has no matching projects", async () => {
    vi.spyOn(API, "listProjects").mockImplementation(async (filters = {}) => {
      if (filters.contentMode === "drama") {
        return {
          projects: [],
          pagination: { page: 1, page_size: 24, total: 0, total_pages: 1 },
        };
      }
      return {
        projects: [
          {
            name: "free-project",
            title: "Free Project",
            content_mode: "free",
            style: "cinematic",
            thumbnail: null,
            status: {},
          },
        ],
        pagination: { page: 1, page_size: 24, total: 1, total_pages: 1 },
      };
    });

    renderPage();

    const contentModeGroup = await screen.findByRole("group", { name: t("content_mode") });
    fireEvent.click(within(contentModeGroup).getByRole("button", { name: t("drama_animation") }));
    await waitFor(() => expect(screen.queryByText("Free Project")).not.toBeInTheDocument());

    fireEvent.click(within(contentModeGroup).getByRole("button", { name: t("lobby_filter_all") }));

    expect((await screen.findAllByText("Free Project")).length).toBeGreaterThan(0);
    expect(localStorage.getItem("matrixspooll.lobby.contentModeFilter")).toBe("all");
  });

  it("tells the reader how many sheets are older than the current content", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "aged",
          title: "Aged Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: {
            phase: "production" as const,
            phase_progress: 0.5,
            needs_repair: false,
            repair_reason: null,
            assets: {
              character: { total: 3, available: 3, stale: 2 },
              scene: { total: 1, available: 1, stale: 0 },
              prop: { total: 0, available: 0, stale: 0 },
              // 卡片的计数格只列举三类，这一行仍要把其余资产类型的 stale 算进去
              product: { total: 1, available: 1, stale: 1 },
            },
            episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    expect(await screen.findByText("3 张设计图比当前内容旧")).toBeInTheDocument();
    // Stale assets remain visible through the dedicated stale-assets line.
  });

  it("marks a project that needs repair and shows the reason on the card", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "broken",
          title: "Broken Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: {
            phase: "production",
            phase_progress: 0.5,
            needs_repair: true,
            repair_reason: "episode script scripts/episode_1.json item 2 has no identity",
            assets: {
              character: { total: 1, available: 1, stale: 0 },
              scene: { total: 1, available: 1, stale: 0 },
              prop: { total: 0, available: 0, stale: 0 },
            },
            episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    // 唯一项目会成为「正在编辑」卡；标记与原因在两张卡上都必须出现
    expect((await screen.findAllByText("需要修复")).length).toBeGreaterThan(0);
    // 原因是可见文本而非 tooltip：触摸设备打不开 title，屏幕阅读器也读不到
    expect(
      screen.getAllByText("episode script scripts/episode_1.json item 2 has no identity").length,
    ).toBeGreaterThan(0);
  });

  it("puts the repair state and reason into the library card's accessible name", async () => {
    const brokenStatus = {
      phase: "production" as const,
      phase_progress: 0.5,
      needs_repair: true,
      repair_reason: "episode script scripts/episode_1.json item 2 has no identity",
      assets: {
        character: { total: 1, available: 1, stale: 0 },
        scene: { total: 1, available: 1, stale: 0 },
        prop: { total: 0, available: 0, stale: 0 },
      },
      episodes_summary: { total: 1, scripted: 1, in_production: 1, completed: 0 },
    };
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "healthy",
          title: "Healthy Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: { ...brokenStatus, needs_repair: false, repair_reason: null, phase_progress: 0.9 },
        },
        {
          name: "broken",
          title: "Broken Project",
          style: "Anime",
          style_template_id: "anim_kyoto",
          thumbnail: null,
          status: brokenStatus,
        },
      ],
    });

    renderPage();

    // 常规卡整张是一个 link，内部文本被 aria-label 覆盖——修复状态与原因必须写进这个名字
    expect(
      await screen.findByRole("link", {
        name: /Broken Project.*需要修复.*episode script scripts\/episode_1\.json item 2 has no identity/s,
      }),
    ).toBeInTheDocument();
  });

  it("shows 自定义风格 label when project has style_image but no template_id", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Custom Demo",
          style: "",
          style_template_id: null,
          style_image: "style_reference.png",
          thumbnail: null,
          status: {
            phase: "production",
            phase_progress: 0.1,
            needs_repair: false,
            repair_reason: null,
            assets: {
              character: { total: 1, available: 0, stale: 0 },
              scene: { total: 0, available: 0, stale: 0 },
              prop: { total: 0, available: 0, stale: 0 },
            },
            episodes_summary: { total: 1, scripted: 0, in_production: 1, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    expect((await screen.findAllByText("Custom Demo")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/自定义风格/).length).toBeGreaterThan(0);
  });

  it("shows 未设置风格 label when project has neither template_id nor style_image", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "demo",
          title: "Empty Style Demo",
          style: "",
          style_template_id: null,
          style_image: null,
          thumbnail: null,
          status: {
            phase: "production",
            phase_progress: 0,
            needs_repair: false,
            repair_reason: null,
            assets: {
              character: { total: 0, available: 0, stale: 0 },
              scene: { total: 0, available: 0, stale: 0 },
              prop: { total: 0, available: 0, stale: 0 },
            },
            episodes_summary: { total: 0, scripted: 0, in_production: 0, completed: 0 },
          },
        },
      ],
    });

    renderPage();

    expect((await screen.findAllByText("Empty Style Demo")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/未设置风格/).length).toBeGreaterThan(0);
  });

  it("opens create project modal after clicking new project button", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });

    renderPage();
    await screen.findByText("新建项目");
    expect(screen.queryByTestId("create-project-modal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() => {
      expect(screen.getByTestId("create-project-modal")).toBeInTheDocument();
    });
  });

  it("imports a zip project, refreshes the list, and navigates to the workspace", async () => {
    vi.spyOn(API, "listProjects")
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({
        projects: [
          {
            name: "imported-demo",
            title: "Imported Demo",
            style: "Anime",
            thumbnail: null,
            status: {
              phase: "completed",
              phase_progress: 1,
              needs_repair: false,
              repair_reason: null,
              assets: {
                character: { total: 1, available: 1, stale: 0 },
                scene: { total: 1, available: 1, stale: 0 },
                prop: { total: 0, available: 0, stale: 0 },
              },
              episodes_summary: { total: 1, scripted: 1, in_production: 0, completed: 1 },
            },
          },
        ],
      });
    vi.spyOn(API, "importProject").mockResolvedValue({
      success: true,
      project_name: "imported-demo",
      project: {
        title: "Imported Demo",
        content_mode: "narration",
        style: "Anime",
        episodes: [],
        characters: {},
        scenes: {},
        props: {},
      },
      warnings: ["发现未识别的附加文件/目录: extras"],
      conflict_resolution: "none",
      diagnostics: {
        auto_fixed: [{ code: "missing_clues_field", message: "segments[0]: 补全缺失字段 clues_in_segment" }],
        warnings: [{ code: "validation_warning", message: "发现未识别的附加文件/目录: extras" }],
      },
    });

    const { container, location } = renderPage();
    await screen.findByText("新建项目");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["zip"], "project.zip", { type: "application/zip" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(API.importProject).toHaveBeenCalledWith(file, "prompt");
    });
    // 当存在 warnings/auto_fixed 时先弹诊断对话框，关闭后才跳转
    expect(await screen.findByText("导入诊断")).toBeInTheDocument();
    expect(useAppStore.getState().toast?.text).toContain("自动修复");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(location.history?.at(-1)).toBe("/app/projects/imported-demo");
    });
  });

  it("shows a structured toast when import fails", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({ projects: [] });
    const error = new Error("导入包校验失败") as Error & {
      detail?: string;
      errors?: string[];
      warnings?: string[];
      diagnostics?: {
        blocking: { code: string; message: string }[];
        auto_fixable: { code: string; message: string }[];
        warnings: { code: string; message: string }[];
      };
    };
    error.detail = "导入包校验失败";
    error.errors = ["缺少 project.json", "缺少 scripts/episode_1.json", "缺少角色图"];
    error.warnings = ["发现未识别的附加文件/目录: extras"];
    error.diagnostics = {
      blocking: [
        { code: "validation_error", message: "缺少 project.json" },
        { code: "validation_error", message: "缺少 scripts/episode_1.json" },
      ],
      auto_fixable: [
        { code: "missing_clues_field", message: "segments[0]: 补全缺失字段 clues_in_segment" },
      ],
      warnings: [
        { code: "validation_warning", message: "发现未识别的附加文件/目录: extras" },
      ],
    };
    vi.spyOn(API, "importProject").mockRejectedValue(error);

    const { container } = renderPage();
    await screen.findByText("新建项目");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["zip"], "broken.zip", { type: "application/zip" })] },
    });

    await waitFor(() => {
      expect(screen.getByText("导入失败诊断")).toBeInTheDocument();
    });
    expect(screen.getByText("缺少 project.json")).toBeInTheDocument();
    expect(screen.getByText("缺少 scripts/episode_1.json")).toBeInTheDocument();
    expect(screen.getByText("segments[0]: 补全缺失字段 clues_in_segment")).toBeInTheDocument();
  });

  it("opens a secondary confirmation when import hits a duplicate project id", async () => {
    vi.spyOn(API, "listProjects")
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValueOnce({
        projects: [
          {
            name: "demo",
            title: "Demo",
            style: "Anime",
            thumbnail: null,
            status: {
              phase: "completed",
              phase_progress: 1,
              needs_repair: false,
              repair_reason: null,
              assets: {
                character: { total: 1, available: 1, stale: 0 },
                scene: { total: 1, available: 1, stale: 0 },
                prop: { total: 0, available: 0, stale: 0 },
              },
              episodes_summary: { total: 1, scripted: 1, in_production: 0, completed: 1 },
            },
          },
        ],
      });
    const conflictError = new Error("检测到项目编号冲突") as Error & {
      status?: number;
      detail?: string;
      errors?: string[];
      conflict_project_name?: string;
    };
    conflictError.status = 409;
    conflictError.detail = "检测到项目编号冲突";
    conflictError.errors = ["项目编号 'demo' 已存在"];
    conflictError.conflict_project_name = "demo";

    vi.spyOn(API, "importProject")
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({
        success: true,
        project_name: "demo-renamed",
        project: {
          title: "Renamed Demo",
          content_mode: "narration",
          style: "Anime",
          episodes: [],
          characters: {},
          scenes: {},
          props: {},
        },
        warnings: [],
        conflict_resolution: "renamed",
        diagnostics: {
          auto_fixed: [],
          warnings: [],
        },
      });

    const { container, location } = renderPage();
    await screen.findByText("新建项目");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["zip"], "project.zip", { type: "application/zip" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText("检测到项目编号重复")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "自动重命名导入" }));

    await waitFor(() => {
      expect(API.importProject).toHaveBeenNthCalledWith(1, file, "prompt");
    });
    await waitFor(() => {
      expect(API.importProject).toHaveBeenNthCalledWith(2, file, "rename");
    });
    await waitFor(() => {
      expect(location.history?.at(-1)).toBe("/app/projects/demo-renamed");
    });
  });

  it("renders the prompt composer and project rail on the homepage", async () => {
    vi.spyOn(API, "listProjects").mockResolvedValue({
      projects: [
        {
          name: "prep-a",
          title: "Prompt project",
          style: "Anime",
          thumbnail: null,
          status: {},
        },
      ],
    });

    renderPage();

    expect(await screen.findByRole("textbox")).toBeInTheDocument();
    expect(screen.getAllByText("Prompt project").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /新建项目/ })).toBeInTheDocument();
  });
});
