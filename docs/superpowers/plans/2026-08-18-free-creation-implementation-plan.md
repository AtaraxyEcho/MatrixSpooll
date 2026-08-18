# 自由创作项目模式与 MatrixSpooll 品牌迁移实施方案

> **For agentic workers:** This is an implementation plan. Execute the tasks in dependency order and keep the checkboxes updated. Do not route free projects through the fixed episode workflow.

**Goal:** 在 MatrixSpooll 项目内增加 `content_mode=free`，提供以聊天或直连请求为入口的图片、视频和媒体编辑能力；自由项目不要求源文件、脚本、分集或固定 `generation_mode`，但继续复用项目权限、任务队列、事件推送、成本记录和产物清单。同时完成产品品牌从 ArcReel 到 MatrixSpooll 的用户可见迁移，并替换应用与文档站图标。

**Design source:** [`docs/adr/0064-free-creation-project-mode-and-model-orchestration.md`](../../adr/0064-free-creation-project-mode-and-model-orchestration.md)

**Model rule:** 文本模型负责聊天理解、意图分流和工具调用；图片模型负责最终图片或图片编辑；视频模型负责最终视频。直接文生视频不经过图片模型，直连生成入口可以跳过文本模型。

## Branding and icon requirements

本方案中的“项目名称修改”指产品品牌和用户可见文案迁移为 `MatrixSpooll`，不等同于立即重命名 Python 包、环境变量、数据库文件、项目目录或 GitHub 仓库。`ARCREEL_*`、`arcreel` 数据库/目录名和历史归档标识先保持兼容，避免已有部署和项目数据失效；如需变更这些内部标识，应另立迁移方案并提供兼容窗口。

品牌迁移的单一真相源仍是 `frontend/src/branding.ts`。所有页面标题、登录页、项目大厅、助手相关品牌占位符和浏览器 meta 应解析为 `MatrixSpooll`；源码注释、历史 CHANGELOG 和不可变外部链接不在本次逐字改写范围内。

图标替换必须覆盖 Web、PWA 和文档站，而不是只改一个 favicon：

- `frontend/public/favicon.ico`、`favicon-16x16.png`、`favicon-32x32.png`、`apple-touch-icon.png`。
- `frontend/public/android-chrome-192x192.png`、`android-chrome-512x512.png`、`android-chrome-maskable-192x192.png`、`android-chrome-maskable-512x512.png`。
- `frontend/public/site.webmanifest` 的 `name`、`short_name`、`icons` 和品牌颜色。
- `website/static/img/favicon.ico`、`website/static/img/logo.png` 以及 Docusaurus 的标题、导航 Logo、Logo alt 和版权文案。

图标以一个可追溯的主标志源文件导出上述尺寸，保留 maskable 安全区；验收时清理旧浏览器缓存后分别检查登录页、项目页、PWA 安装预览和文档站首屏，确保不再显示旧图标或旧品牌名。

## Non-goals

- 不把 `free` 增加为 `generation_mode`。
- 不让自由项目生成 `scripts/episode_*.json`、分集账本或固定工作流步骤。
- 不默认采用“文本模型 -> 图片模型 -> 视频模型”的三级流水线。
- 不在本阶段实现跨项目的全局创作空间。
- 不允许不支持的比例静默回退为 `16:9`。
- 不在本阶段批量重命名 `ARCREEL_*` 环境变量、`arcreel` 数据目录/数据库、Python 模块名或历史归档协议。

## Domain contract

新建自由项目的最小 `project.json` 形态：

```json
{
  "content_mode": "free",
  "generation_mode": null,
  "episodes": [],
  "aspect_ratio": "9:16"
}
```

`aspect_ratio` 是项目默认值，不是每次自由请求的最终锁定值。自由请求可以携带自己的比例、清晰度和视频时长，最终执行事实写入任务和产物依据。

自由创作请求至少包含：

- `output_type`: `image`、`video` 或 `edit`
- `prompt`: 用户原始指令
- `references`: 图片、视频或音频引用列表
- `aspect_ratio`: 可选，缺省时使用项目默认值
- `resolution` / `duration_seconds`: 按媒体类型和模型能力校验
- `parent_creation_id`: 可选，用于“基于上一版继续修改”
- `prompt_mode`: 当前公开契约只接受 `original`；后续接入文本改写服务后再增加 `enhance`

