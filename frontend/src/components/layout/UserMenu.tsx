import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { ChevronDown, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { GlassPopover } from "@/components/ui/GlassPopover";
import { GlassModal } from "@/components/ui/GlassModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AccountSecuritySection } from "@/components/pages/AccountSecuritySection";
import { ROUTE_ADMIN_MANAGER } from "@/app-routes";
import { API } from "@/api";

/**
 * 顶栏右侧的用户菜单：avatar 触发器 + 下拉（管理员门户 / 账号安全 / 退出登录）。
 *
 * 会话级操作统一收拢于此，工作台（GlobalHeader）与大厅（ProjectsPage::TopBar）
 * 两处持久顶栏共用。无真实会话（AUTH_ENABLED=false、无 token）时不渲染。
 * 弹层与模态分别复用 GlassPopover / GlassModal 原语，外部点击与 Esc 收起由
 * Popover/ModalShell 内建处理。
 */
export function UserMenu() {
  const { t } = useTranslation(["common", "dashboard", "admin"]);
  const [, setLocation] = useLocation();
  const username = useAuthStore((s) => s.username);
  const nickname = useAuthStore((s) => s.nickname);
  const avatarPath = useAuthStore((s) => s.avatarPath);
  const role = useAuthStore((s) => s.role);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // 无真实会话时不渲染控件：AUTH_ENABLED=false 时没有可退出的会话，显示无效入口
  if (!isAuthenticated || !username) return null;

  // 优先展示昵称，未设置昵称时回退账号
  const displayName = nickname ?? username;
  const initial = (displayName ?? "?").slice(0, 1).toUpperCase();
  const avatarUrl = avatarPath ? API.getAvatarUrl(avatarPath, avatarPath) : null;
  const roleLabel =
    role === "admin" ? t("admin:role_admin") : role === "member" ? t("admin:role_member") : null;

  const confirmLogout = () => {
    setLogoutConfirmOpen(false);
    setOpen(false);
    useAuthStore.getState().logout();
    // 与 AuthGuard 登录回跳口径一致：携带完整原 URL，登录成功后按 safeReturnPath 回跳
    const from = encodeURIComponent(
      window.location.pathname + window.location.search + window.location.hash,
    );
    setLocation(`~/login?from=${from}`);
  };

  return (
    <>
      <div className="relative" ref={anchorRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("common:account_menu", { username: displayName ?? "" })}
          title={displayName ?? undefined}
          className="relative inline-flex h-[30px] max-w-full items-center gap-1 rounded-md pl-[3px] pr-1 transition hover:scale-105 focus-ring"
          style={{ background: open ? "oklch(0.26 0.012 265 / 0.5)" : "transparent" }}
          onMouseEnter={(e) => {
            if (!open) e.currentTarget.style.background = "oklch(0.28 0.012 265 / 0.6)";
          }}
          onMouseLeave={(e) => {
            if (!open) e.currentTarget.style.background = "transparent";
          }}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="h-6 w-6 shrink-0 rounded-md object-cover"
              style={{ boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.12)" }}
            />
          ) : (
            <span
              className="display-serif grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11.5px] font-bold"
              style={{
                background: "linear-gradient(135deg, var(--color-accent) 0%, oklch(0.55 0.12 260) 100%)",
                color: "oklch(0.12 0 0)",
                boxShadow:
                  "inset 0 1px 0 oklch(1 0 0 / 0.25), inset 0 -1px 0 oklch(0 0 0 / 0.15), 0 0 0 1px oklch(1 0 0 / 0.08)",
              }}
            >
              {initial}
            </span>
          )}
          {displayName && (
            <span
              className="hidden max-w-[110px] truncate text-[11.5px] font-medium sm:inline"
              style={{ color: "var(--color-text-2)" }}
            >
              {displayName}
            </span>
          )}
          <span
            className="hidden transition-transform sm:block"
            style={{
              color: "var(--color-text-4)",
              transform: open ? "rotate(180deg)" : "none",
            }}
          >
            <ChevronDown className="h-3 w-3" />
          </span>
        </button>

        <GlassPopover
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          align="end"
          sideOffset={6}
          width="w-56"
        >
          <div className="p-1.5">
            {/* 头部：用户名 + 角色 */}
            <div className="px-2.5 pb-1.5 pt-1.5">
              <div
                className="truncate text-[13px] font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                {displayName}
              </div>
              {nickname && username && username !== nickname && (
                <div className="truncate text-[10.5px] text-text-4">@{username}</div>
              )}
              {roleLabel && (
                <div
                  className="num mt-0.5 text-[9.5px] font-bold uppercase"
                  style={{ color: "var(--color-text-4)", letterSpacing: "1px" }}
                >
                  {roleLabel}
                </div>
              )}
            </div>
            <div className="mx-1.5 my-1 h-px" style={{ background: "var(--color-hairline-soft)" }} />

            {role === "admin" && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setLocation(`~${ROUTE_ADMIN_MANAGER}`);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors focus-ring"
                style={{ color: "var(--color-text-3)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "oklch(0.26 0.012 265 / 0.55)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: "var(--color-text-4)" }}
                />
                <span>{t("admin:admin_portal")}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPasswordOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors focus-ring"
              style={{ color: "var(--color-text-3)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "oklch(0.26 0.012 265 / 0.55)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-text-4)" }} />
              <span>{t("dashboard:account_security")}</span>
            </button>

            <div className="mx-1.5 my-1 h-px" style={{ background: "var(--color-hairline-soft)" }} />

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setLogoutConfirmOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors focus-ring"
              style={{ color: "var(--color-text-3)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "oklch(0.26 0.012 265 / 0.55)";
                e.currentTarget.style.color = "oklch(0.78 0.13 25)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--color-text-3)";
              }}
            >
              <LogOut className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-text-4)" }} />
              <span>{t("common:logout")}</span>
            </button>
          </div>
        </GlassPopover>
      </div>

      <GlassModal
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        ariaLabel={t("dashboard:account_security")}
        widthClassName="w-full max-w-xl"
        panelStyle={{ maxHeight: "min(720px, calc(100vh - 48px))" }}
      >
        <div className="max-h-[min(720px,calc(100vh-48px))] overflow-y-auto p-5">
          <AccountSecuritySection />
        </div>
      </GlassModal>

      <ConfirmDialog
        open={logoutConfirmOpen}
        tone="danger"
        title={t("common:logout_confirm_title")}
        description={t("common:logout_confirm_description")}
        confirmLabel={t("common:logout_confirm_confirm")}
        cancelLabel={t("common:cancel")}
        onCancel={() => setLogoutConfirmOpen(false)}
        onConfirm={confirmLogout}
      />
    </>
  );
}
