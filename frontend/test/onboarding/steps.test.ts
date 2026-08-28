/**
 * 步骤大纲的形状：大厅段（欢迎 + 新建项目 [+ 设置指路]）→ 演示段（演示卡 + 工作台五步）
 * → 收尾落回大厅。设置指路步随 canAccessSystemSettings 出现或消失，两种形态都在这里
 * 锁死。
 *
 * 锚点名漂移由类型拦，步骤被顺手删掉只有这里拦 —— 收尾气泡里带着行动按钮与「重看引导」
 * 的去处，中间任何一段落地时都不该把它挤掉。`route` 一并断言，跨页步骤的导航目标写错
 * 也会在这里被抓到，而不必等到跑 `OnboardingTour` 的集成测试才发现。
 */

import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { ROUTE_APP, ROUTE_APP_PROJECTS } from "@/app-routes";
import { ONBOARDING_ANCHORS } from "@/onboarding/anchors";
import { DEMO_PROJECT_NAME, DEMO_SCRIPTED_EPISODE } from "@/onboarding/demo-project";
import { buildTourSteps } from "@/onboarding/steps";

/** 文案在别处测，这里只关心结构，所以把 key 原样返回。 */
const t = ((key: string) => key) as unknown as TFunction<"onboarding">;

const WORKBENCH = `${ROUTE_APP_PROJECTS}/${DEMO_PROJECT_NAME}`;
const EPISODE = `${WORKBENCH}/episodes/${DEMO_SCRIPTED_EPISODE}`;

describe("buildTourSteps", () => {
  it("walks the lobby, the demo workbench, then ends back in the lobby with the create-project action", () => {
    expect(buildTourSteps(t, "admin").map((s) => [s.anchor, s.title, s.route])).toEqual([
      [null, "welcome_title", ROUTE_APP_PROJECTS],
      [ONBOARDING_ANCHORS.lobbyCreateProject, "lobby_create_title", ROUTE_APP_PROJECTS],
      [ONBOARDING_ANCHORS.lobbySettings, "lobby_settings_title", ROUTE_APP_PROJECTS],
      [ONBOARDING_ANCHORS.lobbyDemoCard, "lobby_demo_title", ROUTE_APP],
      [ONBOARDING_ANCHORS.workbenchOverview, "workbench_overview_title", WORKBENCH],
      [ONBOARDING_ANCHORS.workbenchAgent, "workbench_agent_title", WORKBENCH],
      [ONBOARDING_ANCHORS.workbenchLorebook, "workbench_lorebook_title", `${WORKBENCH}/characters`],
      [ONBOARDING_ANCHORS.workbenchTimeline, "workbench_timeline_title", EPISODE],
      [ONBOARDING_ANCHORS.workbenchExport, "workbench_export_title", EPISODE],
      [null, "finish_title", ROUTE_APP_PROJECTS],
    ]);
  });

  it("omits the settings point-out step for member-role users", () => {
    expect(buildTourSteps(t, "member").map((s) => [s.anchor, s.title, s.route])).toEqual([
      [null, "welcome_title", ROUTE_APP_PROJECTS],
      [ONBOARDING_ANCHORS.lobbyCreateProject, "lobby_create_title", ROUTE_APP_PROJECTS],
      [ONBOARDING_ANCHORS.lobbyDemoCard, "lobby_demo_title", ROUTE_APP],
      [ONBOARDING_ANCHORS.workbenchOverview, "workbench_overview_title", WORKBENCH],
      [ONBOARDING_ANCHORS.workbenchAgent, "workbench_agent_title", WORKBENCH],
      [ONBOARDING_ANCHORS.workbenchLorebook, "workbench_lorebook_title", `${WORKBENCH}/characters`],
      [ONBOARDING_ANCHORS.workbenchTimeline, "workbench_timeline_title", EPISODE],
      [ONBOARDING_ANCHORS.workbenchExport, "workbench_export_title", EPISODE],
      [null, "finish_title", ROUTE_APP_PROJECTS],
    ]);
  });

  it("only the finish step declares the create-project action", () => {
    const admin = buildTourSteps(t, "admin");
    expect(admin.filter((s) => s.action === "create-project")).toHaveLength(1);
    expect(admin[admin.length - 1].action).toBe("create-project");
  });

  it("declares the demo card's landing route so the guard can tell 'followed the tour' from 'wandered off'", () => {
    const demoCard = buildTourSteps(t, "admin").find((s) => s.anchor === ONBOARDING_ANCHORS.lobbyDemoCard);

    expect(demoCard?.interactive).toBe(true);
    expect(demoCard?.interactiveTarget).toBe(WORKBENCH);
  });

  it("keeps every tour route lowercase — OnboardingTour compares against a lowercased location", () => {
    for (const step of buildTourSteps(t, "admin")) {
      expect(step.route ?? "").toEqual((step.route ?? "").toLowerCase());
    }
  });
});