自由结果使用项目内 `creations/` 目录保存文件，使用现有 `.arcreel_artifacts.json` 登记正式产物；不得新增第二套产物清单作为真相源。

## File map

| File | Operation | Responsibility |
| --- | --- | --- |
| `lib/profile_manifest.py` | Modify | 注册 `free` 内容模式，保持 profile 变体校验完整 |
| `agent_runtime_profile/CLAUDE.free.md` | Create | 自由项目的智能体规则、工具选择和模型调用边界 |
| `agent_runtime_profile/.claude/skills/free-creation/SKILL.md` | Create | 自由创作请求编排、原文直送和编辑迭代规则 |
| `agent_runtime_profile/.claude/skills/video-workflow/SKILL.free.md` | Create or remove by profile policy | 满足现有变体完整性约束；自由项目不得执行固定工作流 |
| `lib/project_manager.py` | Modify | `ContentMode`、项目目录、自由项目元数据和创建守卫 |
| `server/routers/projects.py` | Modify | 创建请求允许自由项目不选 `generation_mode`，固定项目仍强制二选一 |
| `lib/data_validator.py` | Modify | 自由项目的 `generation_mode=null`、空 episodes 和目录白名单校验 |
| `lib/workflow_state.py` | Modify | 自由项目短路固定状态机，返回“工作流不适用”状态 |
| `lib/workflow_plan.py` | Modify | 禁止对自由项目调用 `workflow_rule()` |
| `server/routers/free_creations.py` | Create | 项目内自由创作请求、列表、版本和下载接口 |
| `server/services/free_creation_tasks.py` | Create | 图片、视频和编辑任务适配器及正式产物提交 |
| `server/services/generation_tasks.py` | Modify | 注册 `free_image`、`free_video`、`free_edit` 执行入口或委托新服务 |
| `server/agent_runtime/sdk_tools/` | Modify | 自由图片、自由视频、编辑和历史查询 MCP 工具 |
| `frontend/src/types/project.ts` | Modify | `free` 内容模式、自由状态和自由产物类型 |
| `frontend/src/types/free-creation.ts` | Create | 请求、任务、产物、版本和能力响应类型 |
| `frontend/src/api.ts` | Modify | 项目自由创作 API |
| `frontend/src/components/pages/CreateProjectModal.tsx` | Modify | 增加“自由创作”卡片，隐藏固定工作流字段 |
| `frontend/src/components/canvas/FreeCreationCanvas.tsx` | Create | 聊天输入、媒体类型、参考素材、结果流和版本迭代 |
| `frontend/src/components/canvas/StudioCanvasRouter.tsx` | Modify | 自由项目路由到自由画布 |
| `frontend/src/components/layout/AssetSidebar.tsx` | Modify | 自由项目隐藏剧集列表，展示创作历史入口 |
| `frontend/src/branding.ts` / `frontend/index.html` | Modify | 将默认产品名、加载期标题和 meta 默认值切换为 `MatrixSpooll` |
| `frontend/.env.example` | Modify | 更新 `VITE_BRAND_NAME` 示例和品牌资源说明 |
| `frontend/public/*` | Replace / Modify | 替换 Web/PWA favicon、触控图标、maskable 图标和 manifest 品牌字段 |
| `lib/video_backends/base.py` | Modify | 声明视频模型支持的比例或自适应能力 |
| `lib/video_backends/ark.py` | Modify | 声明 Seedance 各型号的比例能力并保留首帧自适应约束 |
| `server/routers/providers.py` / capability endpoint | Modify | 返回当前执行模型的比例、时长和输入能力 |
| `frontend/src/components/shared/AspectRatioPicker.tsx` | Create | 能力驱动的比例选择和画框预览 |
| `frontend/src/components/ui/AspectFrame.tsx` | Modify | 支持动态比例，不再只映射两种 Tailwind class |
| `lib/project_archive.py` / `server/services/project_archive.py` | Modify | 归档和导入 `creations/` 及其产物清单条目 |
| `website/docusaurus.config.ts` / `website/static/img/*` | Modify / Replace | 更新文档站品牌文案、Logo、favicon 和 Logo alt |
| `README.md` / `README.en.md` / `CONTRIBUTING.md` | Modify | 更新面向用户和贡献者的当前产品名称；保留历史链接与内部兼容标识说明 |
| `tests/` | Create or Modify | 后端契约、任务、能力、前端交互和回归测试 |

## Phase 0: Migrate the product brand and icon

