import { useEffect, useRef } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import type { TFunction } from "i18next";
import type { ProjectSummary } from "@/types";
import { ProjectCard } from "./ProjectCard";

interface HomeProjectRailProps {
  projects: ProjectSummary[];
  styleLabels: Record<string, string>;
  onDelete: (project: ProjectSummary) => void;
  onOpenMembers: (project: ProjectSummary) => void;
  onCreate: () => void;
}

function NewProjectRailCard({ onClick, t }: { onClick: () => void; t: TFunction }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[300px] w-[300px] shrink-0 flex-col items-center justify-center gap-3 rounded-[12px] border border-dashed border-hairline-strong bg-bg-grad-a/45 text-center transition-colors hover:border-accent/55 hover:bg-bg-grad-a/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="grid h-11 w-11 place-items-center rounded-[10px] border border-accent/35 bg-accent-dim text-accent-2">
        <Plus className="h-5 w-5" aria-hidden />
      </span>
      <span className="text-[13px] font-semibold text-text-2">{t("lobby_new_project_title")}</span>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">{t("home_new_project_hint")}</span>
    </button>
  );
}

export function HomeProjectRail({ projects, styleLabels, onDelete, onOpenMembers, onCreate }: HomeProjectRailProps) {
  const { t } = useTranslation("dashboard");
  const railRef = useRef<HTMLDivElement>(null);

  // 悬停期间完全接管滚轮：把滚动手势转译为横向 scrollLeft，同时始终
  // preventDefault——禁止最外层页面滚动，内部滚到左右边界后也不会链式
  // 触发外层滚动；鼠标移出该区域后监听失效，页面滚动自动恢复。
  // 必须用原生非 passive 监听（React 的 onWheel 在根节点是 passive，preventDefault 无效）。
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <section className="mx-auto w-full max-w-[1320px] px-4 pb-16 sm:px-6" aria-labelledby="home-projects-heading">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <div className="mb-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-accent-2">{t("home_projects_eyebrow")}</div>
          <h2 id="home-projects-heading" className="m-0 text-[28px] font-semibold leading-tight tracking-[-0.025em] text-text sm:text-[30px]">{t("home_projects_title")}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden font-mono text-[11px] tabular-nums text-text-3 sm:inline">
            {t("home_projects_count", { count: projects.length })}
          </span>
          <Link
            href="/app/projects"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-[8px] border border-hairline-soft px-3 text-[12px] font-semibold text-text-2 transition-colors hover:border-accent/55 hover:bg-accent-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("home_projects_view_all")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      </div>
      <div ref={railRef} className="home-project-rail flex gap-4 overflow-x-auto overscroll-x-contain pb-3 pr-3">
        {projects.length === 0 ? (
          <div className="flex min-h-[300px] w-[300px] shrink-0 flex-col justify-center rounded-[12px] border border-dashed border-hairline bg-bg-grad-a/35 px-5 text-center">
            <p className="m-0 text-[14px] text-text-2">{t("home_projects_empty")}</p>
            <p className="mt-2 text-[12px] text-text-3">{t("home_projects_empty_hint")}</p>
          </div>
        ) : projects.map((project) => (
          <div key={project.name} className="w-[300px] shrink-0">
            <ProjectCard
              project={project}
              styleLabel={styleLabels[project.name] ?? t("style_not_set")}
              onDelete={() => onDelete(project)}
              onOpenMembers={() => onOpenMembers(project)}
            />
          </div>
        ))}
        <NewProjectRailCard onClick={onCreate} t={t} />
      </div>
    </section>
  );
}
