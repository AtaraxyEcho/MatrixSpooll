/**
 * 引导挂载点 —— 挂在路由根，跨页面导航存活，自身不渲染任何 DOM（气泡与遮罩由
 * driver.js 挂到 body 上）。
 *
 * 职责按效果划分，导航只有一个出口（效果 3）：
 * 1. 进入主界面后查一次「是否已看过」（auth 开启 = 登录成功后；匿名 = auth status 放行
 *    后，两种情形都由 `isAuthenticated` 统一表达）。登录页不掺和。
 * 2. 未看过则自动开一次。
 * 3. 路由裁决：比较当前路由与当前步骤声明的落点，三选一——
 *    a. 用户顺着 `interactive` 步的入口走进了落点 → 顺势把步号推进到下一步（与点
 *       「下一步」殊途同归，引导不挂起等待）；
 *    b. 不在落点上 → 先导航过去（replace），锚点与内容区才能就位；
 *    c. 纠偏导航反复发出去却始终「落不住」（步骤不可达：目标路由被守卫拦回、页面
 *       被移除等）→ 警告后越过这一步继续讲。拽着用户死循环，只会让他们面对一个与
 *       页面对不上号的气泡。
 *
 *    c 的判定是振荡计数而非简单的「到没到过」：守卫弹回也是一次完整的落地，落点
 *    会短暂出现在历史里，若「看到落点即销账」，账本会在每轮振荡中被清零，检测永不
 *    触发。这里只在落点「持续停留」超过 NAV_SETTLED_MS 才销账；每轮被弹离都让
 *    计数 +1，超过上限或总时长超限即判不可达。
 * 4. store 里 active 为真、且当前路由是引导覆盖的路由之一时驱动 driver.js —— 自动
 *    首弹与「重看引导」共用这条路径，组件本身不区分二者。
 *
 * 步骤大纲跨大厅与演示工作台（项目概览 / 角色集 / 剧集分镜三条路由）。driver.js
 * 实例挂在 `document.body` 上、在 React 树之外，只要第 3 点里的路由判定在这些页面之间
 * 保持同一个真值，实例就不会被效果 4 拆重建——「下一步」跨页时靠 `tour.ts` 的
 * `onStepChange` 在 driver 真正切换高亮之前把即将停靠的步号同步上报，本组件据此提前
 * 导航，驱动效果本身不重启。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { APP_PROJECT_WORKSPACE_PATTERN, APP_TOP_LEVEL_ROUTES } from "@/app-routes";
import { buildTourSteps } from "./steps";
import { startTour, type TourHandle, type TourLabels } from "./tour";

/**
 * 不可达判定的三个参数，量级彼此对齐：
 * - NAV_SETTLED_MS：在落点上持续停留多久才算「真到了」，销掉账本。要短于用户正常
 *   阅读一步的节奏，否则账本常驻；又要长于守卫弹回的瞬间，振荡轮次里的短暂路过
 *   不能销账。
 * - MAX_NAV_ATTEMPTS：为同一步发出的纠偏导航次数上限。真实弹回振荡一轮只要几十到
 *   几百毫秒，6 次在一两秒内就会到达；正常使用里一步只有一次纠偏，永远够不着。
 * - UNREACHABLE_STEP_MS：同上，但按时长兜底——振荡很慢（每轮数秒）的场景靠它收口。
 */
const NAV_SETTLED_MS = 1000;
const MAX_NAV_ATTEMPTS = 6;
const UNREACHABLE_STEP_MS = 3000;

/** 一次连续的不可达观察：为哪个步记账、累计了几轮、何时首次/最近落点可见。 */
interface NavAttempt {
  step: number;
  firstAt: number;
  attempts: number;
  /** 最近一次看到落点的时刻；离开落点即作废。null = 尚未（重新）看到。 */
  satisfiedAt: number | null;
}