- [x] 在 `frontend/src/branding.ts` 将默认品牌名、tagline 和 description 设置为 `MatrixSpooll`，确认所有 `[[brand]]` 占位符走同一解析结果。
- [x] 更新 `frontend/index.html` 的加载期 `<title>` 和 description，避免 JS 尚未启动时短暂显示 ArcReel。
- [x] 更新 `frontend/.env.example` 的品牌示例和静态资源说明；不修改已部署用户的 `VITE_BRAND_NAME`，除非其配置显式仍使用旧品牌。
- [ ] 用批准的 MatrixSpooll 主标志导出并替换 Web/PWA 的 8 个图标文件，补齐透明背景、清晰缩放和 maskable 安全区要求。
- [x] 更新 `frontend/public/site.webmanifest` 的 `name`、`short_name`、`theme_color`、`background_color` 和图标引用，验证安装预览名称为 MatrixSpooll。
- [x] 更新文档站 Docusaurus title、tagline、navbar title、Logo alt、footer copyright 以及活动 Logo / favicon 引用。
- [x] 更新 README、贡献指南和当前入口中的用户可见产品名；历史 CHANGELOG 和内部环境变量保持可追溯，不做无迁移的批量替换。
- [ ] 增加品牌回归检查：构建产物的页面标题、manifest 名称和静态入口不再出现旧品牌；保留兼容标识的清单，防止后续清理误删。

**Exit criteria:** 新安装或清理缓存后的 Web/PWA/文档站均显示 MatrixSpooll 和新图标；旧项目、旧环境变量和旧归档仍可读取；品牌迁移不改变自由创作或固定工作流的业务行为。

## Phase 1: Freeze the project contract

- [x] 扩展 `ContentMode` 和 `VALID_CONTENT_MODES`，新增 `free`。
- [x] 创建请求改为条件校验：固定项目必须是 `storyboard/reference_video`；自由项目必须存储 `generation_mode=null`。
- [x] `ProjectManager.create_project_metadata()` 对自由项目不补写 `storyboard` 默认值。
- [x] `grid_storyboard` 在自由项目中固定为 false 或标记为不适用，不暴露在自由设置界面。
- [ ] 加入 `creations/` 目录，并把它加入项目根目录白名单和归档白名单。
- [x] `DataValidator` 对自由项目跳过脚本骨架、分集和路线组合校验，但继续校验项目名称、比例、模型配置和路径安全。
- [ ] 为旧项目增加回归测试，确认缺失 `generation_mode` 的存量项目仍由迁移逻辑补齐，不被误判为自由项目。

**Exit criteria:** 可以通过 API 创建自由项目；固定项目的 `generation_mode` 缺失仍返回 422；自由项目的 `project.json` 不产生 episode script。

## Phase 2: Bypass the fixed workflow safely

- [x] 在 `WorkflowStateService` 入口识别 `content_mode=free`，不调用 `workflow_rule()`、`ensure_route_skeleton()` 或 episode ledger。
- [x] 为项目摘要增加显式的 `workflow_applicable=false` 和自由创作统计；不要用 `preparation` 冒充固定阶段。
- [x] 前端项目状态增加 `creative` 展示分支，`PhaseStepper` 和固定工作流面板在自由项目中隐藏。
- [x] 固定项目的 `workflow_rules` 不增加 `(free, *)` 矩阵项，避免自由模式污染既有分支。
- [ ] 需要剧集参数的旧接口对自由项目返回结构化“不适用”错误，并指向自由创作接口。

**Exit criteria:** 自由项目打开、刷新、获取摘要和项目事件时不会触发脚本读取或工作流矩阵异常；固定项目的状态快照与计划测试全部保持不变。

## Phase 3: Add the free creation task seam

### Request and API

- [x] 新增 `POST /api/v1/projects/{project_name}/creations`，接受自由创作请求并返回 `creation_id`、`task_id`。
- [x] 新增列表、详情、版本、取消、重试和下载能力；版本查询复用项目统一 `VersionManager` 接口，其他接口继续复用项目级认证和路径围栏。
- [ ] 请求层按 `output_type` 校验参考素材、比例、分辨率和时长；错误发生在入队前。
- [x] 直连 API 不调用文本模型，当前仅开放 `prompt_mode=original`，原文直接进入媒体 lane；`enhance` 待文本改写实现后再开放。

### Queue and execution

