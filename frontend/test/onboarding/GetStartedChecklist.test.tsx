/**
 * 大厅上手清单的行为：三项任务的展示与完成判定、引导运行期间隐藏（避免与自动弹出的
 * 导览抢注意力、且会被 inert 隔离罩住点不动）、全部完成后整卡消失。
 *
 * 完成判定全部来自前端现有状态（config-status / projects / onboarding store），这里只
 * 推状态断言渲染，不发请求。
 */

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useAuthStore } from "@/stores/auth-store";
import { useAppStore } from "@/stores/app-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useProjectsStore } from "@/stores/projects-store";
import type { ProjectSummary } from "@/types";
import { GetStartedChecklist } from "@/onboarding/GetStartedChecklist";

/** 清单只关心列表是否非空，这里给一个能过类型的最小摘要。 */
const ONE_PROJECT: ProjectSummary = {
  name: "p1",
  title: "P1",
  style: "",
  thumbnail: null,
  status: {},
};

/** 供应商缺失的 issue——清单只认 tab === "providers" 的 issue，智能体（agent）不影响。 */
const PROVIDER_ISSUE = { key: "no-video-provider", tab: "providers" as const, label: "video_provider_not_configured" };

function mountChecklist() {
  const { hook, navigate } = memoryLocation({ path: "/app" });
  render(
    <Router hook={hook}>
      <GetStartedChecklist />
    </Router>,
  );
  return navigate;
}

describe("GetStartedChecklist", () => {
  beforeEach(() => {
    useOnboardingStore.setState(useOnboardingStore.getInitialState(), true);
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useConfigStatusStore.setState(useConfigStatusStore.getInitialState(), true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("lists the three tasks for a fresh admin session", () => {
    useConfigStatusStore.setState({ issues: [PROVIDER_ISSUE] });
    useOnboardingStore.setState({ seen: false });
    useProjectsStore.setState({ projects: [] });

    mountChecklist();

    expect(screen.getByText("配置生成供应商")).toBeInTheDocument();
    expect(screen.getByText("创建你的第一个项目")).toBeInTheDocument();
    expect(screen.getByText("认识界面（查看引导）")).toBeInTheDocument();
  });

  it("marks each task done as its condition flips", () => {
    useConfigStatusStore.setState({ issues: [] });
    useProjectsStore.setState({ projects: [ONE_PROJECT] });
    useOnboardingStore.setState({ seen: true });

    mountChecklist();

    // 三项全勾——整卡消失，不给老用户常驻占位。
    expect(screen.queryByText("配置生成供应商")).toBeNull();
  });

  it("hides while the tour is running and reappears after it exits", async () => {
    useConfigStatusStore.setState({ issues: [PROVIDER_ISSUE] });
    useOnboardingStore.setState({ seen: false });
    useProjectsStore.setState({ projects: [] });

    act(() => useOnboardingStore.setState({ active: true }));
    const duringTour = render(
      <Router hook={memoryLocation({ path: "/app" }).hook}>
        <GetStartedChecklist />
      </Router>,
    );
    expect(duringTour.container.textContent).toBe("");

    await act(async () => {
      useOnboardingStore.setState({ active: false });
    });
    expect(duringTour.container.textContent).toContain("配置生成供应商");
    duringTour.unmount();
  });

  it("omits the config task for member-role users", () => {
    useAuthStore.setState({ role: "member" });
    useConfigStatusStore.setState({ issues: [PROVIDER_ISSUE] });
    useOnboardingStore.setState({ seen: false });
    useProjectsStore.setState({ projects: [] });

    mountChecklist();

    // member 进不去系统设置，配置任务从清单整体消失，不打勾也不留「去配置」按钮。
    expect(screen.queryByText("配置生成供应商")).toBeNull();
    expect(screen.queryByRole("button", { name: "去配置" })).toBeNull();
    expect(screen.getByText("创建你的第一个项目")).toBeInTheDocument();
  });

  it("requests the create-project modal when its action button is clicked", () => {
    useAuthStore.setState({ role: "member" });
    useConfigStatusStore.setState({ issues: [] });
    useOnboardingStore.setState({ seen: true });
    useProjectsStore.setState({ projects: [] });

    mountChecklist();
    const before = useAppStore.getState().createProjectRequest;

    screen.getByRole("button", { name: "新建项目" }).click();

    expect(useAppStore.getState().createProjectRequest).toBe(before + 1);
  });
});