export function OnboardingTour() {
  const { t } = useTranslation("onboarding");
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const role = useAuthStore((s) => s.role);
  const [location, navigate] = useLocation();
  const seen = useOnboardingStore((s) => s.seen);
  const active = useOnboardingStore((s) => s.active);

  // 只在已知应用路由内生效——未匹配路由（404）与 /login 一样不掺和，否则引导会
  // 在错链接 / 旧书签落地的 404 页自动弹出，且关闭时把全局 seen 标记写成已看过。
  // /app/settings、/app/assets 是无子路由的单页，前缀匹配会把 /app/settings/unknown
  // 这类 404 误判为主界面；/app/projects/:projectName 下 StudioCanvasRouter 的内层
  // <Switch> 同样没有兜底路由，未注册的子路径按 APP_PROJECT_WORKSPACE_PATTERN 精确匹配。
  // wouter 底层 regexparam 大小写不敏感、且非 loose 模式下末尾斜杠可选（pattern 以
  // `\/?$` 收尾），这里统一转小写、去掉末尾斜杠后再比对，避免大小写变体或带尾斜杠的
  // 合法路径（wouter 能正常渲染）被本判断误判为不在主界面内。
  const normalizedLocation = location.toLowerCase().replace(/(.)\/$/, "$1");
  const inMainUi =
    isAuthenticated &&
    (normalizedLocation === "/" ||
      (APP_TOP_LEVEL_ROUTES as readonly string[]).includes(normalizedLocation) ||
      APP_PROJECT_WORKSPACE_PATTERN.test(normalizedLocation));

  // 步骤大纲只随界面语言与全局角色重建：设置段的取舍由 canAccessSystemSettings
  // （与 SystemSettingsGuard 同源）决定，见 steps.ts。渲染期与两个效果共用同一份。
  const steps = useMemo(() => buildTourSteps(t, role), [t, role]);
  // 引导覆盖的路由集合，从大纲自身派生而非另写一份常量——后续段落在新页面加步骤时
  // 只需给那一步写 `route`，这里自动跟上，不存在「忘了同步」的维护缺口。
  const tourRoutes = useMemo(
    () => new Set(steps.map((s) => s.route).filter((route): route is string => Boolean(route))),
    [steps],
  );

  // 停在第几步（0 基）。用 ref 给驱动效果与跳步读取即时值又不把它列进依赖（步骤切换
  // 不该重启驱动效果），state 给下面的路由裁决效果做响应式依赖。两者总是同步写入。
  const stepIndexRef = useRef(0);
  const [stepIndex, setStepIndex] = useState(0);
  const setStep = (index: number) => {
    stepIndexRef.current = index;
    setStepIndex(index);
  };

  // driver 实例句柄。路由裁决效果在判定不可达时要越过当前步，需要让 driver 一起跳
  // ——只推进 React 侧步号，高亮和气泡会停在被跳过的那步上。
  const handleRef = useRef<TourHandle | null>(null);
  const navAttemptRef = useRef<NavAttempt | null>(null);

  // 当前所在路由是否是引导覆盖的路由之一——驱动效果（4）以此为准，而不是逐步比对，
  // 这样跨页步骤切换不会拆重建 driver 实例。
  const onTourRoute = tourRoutes.has(normalizedLocation);
  const requiredRoute = steps[stepIndex]?.route ?? null;

  // `interactive` 步是路由裁决的例外：该步的落点动作本身就是导航离开 requiredRoute
  // （点演示卡进演示工作台），不是效果 4 触发的跨页步骤切换，此时不该把用户拽回来。
  //
  // 豁免只认这一步自己声明的落点 `interactiveTarget`（含其子路由），不是「凡是离开
  // requiredRoute 都算」。落点之外的去处一律拽回，无论它在不在引导覆盖范围内：跳到
  // 另一条引导路由（如顶栏「设置」）要拽回，跳到引导之外的主界面路由（如资产库）同样
  // 要拽回——否则 driver 停在演示卡那一步却找不到锚点，降级成与页面内容不符的居中
  // 气泡。这也让 `interactive` 步与普通步在「跑到无关页面」时表现一致，差别只在它多
  // 认一个自己声明的落点。不能改判「落点在引导覆盖范围之外」——演示工作台的路由已随
  // 演示段进了 `tourRoutes`，那个条件会让用户刚点进工作台就被弹回大厅。
  const currentStep = steps[stepIndex];
  const interactiveTarget = currentStep?.interactive ? currentStep.interactiveTarget : undefined;
  const enteredInteractiveTarget =
    interactiveTarget !== undefined &&
    (normalizedLocation === interactiveTarget || normalizedLocation.startsWith(`${interactiveTarget}/`));

  // 3. 路由裁决（唯一的导航出口，见文件头 a/b/c 三条出路）。
  useEffect(() => {
    if (!active || !inMainUi) return;

    // a. 顺着 interactive 落点走进来了：推进步号，效果 4 随即在新步号上重建实例，
    //    外观上就是顺势接着讲。导航是用户点出来的，这里只跟进步号、不再发导航。
    if (enteredInteractiveTarget) {
      navAttemptRef.current = null;
      const next = stepIndexRef.current + 1;
      if (next < steps.length) setStep(next);
      return;
    }

    if (!requiredRoute) return;
    if (normalizedLocation === requiredRoute) {
      // 落点可见不清账——守卫弹回也是一次完整落地，落点会在振荡的每一轮里短暂出现。
      // 只有「持续停留」才证明真的到了：停留时间从首次看到落点起算，被弹离即作废。
      const attempt = navAttemptRef.current;
      if (!attempt) return;
      if (attempt.satisfiedAt === null) attempt.satisfiedAt = Date.now();
      if (Date.now() - attempt.satisfiedAt > NAV_SETTLED_MS) navAttemptRef.current = null;
      return;
    }

    // c. 不可达检测：同一步的纠偏导航反复发出、每轮都被弹离落点（计数超限或总时长
    //    超限），判定该步不可达并越过。账本按步号记账——步号一换（用户手动前后步进）
    //    即重新计数。
    const attempt = navAttemptRef.current;
    const now = Date.now();
    if (
      attempt
      && attempt.step === stepIndexRef.current
      && (attempt.attempts >= MAX_NAV_ATTEMPTS || now - attempt.firstAt > UNREACHABLE_STEP_MS)
    ) {
      navAttemptRef.current = null;
      const next = stepIndexRef.current + 1;
      console.warn(
        `[onboarding] step ${stepIndexRef.current} target "${requiredRoute}" unreachable; skipping`,
      );
      if (next >= steps.length) {
        useOnboardingStore.getState().exit();
        return;
      }
      setStep(next);
      handleRef.current?.moveTo(next);
      return;
    }
    if (!attempt || attempt.step !== stepIndexRef.current) {
      navAttemptRef.current = { step: stepIndexRef.current, firstAt: now, attempts: 1, satisfiedAt: null };
    } else {
      attempt.attempts += 1;
      attempt.satisfiedAt = null;
    }

    // b. 不在落点上：纠偏导航。走 replace——这是引导自己的纠偏跳转，不是用户点出来的
    //    去处，push 的话历史里会堆满引导的中间态，用户按浏览器后退得连按多次才退得
    //    出去。用户主动产生的导航（点演示卡进工作台）不经这里，仍是正常的 push。
    navigate(requiredRoute, { replace: true });
  }, [
    active,
    inMainUi,
    requiredRoute,
    normalizedLocation,
    navigate,
    enteredInteractiveTarget,
    steps,
  ]);

  // 1. 查询「是否已看过」
  useEffect(() => {
    if (!inMainUi) return;
    const controller = new AbortController();
    void useOnboardingStore.getState().loadStatus({ signal: controller.signal });
    return () => controller.abort();
  }, [inMainUi]);

  // 2. 未看过 → 自动开一次（退出时 seen 置真，不会再开）
  useEffect(() => {
    if (!inMainUi || seen !== false) return;
    useOnboardingStore.getState().start();
  }, [inMainUi, seen]);

  // 4. 驱动 driver.js
  //
  // 文案是构造时一次性交给 driver 的，切换界面语言（`t` 换身份）必须重建一遍才能生效。
  // 重建走 `dispose()` —— 不记退出 —— 并把停留的步号带过去，讲到第几步就还在第几步。
  useEffect(() => {
    // 离开引导覆盖的路由（如运行期间浏览器后退回登录页）时收起正在运行的引导——不算
    // 一次退出（不记 seen），保留步号，回到引导覆盖的路由后从原位继续。用户在
    // `interactive` 步顺着入口走进落点的那一帧同样先收起旧实例：路由裁决效果随即把
    // 步号推进到下一步，本效果在新步号上重建实例。
    if (!active || !onTourRoute || enteredInteractiveTarget) {
      handleRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 引导退出时把步号复位到起点，是有意的受控重置，下次开启从头开始
      if (!active) setStep(0);
      return;
    }
    const labels: TourLabels = {
      next: t("next"),
      prev: t("prev"),
      done: t("done"),
      skip: t("skip"),
      close: t("close"),
      actions: { "create-project": t("finish_action") },
      progress: (current, total) => t("progress", { current, total }),
    };
    const handle = startTour(steps, labels, {
      // 中途退出（跳过 / 关闭 / Esc）不等于走完——补一句去处的提示，避免想看的用户
      // 以为关了就永远没了；正常走完的用户不打扰。
      onExit: (completed) => {
        useOnboardingStore.getState().exit();
        if (!completed) useAppStore.getState().pushToast(t("closed_hint"), "info");
      },
      startIndex: stepIndexRef.current,
      onStepChange: setStep,
      // 收尾行动：关闭引导由 tour 内部完成（记 seen、收起），这里只负责行动本身——
      // 打开新建弹窗。经 app-store 的请求信号跨组件送达大厅页（弹窗开关是它的本地
      // 状态，引导挂载点够不着）。
      onAction: () => useAppStore.getState().requestCreateProject(),
    });
    handleRef.current = handle;
    return () => {
      setStep(handle.currentIndex());
      handle.dispose();
      if (handleRef.current === handle) handleRef.current = null;
    };
    // 步骤号有意不进依赖（stepIndexRef 是 ref，读取本就不受 lint 约束）——步骤号变化
    // 不该重启这个效果，否则每次「下一步」都会拆重建 driver 实例。
  }, [active, onTourRoute, enteredInteractiveTarget, steps, t]);

  return null;
}