- [x] 增加 `free_image`、`free_video` 和 `free_edit` 任务类型，复用 GenerationQueue 的排队、取消和重试能力；自由视频重启恢复仍待 checkpoint 支持。
- [x] 图片任务解析 image lane；视频任务根据参考素材选择 T2V 或 R2V，不为视频任务无条件解析 image lane。
- [ ] 编辑任务根据父产物媒体类型选择 image 或 video lane，并记录 `parent_creation_id`。
- [x] 通过 `GenerationContext` 一次解析实际 provider、model、resolution 和能力；禁止任务执行器重新读取另一套项目默认值。
- [ ] provider 调用成功后，在同一正式提交边界写入 `creations/` 文件和 `artifact_manifest` 条目；当前已登记共享清单并补偿取消竞争，但文件、清单与状态 JSON 尚非单一原子事务。
- [x] 任务 payload 保存原始请求和执行事实摘要，但不把完整聊天 transcript 塞入任务记录。

### MCP tools

- [ ] 新增 `create_free_image`、`create_free_video`、`edit_free_creation`、`list_free_creations` 工具。
- [ ] 工具 schema 要求显式 `output_type` 和参考素材角色；不能让 agent 把自由创作误调用成 `generate_storyboards` 或 `generate_video_episode`。
- [ ] 工具返回结构化 `task_id`、`creation_id`、状态和失败原因，供文本模型继续对话。
- [ ] 自由 skill 明确：视频请求直接走视频工具；只有首帧设计、图片编辑或 provider 要求时才先走图片工具。

**Exit criteria:** 在没有文本模型的直连调用下，文生图只产生一次图片模型调用；文生视频只产生一次视频模型调用；图片生视频不产生额外图片生成调用；所有结果都有可查询的产物清单条目。

## Phase 4: Add the free project UI

### Homepage composer and project rail

The project list route is also the product homepage. Its primary action is an input-first free creation composer:

- The prompt is the required input. Submitting it creates a `content_mode=free` project, derives a short project title from the prompt, and immediately queues the requested media task in that project.
- The composer exposes output type, model, aspect ratio, resolution, quantity, and video duration. Image-only size choices are sent as `size`; video does not present an image pixel-size control that providers may ignore.
- The project list is rendered below the composer as a recent-project rail. It uses a two-row horizontal grid with bounded card dimensions so large project libraries do not expand the page vertically.
- The legacy project creation modal remains available from the top bar and rail card for users who need explicit project metadata before entering the workspace.

The homepage composer now performs lane/model preflight, registers successful media in the shared artifact manifest, emits project SSE changes, exposes read-only version history, and limits creation reads to the most recent 40 records. Model-specific aspect-ratio declarations and archive/cost/delete integration remain tracked below.

- [x] 创建向导增加第四种内容模式“自由创作”。选中后隐藏 source kind、target duration、speech rate、generation route 和 grid 控件。
- [ ] 仍允许配置项目默认风格、默认模型和默认比例；自由项目增加默认媒体类型（图片/视频）但不锁定每次请求。
- [ ] `FreeCreationCanvas` 提供：聊天输入、图片/视频/音频参考上传、图片/视频分段控制、比例、清晰度、视频时长、原文直送/提示词增强、生成按钮。
- [x] 结果流显示任务状态、失败原因、重试、下载和“基于此版本继续编辑”。
- [x] `StudioCanvasRouter` 在项目根路径将自由项目导向自由画布；剧集 URL 对自由项目不生成空壳页面。
- [ ] `AgentCopilot` 的会话能力在自由项目继续复用，但自由画布负责承载媒体结果，不把结果埋在右侧聊天面板。
- [x] 所有新增文本同步 `zh/en/vi` 翻译；错误提示也走现有 Translator/i18n 约束。

**Exit criteria:** 用户可以从创建项目到输入 prompt、看到任务进度、查看生成结果、基于上一版继续编辑，全程不经过固定工作流页面。

## Phase 5: Make aspect ratios capability-driven

