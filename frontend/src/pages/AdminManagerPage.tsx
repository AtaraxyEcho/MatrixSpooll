import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, KeyRound, Loader2, LockKeyhole, LogOut, RefreshCw, ShieldCheck, UserPlus, UserRound, UserX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { getToken } from "@/utils/auth";
import { ROUTE_ADMIN_LOGIN, ROUTE_APP } from "@/app-routes";
import { FieldLabel } from "@/components/ui/FieldLabel";
import {
  ACCENT_BTN_CLS,
  ACCENT_BUTTON_STYLE,
  CARD_STYLE,
  DROPDOWN_PANEL_STYLE,
  INPUT_CLS,
} from "@/components/ui/darkroom-tokens";

type Role = "admin" | "member";

interface AdminUser {
  id: string;
  username: string;
  role: Role;
  is_superadmin: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface CreateResponse {
  user: AdminUser;
  temporary_password?: string | null;
}

interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}

const USER_PAGE_SIZE = 10;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

async function readError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => ({})) as { detail?: unknown };
  return new Error(typeof payload.detail === "string" ? payload.detail : fallback);
}

function RoleSelect({
  id,
  value,
  onChange,
  ariaLabel,
  className = "",
}: {
  id?: string;
  value: Role;
  onChange: (role: Role) => void;
  ariaLabel: string;
  className?: string;
}) {
  const { t } = useTranslation("admin");
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidth = Math.max(rect.width, 148);
    const menuHeight = 96;
    const top = rect.bottom + 6 + menuHeight <= window.innerHeight
      ? rect.bottom + 6
      : Math.max(8, rect.top - menuHeight - 6);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    setMenuPosition({ top, left, width: menuWidth });
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updateMenuPosition);
    document.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      document.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  const options: Array<{ value: Role; label: string }> = [
    { value: "member", label: t("role_member") },
    { value: "admin", label: t("role_admin") },
  ];
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        id={id}
        ref={buttonRef}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected.label}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            updateMenuPosition();
            setOpen(true);
          }
        }}
        className="inline-flex min-h-9 w-full items-center justify-between gap-1.5 rounded-md border border-hairline-soft bg-bg-grad-a/55 px-2 py-1.5 text-left text-xs text-text outline-none transition-colors hover:border-accent/45 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {value === "admin" ? (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-accent-2" aria-hidden />
          ) : (
            <UserRound className="h-3.5 w-3.5 shrink-0 text-text-4" aria-hidden />
          )}
          <span className="max-w-[82px] truncate">{selected.label}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          className="fixed z-[100] overflow-hidden rounded-lg border border-hairline-soft p-1 shadow-xl"
          style={{ ...DROPDOWN_PANEL_STYLE, top: menuPosition.top, left: menuPosition.left, width: menuPosition.width }}
        >
          {options.map((option) => {
            const selectedOption = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selectedOption}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-xs text-text-2 transition-colors hover:bg-accent/10 hover:text-text"
              >
                <span className="inline-flex items-center gap-2">
                  {option.value === "admin" ? (
                    <ShieldCheck className="h-3.5 w-3.5 text-accent-2" aria-hidden />
                  ) : (
                    <UserRound className="h-3.5 w-3.5 text-text-4" aria-hidden />
                  )}
                  {option.label}
                </span>
                {selectedOption && <Check className="h-3.5 w-3.5 text-accent-2" aria-hidden />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function AdminManagerPage() {
  const { t, i18n } = useTranslation("admin");
  const [, navigate] = useLocation();
  const token = useAuthStore((state) => state.token) ?? getToken();
  const logout = useAuthStore((state) => state.logout);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [page, setPage] = useState(1);
  const [totalUsers, setTotalUsers] = useState(0);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Accept-Language": i18n.language || "zh",
        Authorization: token ? `Bearer ${token}` : "",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) throw await readError(response, t("request_failed"));
    return response;
  }, [i18n.language, t, token]);

  const loadUsers = useCallback(async () => {
    if (!token) {
      navigate(`${ROUTE_ADMIN_LOGIN}?from=${encodeURIComponent("/app/admin/manager")}`);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await request(`/admin/users?page=${page}&page_size=${USER_PAGE_SIZE}`);
      const payload = await response.json() as AdminUsersResponse;
      setUsers(payload.users);
      setTotalUsers(payload.total);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("request_failed");
      if (message === t("request_failed")) {
        setError(message);
      } else {
        setError(message);
      }
      if (message.toLowerCase().includes("administrator") || message.includes("管理员")) {
        navigate(ROUTE_ADMIN_LOGIN);
      }
    } finally {
      setLoading(false);
    }
  }, [navigate, page, request, t, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadUsers();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadUsers]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await request("/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password: password || undefined, role }),
      });
      const payload = await response.json() as CreateResponse;
      setUsername("");
      setPassword("");
      setRole("member");
      setNotice(payload.temporary_password ? t("password_success", { password: payload.temporary_password }) : t("create_success"));
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("request_failed"));
    } finally {
      setSaving(false);
    }
  };

  const updateUser = async (user: AdminUser, patch: Partial<Pick<AdminUser, "role" | "is_active">>) => {
    setError("");
    setNotice("");
    try {
      await request(`/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("request_failed"));
    }
  };

  const resetPassword = async (user: AdminUser) => {
    setError("");
    try {
      const response = await request(`/admin/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST", body: "{}" });
      const payload = await response.json() as { temporary_password: string };
      setNotice(t("password_success", { password: payload.temporary_password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("request_failed"));
    }
  };

  const revokeSessions = async (user: AdminUser) => {
    setError("");
    try {
      await request(`/admin/users/${encodeURIComponent(user.id)}/revoke-sessions`, { method: "POST" });
      setNotice(t("sessions_revoked"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("request_failed"));
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalUsers / USER_PAGE_SIZE));
  const firstVisibleUser = totalUsers === 0 ? 0 : (page - 1) * USER_PAGE_SIZE + 1;
  const lastVisibleUser = Math.min(page * USER_PAGE_SIZE, totalUsers);

  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="app-topbar-surface">
        <div className="app-topbar-content app-topbar-content--wide app-topbar-inner flex items-center justify-between gap-4 px-6">
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-accent-2">{t("admin_portal")}</div>
            <h1 className="font-editorial mt-1 truncate text-2xl text-text">{t("manager_title")}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href={ROUTE_APP} className="rounded-md border border-hairline-soft px-3 py-2 text-xs text-text-3 hover:text-text">
              {t("back_to_workspace")}
            </Link>
            <button type="button" onClick={() => { logout(); navigate(ROUTE_ADMIN_LOGIN); }} className="inline-flex items-center gap-2 rounded-md border border-hairline-soft px-3 py-2 text-xs text-text-3 hover:text-text">
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              {t("logout")}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
        <div className="flex items-end justify-between gap-4">
          <p className="text-sm text-text-3">{t("manager_subtitle")}</p>
          <button type="button" onClick={() => void loadUsers()} className="inline-flex items-center gap-2 rounded-md border border-hairline-soft px-3 py-2 text-xs text-text-3 hover:text-text">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {t("refresh")}
          </button>
        </div>

        {error && <p role="alert" className="rounded-md border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</p>}
        {notice && <p role="status" className="rounded-md border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent-2">{notice}</p>}

        <section className="rounded-xl border border-hairline-soft p-5" style={CARD_STYLE}>
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold"><UserPlus className="h-4 w-4 text-accent-2" aria-hidden />{t("create_user")}</div>
          <form onSubmit={(event) => { void handleCreate(event); }} className="grid gap-4 md:grid-cols-[1fr_1fr_180px_auto] md:items-end">
            <div><FieldLabel htmlFor="admin-new-username" required>{t("username")}</FieldLabel><input id="admin-new-username" value={username} onChange={(event) => setUsername(event.target.value)} className={INPUT_CLS} required /></div>
            <div><FieldLabel htmlFor="admin-new-password">{t("password")}</FieldLabel><input id="admin-new-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} className={INPUT_CLS} placeholder={t("password_optional")} /></div>
            <div><FieldLabel htmlFor="admin-new-role">{t("role")}</FieldLabel><RoleSelect id="admin-new-role" ariaLabel={t("role")} value={role} onChange={setRole} className="w-full" /></div>
            <button type="submit" disabled={saving} className={`${ACCENT_BTN_CLS} justify-center`} style={ACCENT_BUTTON_STYLE}>{saving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}{t("save_user")}</button>
          </form>
        </section>

        <section className="overflow-hidden rounded-xl border border-hairline-soft" style={CARD_STYLE}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-12 text-sm text-text-3"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />{t("loading")}</div>
          ) : users.length === 0 ? (
            <div className="p-12 text-center text-sm text-text-3">{t("empty")}</div>
          ) : (
            <><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-hairline-soft bg-bg-grad-a/50 text-xs text-text-4"><tr><th className="px-5 py-3">{t("username")}</th><th className="px-5 py-3">{t("role")}</th><th className="px-5 py-3">{t("status")}</th><th className="px-5 py-3">{t("created_at")}</th><th className="px-5 py-3 text-right">{t("actions")}</th></tr></thead><tbody className="divide-y divide-hairline-soft">{users.map((user) => <tr key={user.id} className={user.is_superadmin ? "align-middle bg-accent/5" : "align-middle"}><td className="px-5 py-4 font-medium"><span className="inline-flex items-center gap-2"><UserRound className="h-4 w-4 text-text-4" aria-hidden />{user.username}</span></td><td className="px-5 py-4">{user.is_superadmin ? (<span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent-2"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t("super_admin")}<LockKeyhole className="h-3 w-3 opacity-70" aria-hidden /></span>) : (<RoleSelect ariaLabel={t("role_for_user", { username: user.username })} value={user.role} onChange={(nextRole) => void updateUser(user, { role: nextRole })} className="w-[118px]" />)}</td><td className="px-5 py-4"><span className={user.is_active ? "text-emerald-300" : "text-text-4"}>{user.is_active ? t("active") : t("disabled")}</span></td><td className="px-5 py-4 text-text-4">{formatDate(user.created_at)}</td><td className="px-5 py-4"><div className="flex justify-end gap-2"><button disabled={user.is_superadmin} type="button" title={user.is_superadmin ? t("protected") : user.is_active ? t("disable") : t("enable")} onClick={() => void updateUser(user, { is_active: !user.is_active })} className="rounded-md border border-hairline-soft p-2 text-text-3 hover:border-accent/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-40">{user.is_active ? <UserX className="h-3.5 w-3.5" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}</button><button disabled={user.is_superadmin} type="button" title={t("reset_password")} onClick={() => void resetPassword(user)} className="rounded-md border border-hairline-soft p-2 text-text-3 hover:border-accent/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"><KeyRound className="h-3.5 w-3.5" aria-hidden /></button><button disabled={user.is_superadmin} type="button" title={t("revoke_sessions")} onClick={() => void revokeSessions(user)} className="rounded-md border border-hairline-soft p-2 text-text-3 hover:border-accent/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"><LogOut className="h-3.5 w-3.5" aria-hidden /></button></div></td></tr>)}</tbody></table></div><div className="flex items-center justify-between gap-4 border-t border-hairline-soft px-5 py-3"><span className="text-xs text-text-4">{t("pagination_summary", { start: firstVisibleUser, end: lastVisibleUser, total: totalUsers })}</span><div className="flex items-center gap-1.5"><button type="button" aria-label={t("previous_page")} title={t("previous_page")} disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-hairline-soft text-text-3 transition-colors hover:border-accent/45 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"><ChevronLeft className="h-4 w-4" aria-hidden /></button><span className="min-w-[72px] text-center font-mono text-[11px] text-text-3">{t("pagination_page", { page, total: totalPages })}</span><button type="button" aria-label={t("next_page")} title={t("next_page")} disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-hairline-soft text-text-3 transition-colors hover:border-accent/45 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"><ChevronRight className="h-4 w-4" aria-hidden /></button></div></div></>
          )}
        </section>
      </main>
    </div>
  );
}
