import { useId } from "react";
import { Users, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProjectRef, ProjectSummary } from "@/types";
import { getProjectDisplayName } from "@/utils/project-display";
import { GlassModal } from "@/components/ui/GlassModal";
import { ProjectMembersSection } from "./ProjectMembersSection";

interface ProjectMembersDialogProps {
  project: ProjectSummary | null;
  onClose: () => void;
}

export function ProjectMembersDialog({ project, onClose }: ProjectMembersDialogProps) {
  const { t } = useTranslation(["dashboard", "common"]);
  const titleId = useId();
  const descriptionId = useId();

  if (!project) return null;

  const projectId = project.project_id ?? project.id;
  const projectRef: ProjectRef = projectId
    ? { project_id: projectId, name: project.name, current_role: project.current_role }
    : project.name;
  const projectDisplayName = getProjectDisplayName(
    project.title,
    t("dashboard:untitled_project"),
  );

  return (
    <GlassModal
      open
      onClose={onClose}
      labelledBy={titleId}
      describedBy={descriptionId}
      widthClassName="w-fit min-w-[min(38rem,calc(100vw-2rem))] max-w-[min(56rem,calc(100vw-2rem))]"
      panelClassName="flex max-h-[min(47.5rem,calc(100dvh-3rem))] flex-col"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-hairline-soft px-5 py-4">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-dim text-accent-2">
          <Users className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[15px] font-semibold text-text">
            {t("dashboard:project_members_title")}
          </h2>
          <p id={descriptionId} className="mt-0.5 truncate text-[12px] text-text-3">
            {projectDisplayName}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common:close")}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-bg-grad-a hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ProjectMembersSection project={projectRef} currentRole={project.current_role} />
      </div>
    </GlassModal>
  );
}
