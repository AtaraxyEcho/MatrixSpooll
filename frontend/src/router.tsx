// router.tsx — Route definitions for the studio layout

import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Switch, Redirect, useLocation, useParams } from "wouter";
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { FreeCreationLayout, StudioLayout } from "@/components/layout";
import { FreeCreationWorkspace } from "@/components/canvas/FreeCreationWorkspace";
import { StudioCanvasRouter } from "@/components/canvas/StudioCanvasRouter";
import { ProjectsPage } from "@/components/pages/ProjectsPage";
import { SystemConfigPage } from "@/components/pages/SystemConfigPage";
import { ProjectSettingsPage } from "@/components/pages/ProjectSettingsPage";
import { AssetLibraryPage } from "@/components/pages/AssetLibraryPage";
import { LoginPage } from "@/pages/LoginPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { ToastOverlay } from "@/components/layout/ToastOverlay";
import { OnboardingTour } from "@/onboarding/OnboardingTour";
import {
  buildDemoProjectData,
  buildDemoScripts,
  DEMO_PROJECT_NAME,
  isDemoProject,
} from "@/onboarding/demo-project";
import { setApiReadOnly } from "@/api";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useAssistantStore } from "@/stores/assistant-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { errMsg } from "@/utils/async";
import { lookupProjectVideoResolution } from "@/utils/provider-models";
import {
  ROUTE_APP,
  ROUTE_APP_ASSETS,
  ROUTE_APP_PROJECTS,
  ROUTE_APP_SETTINGS,
  WORKSPACE_ROUTE_SETTINGS,
} from "@/app-routes";

// ---------------------------------------------------------------------------
// ConfigStatusLoader — 登录后集中拉取一次配置完整性状态
// ---------------------------------------------------------------------------

/**
 * 配置完整性（红点 / 必需设置提醒）的单点加载器，始终挂载在路由根，跨页面导航存活。
 * 单例 store 一次初始化即覆盖所有落地页（首页 / 设置 / 项目），不再依赖某个具体页面
 * 是否在 mount 时拉取。首次失败（如后端尚未就绪）时带界次数退避重试，无需手动刷新页面。
 */
function ConfigStatusLoader() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await useConfigStatusStore.getState().fetch();
      if (cancelled) return;
      if (!useConfigStatusStore.getState().initialized && attempts < 5) {
        attempts += 1;
        timer = setTimeout(() => void tick(), 800 * attempts);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isAuthenticated]);

  return null;
}

// ---------------------------------------------------------------------------
// AuthGuard — redirects to /login when not authenticated
// ---------------------------------------------------------------------------

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore();
  const { t } = useTranslation("common");

  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-screen items-center justify-center gap-2 bg-bg text-[13px] text-text-4"
      >
        <Loader2 aria-hidden className="h-4 w-4 motion-safe:animate-spin" />
        <span>{t("loading")}</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    // 用 `~` 前缀跳到顶层 /login：AuthGuard 可能渲染在 nest 嵌套路由内
    // （/app/projects/:projectName），此时相对路径会被拼到嵌套 base 之后，
    // 必须用绝对路径才能落到真正的 /login。
    // 带上完整原始 URL（取 window.location，nest 内 useLocation 只是相对路径），
    // 登录成功后据此回跳。
    const from = window.location.pathname + window.location.search + window.location.hash;
    return <Redirect to={`~/login?from=${encodeURIComponent(from)}`} />;
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// StudioWorkspace — loads project data and renders three-column layout
// ---------------------------------------------------------------------------

