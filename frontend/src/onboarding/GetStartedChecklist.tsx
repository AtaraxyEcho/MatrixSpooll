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
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
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

  const doneCount = tasks.filter((task) => task.done).length;

  return (
    <section className="mx-auto w-full max-w-[980px] px-4 pb-8 sm:px-6" aria-labelledby="get-started-heading">
      {/* 单容器 + 纵向任务行：清单的语义是一份待办，而不是三张等大的功能卡片。容器
          圆角与首页 composer shell / 项目卡一致，宽窄跟随 hero（980px），视觉上是首屏
          的收尾而不是另一块喧宾夺主的展示区。 */}
      <div className="overflow-hidden rounded-[14px] border border-hairline-soft bg-bg-grad-a/45">
        <header className="flex items-center justify-between gap-3 border-b border-hairline-soft px-4 py-3.5 sm:px-5">
          <h2 id="get-started-heading" className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-text">
            {t("checklist_eyebrow")}
          </h2>
          <span className="font-mono text-[11px] tabular-nums text-text-3" aria-label={`${doneCount} / ${tasks.length}`}>
            {doneCount}<span className="text-text-4"> / {tasks.length}</span>
          </span>
        </header>

        <ul className="m-0 list-none p-0">
          {tasks.map((task) =>
            task.done ? (
              <li
                key={task.id}
                className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3.5 text-text-3 last:border-b-0 sm:px-5"
              >
                <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-accent" aria-hidden />
                <span className="flex-1 text-[13px]">{task.label}</span>
              </li>
            ) : (
              <li key={task.id} className="border-b border-hairline-soft last:border-b-0">
                {/* 整行可点：把「去完成」的点击区扩到整行，移动端也好点。动作语义由
                    aria-label（动词短语）承载，可见文案保留任务名。 */}
                <button
                  type="button"
                  onClick={task.onAction}
                  aria-label={task.actionLabel}
                  className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-bg-grad-a/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:px-5"
                >
                  <Circle className="h-[18px] w-[18px] shrink-0 text-text-4 transition-colors group-hover:text-accent" aria-hidden />
                  <span className="flex-1 text-[13px] font-medium text-text-2 transition-colors group-hover:text-text">
                    {task.label}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-text-4 transition-all group-hover:translate-x-0.5 group-hover:text-text-2" aria-hidden />
                </button>
              </li>
            ),
          )}
        </ul>
      </div>
    </section>
  );
}
