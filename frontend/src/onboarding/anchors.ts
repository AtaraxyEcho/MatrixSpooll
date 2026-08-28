/**
 * 引导锚点注册表。
 *
 * 锚点名在这里登记一次，两头都从这里引用：组件挂 `data-onboarding={ONBOARDING_ANCHORS.x}`，
 * 步骤定义写 `anchor: ONBOARDING_ANCHORS.x`。名字漂移因此是 typecheck 错误，而不是运行时
 * 静默丢掉高亮。改动带 `data-onboarding` 的元素时，回来核对本表与对应步骤的文案是否仍成立。
 *
 * | 锚点 | 步 | 指向 |
 * |---|---|---|
 * | `lobby-create-project` | 大厅 2 | 项目大厅顶栏的「新建项目」按钮 |
 * | `lobby-settings` | 大厅 3 | 项目大厅顶栏的设置图标（配置齐全前带红点） |
 * | `lobby-demo-card` | 大厅 4 | 引导期间注入大厅的演示项目卡（进演示工作台的桥） |
 * | `workbench-overview` | 工作台 5 | 项目概览的项目概述卡 |
 * | `workbench-agent` | 工作台 6 | 演示工作台右侧的助手面板（静态演示对话） |
 * | `workbench-lorebook` | 工作台 7 | 角色集页面的卡片区 |
 * | `workbench-timeline` | 工作台 8 | 剧集分镜画布的镜头主体 |
 * | `workbench-export` | 工作台 9 | 顶栏的导出按钮 |
 *
 * 设置页本身不挂锚点——导览在设置入口一步只指路不进详情，配置教学交由大厅的上手清单
 * 承接（见 `GetStartedChecklist.tsx`），想配置时带着目的去，比被拽着走学得进去。
 *
 * 工作台五步落在演示项目的只读工作台上（见 `demo-project.ts`）。概述/角色集/分镜/导出
 * 的锚点挂在真实工作台组件上而不是演示专用的副本——演示与真实项目共用同一份实现，锚点
 * 因此对两者都成立；`workbench-agent` 是例外，真实助手面板是写路径、演示态不挂载，锚点
 * 挂在演示专用的 `DemoAssistantPanel` 上。
 *
 * 大厅第 1 步与收尾步是居中的气泡，不挂锚点。
 */

export const ONBOARDING_ANCHORS = {
  lobbyCreateProject: "lobby-create-project",
  lobbyDemoCard: "lobby-demo-card",
  lobbySettings: "lobby-settings",
  workbenchOverview: "workbench-overview",
  workbenchAgent: "workbench-agent",
  workbenchLorebook: "workbench-lorebook",
  workbenchTimeline: "workbench-timeline",
  workbenchExport: "workbench-export",
} as const;

export type OnboardingAnchor = (typeof ONBOARDING_ANCHORS)[keyof typeof ONBOARDING_ANCHORS];