function StudioWorkspace() {
  const params = useParams<{ projectName: string }>();
  const projectName = params.projectName ?? null;
  const [, navigate] = useLocation();
  const handoffMode = (() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    if (mode === "agent" || mode === "image" || mode === "video") return mode;
    const legacyOutput = params.get("output");
    return legacyOutput === "image" || legacyOutput === "video" ? legacyOutput : undefined;
  })();
  const {
    currentProjectName,
    currentProjectData,
    projectDetailLoading,
    setCurrentProject,
    setProjectDetailLoading,
  } = useProjectsStore();
  const { t } = useTranslation(["onboarding", "dashboard", "common"]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 把 t 通过 ref 暴露给首屏加载的 onError 回调，避免切语言触发 t 重建 → effect
  // 依赖跟着重建 → 真实项目整条加载重跑（下方 effect 依赖里刻意不含 t，理由见下）。
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const loadProject = useCallback(() => {
    if (!projectName || isDemoProject(projectName)) return;
    setProjectDetailLoading(true);
    void useProjectsStore
      .getState()
      .refreshProject(projectName, {
        onError: (err) => {
          const message = errMsg(err);
          setLoadError(message);
          useAppStore.getState().pushToast(
            tRef.current("dashboard:project_load_failed", { message }),
            "error",
          );
        },
      })
      .then((result) => {
        // "cancelled" 代表本轮未同步（项目已被切走、取消域已轮换），loading 状态交由
        // 接管的新一轮自行结算，此处不动共享状态。
        if (result === "cancelled") return;
        setProjectDetailLoading(false);
      });
  }, [projectName, setProjectDetailLoading]);

  // 项目生命周期：清空上一个项目的 assistant 状态，再按项目类型取数据。
  // 依赖里不含 `t`，切换语言不应重跑真实项目加载或清空助手会话。
  useEffect(() => {
    if (!projectName) return;

    const assistantState = useAssistantStore.getState();
    assistantState.setSessions([]);
    assistantState.setCurrentSessionId(null);
    assistantState.resetTimeline();
    assistantState.setSessionStatus(null);
    assistantState.setIsDraftSession(false);

    if (isDemoProject(projectName)) {
      setApiReadOnly(true);
      setProjectDetailLoading(false);
      return () => {
        setApiReadOnly(false);
        setCurrentProject(null, null);
      };
    }

    setApiReadOnly(false);
    // refreshProject 只接受当前项目的响应，因此先写入项目身份并清空旧详情。
    setCurrentProject(projectName, null);
    loadProject();

    return () => {
      setCurrentProject(null, null);
    };
  }, [loadProject, projectName, setCurrentProject, setProjectDetailLoading]);

  const workspaceLoading =
    !projectName ||
    currentProjectName !== projectName ||
    projectDetailLoading;

  // 演示数据随界面语言走：`t` 换身份时重灌一遍常量，只影响演示项目
  useEffect(() => {
    if (!projectName || !isDemoProject(projectName)) return;
    setCurrentProject(projectName, buildDemoProjectData(t), buildDemoScripts(t));
  }, [projectName, setCurrentProject, t]);

  if (workspaceLoading) {
    return (
      <div className="flex h-screen flex-col bg-[var(--color-background)] text-[var(--color-text)]" data-testid="project-workspace-loading">
        <div className="h-14 border-b border-[var(--color-hairline)] bg-[var(--color-surface)]" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 motion-safe:animate-spin text-[var(--color-text-muted)]" aria-label={t("common:loading")} />
        </div>
      </div>
    );
  }

  if (!currentProjectData) {
    return (
      <div className="flex h-screen flex-col bg-[var(--color-background)] text-[var(--color-text)]" data-testid="project-workspace-error">
        <div className="h-14 border-b border-[var(--color-hairline)] bg-[var(--color-surface)]" />
        <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-12">
          <section className="w-full max-w-md text-center" role="alert">
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-lg bg-[oklch(0.62_0.18_25_/_0.12)] text-[var(--color-danger)]">
              <AlertCircle className="h-5 w-5" aria-hidden />
            </div>
            <h1 className="mt-4 text-base font-semibold">{t("dashboard:project_open_failed")}</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--color-text-2)]">
              {t("dashboard:project_load_failed", { message: loadError ?? t("dashboard:project_load_unknown") })}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => navigate("~/app/projects")}
                className="focus-ring inline-flex h-9 items-center gap-2 rounded-md border border-[var(--color-hairline-strong)] px-3 text-xs font-medium text-[var(--color-text-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                {t("dashboard:all_projects")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setLoadError(null);
                  loadProject();
                }}
                className="focus-ring inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-3 text-xs font-semibold text-[oklch(0.12_0_0)] hover:bg-[var(--color-accent-2)]"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                {t("common:retry")}
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  if (currentProjectData.content_mode === "free" && projectName) {
    const projectAspectRatio = typeof currentProjectData.aspect_ratio === "string"
      ? currentProjectData.aspect_ratio
      : currentProjectData.aspect_ratio?.video ?? currentProjectData.aspect_ratio?.storyboard;
    const projectResolution = lookupProjectVideoResolution(
      currentProjectData,
      currentProjectData.video_backend ?? "",
    );
    return (
      <FreeCreationLayout key={`free-${projectName}`}>
        <FreeCreationWorkspace
          projectName={projectName}
          readOnly={isDemoProject(projectName)}
          initialMode={handoffMode}
          initialAspectRatio={projectAspectRatio}
          initialResolution={projectResolution ?? undefined}
        />
      </FreeCreationLayout>
    );
  }

  return (
    <StudioLayout key={`studio-${projectName}`}>
      <StudioCanvasRouter />
    </StudioLayout>
  );
}

