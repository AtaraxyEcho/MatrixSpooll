/**
 * 首次使用引导的步骤大纲。
 *
 * 结构（顺序、锚点、路由）写在这里，文案全部走 `onboarding` 命名空间的 i18n key —— 两者
 * 分离，加语种不必碰结构，调顺序不必碰翻译。锚点一律引用 `anchors.ts` 的注册表，不写
 * 字面量。`route` 是该步所需落地的页面（`OnboardingTour` 据此在步骤切换前先行导航），
 * 省略表示不要求特定路由。
 *
 * 导览只负责「认界面、建心智模型」：大纲按三段组织——大厅段（欢迎 / 新建入口 / 设置
 * 指路）、演示段（演示卡进只读演示工作台，认识概览 / 智能体 / 资产 / 分镜 / 导出）、
 * 收尾（行动闭环）。配置教学不进导览：设置入口一步只指路，详情由大厅的上手清单承接
 * （`GetStartedChecklist.tsx`），用户带着目的去配置，比被拽着走学得进去。
 *
 * 段落条件与路由守卫消费同一份 `canAccessSystemSettings`（见 utils/access.ts）：不可
 * 访问系统设置的会话（member）跳过设置指路步，界面到不了的地方大纲里就不会出现。
 *
 * 步骤文案里指路用的名字一律取被高亮元素在界面上的实际标签，不另造概念——用户照着
 * 文案在界面上找得到，才算指对了路。
 *
 * 演示段落在演示项目的只读工作台上（`demo-project.ts`）。演示卡是 `interactive`：
 * 用户点卡片本身或点「下一步」都会进入演示工作台，引导顺势推进到工作台首步（判定见
 * `OnboardingTour.tsx`）；演示段内部的换路由仍由 `route` 强制导航驱动。
 *
 * 收尾步落回大厅并声明 `action: "create-project"`——气泡上的「立即创建项目」按钮点击
 * 后关闭引导并打开新建弹窗，把「学完」直接接到「动手」。落点选大厅（新建入口所在页）
 * 而不是演示工作台：创建项目的大厅才是引导结束后的自然去处。
 */

import type { TFunction } from "i18next";
import {
  ROUTE_APP,
  ROUTE_APP_PROJECTS,
  WORKSPACE_ROUTE_CHARACTERS,
  WORKSPACE_ROUTE_EPISODES,
} from "@/app-routes";
import { canAccessSystemSettings } from "@/utils/access";
import { ONBOARDING_ANCHORS } from "./anchors";
import { DEMO_PROJECT_NAME, DEMO_SCRIPTED_EPISODE } from "./demo-project";
import type { TourStep } from "./tour";

/** 演示工作台的三条落地路由。全小写——`OnboardingTour` 归一化后按字面比对当前路由。 */
const DEMO_WORKBENCH = `${ROUTE_APP_PROJECTS}/${DEMO_PROJECT_NAME}`;
const DEMO_LOREBOOK = `${DEMO_WORKBENCH}/${WORKSPACE_ROUTE_CHARACTERS}`;
const DEMO_EPISODE = `${DEMO_WORKBENCH}/${WORKSPACE_ROUTE_EPISODES}/${DEMO_SCRIPTED_EPISODE}`;

export function buildTourSteps(
  t: TFunction<"onboarding">,
  role: "admin" | "member" | null,
): TourStep[] {
  return [
    // -- 大厅段 ---------------------------------------------------------------
    { anchor: null, title: t("welcome_title"), body: t("welcome_body"), route: ROUTE_APP_PROJECTS },
    {
      anchor: ONBOARDING_ANCHORS.lobbyCreateProject,
      title: t("lobby_create_title"),
      body: t("lobby_create_body"),
      route: ROUTE_APP_PROJECTS,
    },
    // 设置指路步：只讲入口与时机，不进设置页讲配置详情。不可访问系统设置的会话没有
    // 这个入口，这一步也随之消失。
    ...(canAccessSystemSettings(role)
      ? [
          {
            anchor: ONBOARDING_ANCHORS.lobbySettings,
            title: t("lobby_settings_title"),
            body: t("lobby_settings_body"),
            route: ROUTE_APP_PROJECTS,
          } satisfies TourStep,
        ]
      : []),
    // -- 演示段 ---------------------------------------------------------------
    {
      anchor: ONBOARDING_ANCHORS.lobbyDemoCard,
      title: t("lobby_demo_title"),
      body: t("lobby_demo_body"),
      // 演示卡由首页（/app）的 home 模式挂载；项目列表页（/app/projects）不会渲染它，
      // 否则从大厅指路步进入这一步时 driver 会等待不存在的锚点直到超时。
      route: ROUTE_APP,
      // 全程只读的例外：这一步的落点动作是导航进演示工作台，不是写操作，因此开放
      // 交互（见 tour.ts 的 `interactive` 语义）；演示卡本身仅在引导运行期间挂载，
      // 退出后随即卸载，不留可写入口。
      interactive: true,
      // 点卡片落到演示工作台（含其子路由）。落到这里算「顺着引导走」，引导顺势推进
      // 到下一步（工作台首步）；落到别处仍按强制导航拽回大厅。
      interactiveTarget: DEMO_WORKBENCH,
    },
    {
      anchor: ONBOARDING_ANCHORS.workbenchOverview,
      title: t("workbench_overview_title"),
      body: t("workbench_overview_body"),
      route: DEMO_WORKBENCH,
    },
    {
      anchor: ONBOARDING_ANCHORS.workbenchAgent,
      title: t("workbench_agent_title"),
      body: t("workbench_agent_body"),
      // 智能体面板挂在工作台布局壳上，所有工作台路由都渲染；留在概览页讲，省一次导航。
      route: DEMO_WORKBENCH,
    },
    {
      anchor: ONBOARDING_ANCHORS.workbenchLorebook,
      title: t("workbench_lorebook_title"),
      body: t("workbench_lorebook_body"),
      route: DEMO_LOREBOOK,
    },
    {
      anchor: ONBOARDING_ANCHORS.workbenchTimeline,
      title: t("workbench_timeline_title"),
      body: t("workbench_timeline_body"),
      route: DEMO_EPISODE,
    },
    {
      anchor: ONBOARDING_ANCHORS.workbenchExport,
      title: t("workbench_export_title"),
      body: t("workbench_export_body"),
      // 顶栏在所有工作台路由上都挂着，留在上一步的分镜画布讲，省掉一次无谓导航。
      route: DEMO_EPISODE,
    },
    // -- 收尾 -----------------------------------------------------------------
    {
      anchor: null,
      title: t("finish_title"),
      body: t("finish_body"),
      route: ROUTE_APP_PROJECTS,
      action: "create-project" as const,
    },
  ];
}
