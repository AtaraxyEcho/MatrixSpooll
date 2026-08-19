import { useLocation } from "wouter";
import { useProjectEventsSSE } from "@/hooks/useProjectEventsSSE";
import { useTaskRefresh } from "@/hooks/useTaskRefresh";
import { useProjectsStore } from "@/stores/projects-store";
import { useDemoWorkbench } from "@/onboarding/use-demo-workbench";
import { isDemoProject } from "@/onboarding/demo-project";
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
  const [, setLocation] = useLocation();
  const projectName = useProjectsStore((state) => state.currentProjectName);
  const demoMode = useDemoWorkbench();

  const isEffectivelyDemo = demoMode || isDemoProject(projectName);
  const sseProjectName = isEffectivelyDemo ? null : projectName;
  useTaskRefresh(sseProjectName, !isEffectivelyDemo);
  useProjectEventsSSE(sseProjectName);

  return (
    <div className="flex h-screen flex-col" style={{ color: "var(--color-text)" }}>
      <TaskFailureListener projectName={sseProjectName} />
      <ScriptGenerationNoticeListener />
      <GlobalHeader variant="free" onNavigateBack={() => setLocation("~/app/projects")} />
      {demoMode ? <DemoReadOnlyBanner /> : null}
      <MigrationRepairBanner />
      <main className="relative min-h-0 flex-1 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
