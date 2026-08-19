import { useEffect, useRef } from "react";
import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { AgentCopilot } from "@/components/copilot/AgentCopilot";
import { useProjectEventsSSE } from "@/hooks/useProjectEventsSSE";
import { useTaskRefresh } from "@/hooks/useTaskRefresh";
import { useProjectsStore } from "@/stores/projects-store";
import { useAppStore } from "@/stores/app-store";
import { useDemoWorkbench } from "@/onboarding/use-demo-workbench";
import { isDemoProject } from "@/onboarding/demo-project";
import { UI_LAYERS } from "@/utils/ui-layers";
import { GlobalHeader } from "./GlobalHeader";
import { MigrationRepairBanner } from "./MigrationRepairBanner";
import { ScriptGenerationNoticeListener } from "./ScriptGenerationNoticeListener";
import { TaskFailureListener } from "./TaskFailureListener";
import { DemoReadOnlyBanner } from "@/onboarding/DemoReadOnlyBanner";

interface FreeCreationLayoutProps {
  children: React.ReactNode;
}

/**
 * Free creation owns a canvas-first shell. It deliberately does not mount the
 * workflow sidebar or the persistent copilot column used by drama/narration/ad.
 */
export function FreeCreationLayout({ children }: FreeCreationLayoutProps) {
  const { t } = useTranslation("dashboard");
  const [, setLocation] = useLocation();
  const projectName = useProjectsStore((state) => state.currentProjectName);
  const demoMode = useDemoWorkbench();
  const assistantOpen = useAppStore((state) => state.assistantPanelOpen);
  const toggleAssistantPanel = useAppStore((state) => state.toggleAssistantPanel);
  const setAssistantPanelOpen = useAppStore((state) => state.setAssistantPanelOpen);
  const previousAssistantOpenRef = useRef(useAppStore.getState().assistantPanelOpen);

  const isEffectivelyDemo = demoMode || isDemoProject(projectName);
  const sseProjectName = isEffectivelyDemo ? null : projectName;
  useTaskRefresh(sseProjectName, !isEffectivelyDemo);
  useProjectEventsSSE(sseProjectName);

  useEffect(() => {
    const previousAssistantOpen = previousAssistantOpenRef.current;
    setAssistantPanelOpen(false);
    return () => setAssistantPanelOpen(previousAssistantOpen);
  }, [setAssistantPanelOpen]);

  return (
    <div className="flex h-screen flex-col" style={{ color: "var(--color-text)" }}>
      <TaskFailureListener projectName={sseProjectName} />
      <ScriptGenerationNoticeListener />
      <GlobalHeader onNavigateBack={() => setLocation("~/app/projects")} />
      {demoMode ? <DemoReadOnlyBanner /> : null}
      <MigrationRepairBanner />
      <main
        className={`relative min-h-0 flex-1 overflow-hidden transition-[margin] duration-200 ${
          assistantOpen ? "lg:mr-[406px]" : "lg:mr-0"
        }`}
      >
        {children}
      </main>

      <button
        type="button"
        onClick={toggleAssistantPanel}
        className={`fixed right-4 top-28 grid h-10 w-10 place-items-center rounded-xl transition-all ${UI_LAYERS.workspaceFloating} ${
          assistantOpen ? "pointer-events-none scale-0 opacity-0" : "scale-100 opacity-100"
        }`}
        style={{
          background: "linear-gradient(135deg, var(--color-accent), oklch(0.60 0.10 280))",
          color: "oklch(0.12 0 0)",
          boxShadow: "0 0 0 1px oklch(1 0 0 / 0.1), 0 6px 20px -6px var(--color-accent-glow)",
        }}
        title={t("open_assistant_panel")}
        aria-label={t("open_assistant_panel")}
        tabIndex={assistantOpen ? -1 : 0}
      >
        <Bot className="h-5 w-5" aria-hidden="true" />
      </button>

      <div
        className={`fixed bottom-4 right-4 top-14 z-40 w-[min(390px,calc(100vw-2rem))] overflow-hidden border border-[var(--color-hairline)] bg-[var(--color-surface)] shadow-2xl transition-[opacity,transform] duration-200 ${
          assistantOpen ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-6 opacity-0"
        }`}
        aria-hidden={!assistantOpen}
        inert={!assistantOpen}
      >
        <AgentCopilot />
      </div>
    </div>
  );
}
