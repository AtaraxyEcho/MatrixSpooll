/**
 * 大厅的上手清单 —— 导览之外的第二层引导。
 *
 * 导览（`OnboardingTour`）只负责「认界面」；配置教学、第一次创建这类「照着做」的事
 * 交由这里承接：三项任务全部由前端现有状态推导（配置完整性、是否已有项目、是否看过
 * 导览），不需要后端记录完成度。已完成项打勾置灰，未完成项给出去处的行动按钮；全部
 * 完成整卡消失，不打扰老用户。
 *
 * 引导运行期间不渲染：引导自动弹出时同屏两个引导元素会互相抢注意力，清单还会被引导
 * 的 inert 隔离罩住、点了没反应；引导一结束（`active` 熄灭）清单随即出现——首访用户
 * 此刻通常刚走完导览，「认识界面」一项正好可以打勾。
 */

import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { Check, Circle } from "lucide-react";
import { ROUTE_APP_SETTINGS } from "@/app-routes";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useConfigStatusStore } from "@/stores/config-status-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useProjectsStore } from "@/stores/projects-store";
import { canAccessSystemSettings } from "@/utils/access";

export function GetStartedChecklist() {
  const { t } = useTranslation("onboarding");
  const [, setLocation] = useLocation();
  const tourActive = useOnboardingStore((s) => s.active);
  const tourSeen = useOnboardingStore((s) => s.seen);
  const role = useAuthStore((s) => s.role);
  const configComplete = useConfigStatusStore((s) => s.isComplete);
  const projectCount = useProjectsStore((s) => s.projects.length);
  const requestCreateProject = useAppStore((s) => s.requestCreateProject);

  if (tourActive) return null;

  // 配置项只给得到达设置页的会话；member 没有系统设置权限，这项从清单里整体消失——
  // 标成「已完成」反而是误导（他们没有可完成的事）。
  const canConfigure = canAccessSystemSettings(role);
  const projectDone = projectCount > 0;
  const tourDone = tourSeen === true;

  const tasks = [
    ...(canConfigure
      ? [
          {
            id: "config",
            done: configComplete,
            label: t("checklist_task_config"),
            actionLabel: t("checklist_action_config"),
            onAction: () => setLocation(`~${ROUTE_APP_SETTINGS}`),
          },
        ]
      : []),
    {
      id: "project",
      done: projectDone,
      label: t("checklist_task_project"),
      actionLabel: t("checklist_action_project"),
      onAction: () => requestCreateProject(),
    },
    {
      id: "tour",
      done: tourDone,
      label: t("checklist_task_tour"),
      actionLabel: t("checklist_action_tour"),
      onAction: () => useOnboardingStore.getState().start(),
    },
  ];
  // 全部完成整卡消失——对 member 而言「完成」只看它实际拥有的两项。
  if (tasks.every((task) => task.done)) return null;

  return (
    <section className="mb-7" aria-labelledby="get-started-heading">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2
          id="get-started-heading"
          className="m-0 font-mono text-[12.5px] font-semibold uppercase tracking-[0.06em] text-accent-2"
        >
          {t("checklist_eyebrow")}
        </h2>
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
        {tasks.map((task) => (
          <li
            key={task.id}
            className={
              "flex items-center gap-3 rounded-[12px] border px-4 py-3 " +
              (task.done
                ? "border-hairline-soft bg-bg-grad-a/40 text-text-3"
                : "border-hairline-soft bg-bg-grad-a/70")
            }
          >
            {task.done ? (
              <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-text-4" aria-hidden />
            )}
            <span className={"flex-1 text-[12.5px] " + (task.done ? "line-through decoration-text-4" : "")}>
              {task.label}
            </span>
            {!task.done ? (
              <button
                type="button"
                onClick={task.onAction}
                className="shrink-0 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] text-text-2 transition-colors hover:border-hairline-strong hover:bg-bg-grad-a hover:text-text focus-ring"
              >
                {task.actionLabel}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