- [ ] 新增统一的比例能力值对象，至少表达 `supported_aspect_ratios`、`supports_custom_aspect_ratio` 和 `adaptive_only`。
- [ ] 视频 backend 的能力声明作为视频比例真相源；Seedance 型号声明 `9:16`、`16:9`、`1:1`、`4:3`、`3:4`、`21:9` 的实际支持差异，首帧自适应型号不下发固定 ratio。
- [ ] 图片模型比例能力继续从模型级能力声明或 backend 约束读取，不把视频比例列表复制成图片真相源。
- [ ] capability endpoint 返回当前执行模型可选比例；前端只展示可用项，并保留后端入队校验作为最终闸门。
- [ ] `AspectRatioPicker` 支持六种首批预设和可选自定义 `width x height`；自定义仅在 `supports_custom_aspect_ratio=true` 时显示。
- [x] `AspectFrame`、时间线、项目设置和创建向导统一消费比例字符串，移除仅有 `9:16 | 16:9` 的类型收窄和非法值静默回退。
- [x] MVP 结果元数据冻结最终比例；项目默认比例改变不改写历史自由产物。

**Exit criteria:** Seedance 支持的比例在自由画布中可选；不支持的比例在入队前明确失败；历史固定项目的旧比例和已有产物不发生改变。

## Phase 6: Archive, cost and migration boundaries

- [x] 归档导出包含 `creations/` 文件、父子版本关系和 `artifact_manifest` 条目；`full` 与 `current` 两种范围均有正式往返测试。
- [ ] 导入已校验自由产物的规范路径、内容 hash 和媒体类型，且不会转换成 episode artifact；请求摘要重算校验仍待补齐。
- [ ] 成本账本为自由产物使用 `free_creation:{creation_id}` 归属键，项目汇总可以聚合但不能伪造 episode 归属。
- [ ] 删除项目时一并删除自由产物；单个自由产物删除必须同步移除清单条目并保留任务历史的失败/取消证据。
- [ ] 若 schema 版本需要递增，新增一次性迁移；存量固定项目只补显式旧字段，不生成任何自由项目记录。

## 实施状态

截至 2026-08-18，可执行 MVP 已完成：

- 项目创建契约已按内容模式分支。`drama`、`narration`、`ad` 创建时仍必须选择 `storyboard` 或 `reference_video`；`free` 不显示生成方式并强制保存 `generation_mode: null`，同时固定 `grid_storyboard: false`。
- 自由项目绕过脚本、分集和固定工作流状态机，项目摘要显式返回 `workflow_applicable=false`；项目 profile 与自由创作 skill 已可加载。
- API 与 GenerationQueue 已支持 `free_image`、`free_video`、`free_edit` 的创建、列表、详情、媒体读取、取消和重试。图片请求只解析 image lane；视频请求直接解析 video lane，不强制调用文本模型或先生成图片。
- 首页输入框已支持图片/视频、模型、比例、分辨率、图片尺寸、数量和视频秒数；提交后默认创建自由项目，项目名由输入内容截取生成，项目区按最多两行横向滚动。
- 入队前会解析实际媒体 lane 与模型，并拒绝已登记的模型能力或时长错误；最终实际模型写入产物元数据。模型级比例白名单尚未统一，因此比例暂时只做严格语法校验。
- 成功产物已登记到共享 `artifact_manifest`；自由任务完成会进入项目事件 SSE，列表与项目事件快照均只读取最近 40 条记录；运行中取消使用 `cancelling` 中间态，worker 重启丢失任务会回写可重试的失败态。
- 自由项目的 `full` 与 `current` 官方归档均可往返保留媒体、任务元数据和共享产物清单；排队、失败等尚无媒体的记录只作为任务证据保留，不会伪装成正式产物。
- 自由图片、视频和编辑结果复用 `VersionManager`，结果卡可只读查看和下载历史版本；图片编辑延迟到父子关系写入后再一次性提交成功状态。
- 直连接口当前只接受 `prompt_mode=original`，提示词原文直接进入媒体模型。`enhance` 在真正接入文本模型改写前不会暴露为可用能力。
- Web 端已将自由项目路由到 `FreeCreationCanvas`，支持输出类型、提示词、项目内参考路径、比例、视频时长、状态轮询、预览、取消、重试、下载和基于图片结果继续编辑。
- 创建向导、项目设置与画幅容器已支持 `9:16`、`16:9`、`1:1`、`4:3`、`3:4`、`21:9`，后端对任意正整数 `width:height` 做严格语法校验，不再把新比例静默收窄到横屏或竖屏。
- 默认产品名称、Web/PWA 入口、README、文档站配置和活动 SVG 标志已迁移为 MatrixSpooll；Git 远端已连接 `git@github.com:MockMine/MatrixSpooll.git`。内部 `ARCREEL_*`、数据目录、旧容器名和历史协议继续保留兼容。

以下工作仍未完成，不能视为现有支持：