// ---------------------------------------------------------------------------
// Top-level route tree
// ---------------------------------------------------------------------------

export function AppRoutes() {
  return (
    <>
      <ConfigStatusLoader />
      <OnboardingTour />
      <Switch>
        {/* Login page */}
        <Route path="/login" component={LoginPage} />

        {/* Root redirects to projects list */}
        <Route path="/">
          <Redirect to={ROUTE_APP} />
        </Route>

        {/* /app is the authenticated home surface. */}
        <Route path={ROUTE_APP}>
          <AuthGuard>
            <ProjectsPage mode="home" />
          </AuthGuard>
        </Route>

        {/* Full project list */}
        <Route path={ROUTE_APP_PROJECTS}>
          <AuthGuard>
            <ProjectsPage mode="list" />
          </AuthGuard>
        </Route>

        {/* System settings */}
        <Route path={ROUTE_APP_SETTINGS}>
          <AuthGuard>
            <SystemConfigPage />
          </AuthGuard>
        </Route>

        {/* Asset library */}
        <Route path={ROUTE_APP_ASSETS}>
          <AuthGuard>
            <AssetLibraryPage />
          </AuthGuard>
        </Route>

        {/* 演示项目没有可用的项目级设置（后端不存在该项目）——地址栏直达、书签或外部链接
            都可能绕开 GlobalHeader 里已做的重定向，这里在路由层再挡一次，指向全局设置。
            必须排在下面通用的项目设置路由之前，wouter 按声明顺序匹配。 */}
        <Route path={`${ROUTE_APP_PROJECTS}/${DEMO_PROJECT_NAME}/${WORKSPACE_ROUTE_SETTINGS}`}>
          <Redirect to={ROUTE_APP_SETTINGS} />
        </Route>

        {/* Project settings — full-screen, must be before the nested workspace route */}
        <Route path={`${ROUTE_APP_PROJECTS}/:projectName/${WORKSPACE_ROUTE_SETTINGS}`}>
          <AuthGuard>
            <ProjectSettingsPage />
          </AuthGuard>
        </Route>

        {/* Studio workspace (three-column layout) */}
        <Route path={`${ROUTE_APP_PROJECTS}/:projectName`} nest>
          <AuthGuard>
            <StudioWorkspace />
          </AuthGuard>
        </Route>

        {/* 404 */}
        <Route>
          <NotFoundPage />
        </Route>
      </Switch>
      <ToastOverlay />
    </>
  );
}