- provider/model 级 `supported_aspect_ratios` 与比例入队前拒绝。官方资料没有给出可安全套用于所有 Seedance 型号的统一白名单，因此本阶段不硬编码推断值；已登记的 lane、模型和时长能力仍会在入队前校验。
- 成本归属键、单产物删除一致性、导入时的请求摘要重算，以及文件、清单和状态 JSON 的原子提交；归档/导入基本往返与内容 hash 校验已经完成。
- 基于视频父产物的编辑。当前 `free_edit` 只接受图片或图片编辑结果，避免在 provider 没有统一视频编辑契约时伪装支持。
- 自由创作 MCP 工具、聊天入口自动工具调用、文本提示词增强，以及视频任务重启后的 provider checkpoint 恢复。
- 浏览器上传参考素材和所有旧 raster 图标的位图替换；当前界面使用项目内相对路径，活动入口使用新 SVG，旧位图暂留兼容。

## Test plan

### Backend

- [x] `CreateProjectRequest`：自由项目允许空路线，固定项目仍拒绝空路线。
- [x] `DataValidator`：自由项目无 episodes/scripts 仍合法；固定项目规则不回归。
- [x] `WorkflowStateService`：自由项目不调用 `workflow_rule` 和脚本解析，并返回 `workflow_applicable=false`。
- [ ] 任务执行：图片、视频、编辑三种任务正确选择 lane，且不解析未声明的媒体 lane。
- [ ] 产物提交：provider 成功、下载失败、清单写入失败和取消竞争均保持可观测的一致状态。
- [ ] 比例能力：六种预设、adaptive-only、custom ratio 和 unsupported ratio 均有明确测试。
- [x] 归档/导入：自由产物可在 `full`/`current` 范围往返，固定项目归档保持兼容。

### Frontend

- [ ] 创建向导自由模式条件渲染和必填校验。
- [ ] 自由画布提交、任务进度、错误、重试、下载和基于父版本编辑。
- [ ] 比例选择器按 capability 响应渲染，不支持项不可提交。
- [x] 自由项目隐藏剧集侧栏和固定工作流步骤；固定项目 UI 回归测试继续通过。
- [ ] `zh/en/vi` key 一致性和可访问性测试。
- [ ] 品牌回归：默认品牌配置、HTML 加载期标题、PWA manifest、favicon/触控图标和文档站 Logo 均使用 MatrixSpooll；旧内部兼容标识仍可被配置和存量项目读取。

### Verification commands

```bash
uv run python -m pytest tests/test_free_creation*.py tests/test_workflow_state.py tests/test_project_archive.py
uv run basedpyright
uv run lint-imports
cd frontend
pnpm lint
pnpm check
```

## Rollout and observability

- [ ] 使用 `free_creation_enabled` 功能开关，先允许内部项目创建，再扩大到普通用户。
- [ ] 记录每次请求的 `project_name`、`creation_id`、媒体类型、模型、比例、耗时、失败阶段和成本，不记录完整 prompt 到普通日志。
- [ ] 重点观察：文本模型额外调用率、图片前置率、视频失败率、比例不支持率、任务平均等待时间、单次创作成本和版本编辑成功率。
- [ ] 发现 provider 能力声明与实际响应不一致时，先修正能力真相源和预检，不增加静默 fallback。

## Acceptance scenarios

1. 创建自由项目，不选择生成路线，进入项目后只看到自由画布。
2. 输入“生成一张复古海报”，直连入口只调用图片模型并登记一个自由图片产物。
3. 输入“让这张图中的人物走向镜头”，使用已有图片作为参考，直接调用视频模型，不重新调用图片模型。
4. 输入“生成一个 5 秒的赛博朋克街景视频”，聊天入口由文本模型调用自由视频工具，视频模型直接生成，不产生中间分镜图。
5. 对已有结果输入“保留人物，换成雨夜背景”，产生带父版本关系的新编辑产物，旧版本仍可查看和下载。
6. 选择不被当前模型支持的比例，提交前得到明确错误，任务不进入队列。
7. 固定 narration/drama/ad 项目仍按原有脚本、分集和 `generation_mode` 工作，所有既有 workflow 测试通过。
8. 清理浏览器缓存后打开 Web、安装 PWA 和访问文档站，均显示 MatrixSpooll 及新 icon；使用旧环境变量、旧项目目录和旧归档仍能正常启动、读取和导入。
