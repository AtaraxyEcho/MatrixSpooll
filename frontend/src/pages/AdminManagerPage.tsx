import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ClipboardList, Eye, FileClock, KeyRound, Laptop, LayoutGrid, Loader2, LockKeyhole, LogIn, LogOut, PanelLeftClose, PanelLeftOpen, PencilLine, RefreshCw, Search, ShieldCheck, Trash2, UserPlus, UserRound, UserX, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { ROUTE_ADMIN_LOGIN, ROUTE_ADMIN_LOGS, ROUTE_ADMIN_MANAGER, ROUTE_ADMIN_SESSIONS, ROUTE_ADMIN_TASKS, ROUTE_ADMIN_USERS, ROUTE_APP } from "@/app-routes";
import { FieldLabel } from "@/components/ui/FieldLabel";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { GlassModal } from "@/components/ui/GlassModal";
import { ACCENT_BTN_CLS, ACCENT_BUTTON_STYLE, CARD_STYLE, DROPDOWN_PANEL_STYLE, INPUT_CLS } from "@/components/ui/darkroom-tokens";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import type { AdminAuditEvent, AdminLoginEvent, AdminLoginOutcome, AdminSession } from "@/types/admin";
import type { TaskItem, TaskStatus } from "@/types/task";
import { sessionFetch } from "@/utils/auth";

type Role = "admin" | "member";
export type AdminSection = "users" | "sessions" | "logs" | "tasks";

interface AdminUser { id: string; username: string; nickname: string | null; avatar_path: string | null; email: string | null; last_login_at: string | null; last_login_ip: string | null; role: Role; is_superadmin: boolean; is_active: boolean; created_at: string; updated_at: string; }
interface AdminUsersResponse { users: AdminUser[]; total: number; page: number; page_size: number; }
interface CreateResponse { user: AdminUser; temporary_password?: string | null; }
const USER_PAGE_SIZE = 10;
const PAGE_SIZE = 10;
const USERNAME_MIN_LENGTH = 4;
const USERNAME_MAX_LENGTH = 32;
const USERNAME_ALLOWED_PATTERN = /^[A-Za-z0-9._-]+$/;
const USERNAME_SEPARATOR_PATTERN = /[._-]{2}/;
const NICKNAME_MIN_LENGTH = 2;
const NICKNAME_MAX_LENGTH = 20;
const NICKNAME_ALLOWED_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_\-·]+$/;

type UsernameErrorKey = "username_required" | "username_length_error" | "username_start_error" | "username_characters_error" | "username_separators_error";

function usernameErrorKey(username: string): UsernameErrorKey | null {
  if (!username) return "username_required";
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) return "username_length_error";
  if (!/^[A-Za-z]/.test(username)) return "username_start_error";
  if (!USERNAME_ALLOWED_PATTERN.test(username)) return "username_characters_error";
  if (/[._-]$/.test(username) || USERNAME_SEPARATOR_PATTERN.test(username)) return "username_separators_error";
  return null;
}

type NicknameErrorKey = "nickname_length_error" | "nickname_characters_error" | "nickname_spacing_error";

function nicknameErrorKey(nickname: string): NicknameErrorKey | null {
  const value = nickname.trim();
  if (!value) return null; // 选填：空值视为未填
  if (value.length < NICKNAME_MIN_LENGTH || value.length > NICKNAME_MAX_LENGTH) return "nickname_length_error";
  if (/\s/.test(nickname)) return "nickname_spacing_error";
  if (!NICKNAME_ALLOWED_PATTERN.test(value)) return "nickname_characters_error";
  return null;
}

function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)); }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function rowNumber(page: number, index: number, pageSize = PAGE_SIZE): number { return (page - 1) * pageSize + index + 1; }
function formatAuditDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (typeof value === "function") return "function";
  return "unknown";
}
async function readError(response: Response, fallback: string): Promise<Error> { const payload = await response.json().catch(() => ({})) as { detail?: unknown }; return new Error(typeof payload.detail === "string" ? payload.detail : fallback); }

function RoleSelect({ id, value, onChange, ariaLabel, className = "", disabled = false, allowAdmin = true }: { id?: string; value: Role; onChange: (role: Role) => void; ariaLabel: string; className?: string; disabled?: boolean; allowAdmin?: boolean }) {
  const { t } = useTranslation("admin"); const [open, setOpen] = useState(false); const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null); const buttonRef = useRef<HTMLButtonElement>(null); const containerRef = useRef<HTMLDivElement>(null); const menuRef = useRef<HTMLDivElement>(null);
  const updatePosition = useCallback(() => { const rect = buttonRef.current?.getBoundingClientRect(); if (!rect) return; const width = Math.max(rect.width, 148); const height = 100; setPosition({ top: rect.bottom + height + 8 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6), left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width }); }, []);
  useEffect(() => { if (!open) return; const close = (event: PointerEvent) => { const target = event.target as Node; if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false); }; const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); }; document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape); window.addEventListener("resize", updatePosition); document.addEventListener("scroll", updatePosition, true); return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); window.removeEventListener("resize", updatePosition); document.removeEventListener("scroll", updatePosition, true); }; }, [open, updatePosition]);
  const options: Array<{ value: Role; label: string }> = allowAdmin ? [{ value: "member", label: t("role_member") }, { value: "admin", label: t("role_admin") }] : [{ value: "member", label: t("role_member") }]; const selected = options.find((item) => item.value === value) ?? options[0];
  return <div ref={containerRef} className={`relative ${className}`}><button type="button" ref={buttonRef} id={id} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => { if (open) setOpen(false); else { updatePosition(); setOpen(true); } }} className="inline-flex min-h-9 w-full items-center justify-between gap-1.5 rounded-md border border-hairline-soft bg-bg-grad-a/55 px-2 py-1.5 text-left text-xs text-text outline-none transition-colors hover:border-accent/45 focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50"><span className="inline-flex min-w-0 items-center gap-2">{value === "admin" ? <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-accent-2" aria-hidden /> : <UserRound className="h-3.5 w-3.5 shrink-0 text-text-4" aria-hidden />}<span className="truncate">{selected.label}</span></span><ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden /></button>{open && position && createPortal(<div ref={menuRef} role="listbox" aria-label={ariaLabel} className="fixed z-[100] overflow-hidden rounded-lg border border-hairline-soft p-1 shadow-xl" style={{ ...DROPDOWN_PANEL_STYLE, top: position.top, left: position.left, width: position.width }}>{options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }} className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-xs text-text-2 transition-colors hover:bg-accent/10 hover:text-text"><span className="inline-flex items-center gap-2">{option.value === "admin" ? <ShieldCheck className="h-3.5 w-3.5 text-accent-2" aria-hidden /> : <UserRound className="h-3.5 w-3.5 text-text-4" aria-hidden />}{option.label}</span>{option.value === value && <Check className="h-3.5 w-3.5 text-accent-2" aria-hidden />}</button>)}</div>, document.body)}</div>;
}

interface SectionProps { request: (path: string, init?: RequestInit) => Promise<Response>; onError: (message: string) => void; onNotice: (message: string) => void; }

function UsersSection({ request, onError, onNotice }: SectionProps) {
  const { t } = useTranslation("admin");
  const currentUserId = useAuthStore((state) => state.id);
  const isSuperadmin = useAuthStore((state) => state.isSuperadmin);
  const canManage = (user: AdminUser): boolean => {
    if (user.is_superadmin) return false;
    if (isSuperadmin) return true;
    if (user.id === currentUserId) return false;
    return user.role !== "admin";
  };
  const actionTitle = (user: AdminUser, normalTitle: string): string => {
    if (user.is_superadmin) return t("protected");
    if (!canManage(user)) return t("hierarchy_forbidden");
    return normalTitle;
  };
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [createUsername, setCreateUsername] = useState("");
  const [createNickname, setCreateNickname] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [nicknameError, setNicknameError] = useState("");
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editNickname, setEditNickname] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editRole, setEditRole] = useState<Role>("member");
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);
  const load = useCallback(async (targetPage = page) => { setLoading(true); try { const query = new URLSearchParams({ page: String(targetPage), page_size: String(USER_PAGE_SIZE) }); if (search.trim()) query.set("username", search.trim()); const response = await request(`/admin/users?${query.toString()}`); const payload = await response.json() as AdminUsersResponse; setUsers(payload.users); setTotal(payload.total); setPage(payload.page); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } finally { setLoading(false); } }, [onError, page, request, search, t]); useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  const openCreateDialog = () => {
    setCreateError("");
    setNicknameError("");
    setCreateOpen(true);
  };
  const closeCreateDialog = () => {
    if (saving) return;
    setCreateError("");
    setNicknameError("");
    setCreateOpen(false);
  };
  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const username = createUsername.trim();
    const validationKey = usernameErrorKey(username);
    if (validationKey) {
      setCreateError(t(validationKey, { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH }));
      return;
    }
    const nickname = createNickname.trim();
    const nicknameValidation = nickname ? nicknameErrorKey(nickname) : null;
    if (nicknameValidation) {
      setNicknameError(t(nicknameValidation, { min: NICKNAME_MIN_LENGTH, max: NICKNAME_MAX_LENGTH }));
      return;
    }
    setCreateError("");
    setNicknameError("");
    setSaving(true);
    try {
      const response = await request("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username,
          nickname: nickname || undefined,
          email: createEmail.trim() || undefined,
          password: password || undefined,
          role,
        }),
      });
      const payload = await response.json() as CreateResponse;
      setCreateUsername("");
      setCreateNickname("");
      setCreateEmail("");
      setPassword("");
      setRole("member");
      setCreateOpen(false);
      onNotice(payload.temporary_password ? t("password_success", { password: payload.temporary_password }) : t("create_success"));
      await load();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t("request_failed"));
    } finally {
      setSaving(false);
    }
  };
  const update = async (user: AdminUser, patch: Partial<Pick<AdminUser, "role" | "is_active">>) => { try { await request(`/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify(patch) }); await load(); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } }; const resetPassword = async (user: AdminUser) => { try { const response = await request(`/admin/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST", body: "{}" }); const payload = await response.json() as { temporary_password: string }; onNotice(t("password_success", { password: payload.temporary_password })); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } };
  const openEditDialog = (user: AdminUser) => { setEditingUser(user); setEditNickname(user.nickname ?? ""); setEditEmail(user.email ?? ""); setEditRole(user.role); setEditError(""); setEditSaving(false); };
  const closeEditDialog = () => { if (editSaving) return; setEditingUser(null); setEditError(""); };
  const saveEdit = async () => { if (!editingUser) return; const nickname = editNickname.trim(); const nicknameValidation = nickname ? nicknameErrorKey(nickname) : null; if (nicknameValidation) { setEditError(t(nicknameValidation, { min: NICKNAME_MIN_LENGTH, max: NICKNAME_MAX_LENGTH })); return; } setEditError(""); setEditSaving(true); try { await request(`/admin/users/${encodeURIComponent(editingUser.id)}`, { method: "PATCH", body: JSON.stringify({ nickname: nickname || undefined, email: editEmail.trim() || undefined, role: editRole }) }); onNotice(t("user_update_success")); setEditingUser(null); await load(); } catch (error) { setEditError(error instanceof Error ? error.message : t("request_failed")); } finally { setEditSaving(false); } };
  const deleteUser = async (user: AdminUser) => { setDeletingUser(null); try { await request(`/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" }); onNotice(t("user_delete_success")); await load(); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } };
  const pages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
  return (
    <>
      <SectionFrame
        icon={<UserRound className="h-4 w-4 text-accent-2" aria-hidden />}
        title={t("nav_users")}
        description={t("users_description")}
        action={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={openCreateDialog} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-accent/35 bg-accent/10 px-3 text-xs text-accent-2 transition-colors hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              {t("create_user")}
            </button>
            <button type="button" onClick={() => void load()} className="icon-button" title={t("refresh")} aria-label={t("refresh")}>
              <RefreshCw className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
      >
        <form className="flex flex-wrap items-end gap-3 border-b border-hairline-soft p-5" onSubmit={(event) => { event.preventDefault(); setPage(1); void load(1); }}>
          <div className="w-full max-w-[320px]">
            <FieldLabel htmlFor="admin-user-search">{t("search_users")}</FieldLabel>
            <input id="admin-user-search" value={search} maxLength={254} onChange={(event) => setSearch(event.target.value)} className={INPUT_CLS} placeholder={t("search_users_placeholder")} />
          </div>
          <button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-hairline-soft px-3 text-xs text-text-2 transition-colors hover:border-accent/45 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <Search className="h-3.5 w-3.5" aria-hidden />
            {t("audit_filter")}
          </button>
        </form>
        {loading ? <LoadingState label={t("loading")} /> : users.length === 0 ? <EmptyState label={t("empty")} /> : <><div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm"><thead className="border-b border-hairline-soft bg-bg-grad-a/50 text-xs text-text-4"><tr><th className="w-16 px-5 py-3">{t("sequence")}</th><th className="px-5 py-3">{t("username")}</th><th className="px-5 py-3">{t("nickname")}</th><th className="px-5 py-3">{t("email")}</th><th className="px-5 py-3">{t("last_login")}</th><th className="px-5 py-3">{t("role")}</th><th className="px-5 py-3">{t("status")}</th><th className="px-5 py-3">{t("created_at")}</th><th className="px-5 py-3 text-right">{t("actions")}</th></tr></thead><tbody className="divide-y divide-hairline-soft">{users.map((user, index) => <tr key={user.id}><td className="px-5 py-4 font-mono text-xs tabular-nums text-text-4">{rowNumber(page, index, USER_PAGE_SIZE)}</td><td className="px-5 py-4 font-medium"><span className="inline-flex items-center gap-2"><UserRound className="h-4 w-4 text-text-4" aria-hidden />{user.username}</span></td><td className="px-5 py-4 text-text-3">{user.nickname || "-"}</td><td className="px-5 py-4 text-text-3">{user.email || "-"}</td><td className="whitespace-nowrap px-5 py-4 text-text-4">{user.last_login_at ? formatDateTime(user.last_login_at) : "-"}</td><td className="px-5 py-4">{user.is_superadmin ? <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] text-accent-2"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t("super_admin")}<LockKeyhole className="h-3 w-3 opacity-70" aria-hidden /></span> : <RoleSelect ariaLabel={t("role_for_user", { username: user.username })} value={user.role} onChange={(next) => void update(user, { role: next })} className="w-[124px]" disabled={!canManage(user)} allowAdmin={isSuperadmin} />}</td><td className="px-5 py-4"><span className={user.is_active ? "text-emerald-300" : "text-text-4"}>{user.is_active ? t("active") : t("disabled")}</span></td><td className="px-5 py-4 text-text-4">{formatDate(user.created_at)}</td><td className="px-5 py-4"><div className="flex justify-end gap-2"><button type="button" disabled={!canManage(user)} title={actionTitle(user, t("user_edit"))} aria-label={actionTitle(user, t("user_edit"))} onClick={() => openEditDialog(user)} className="icon-button"><PencilLine className="h-3.5 w-3.5" aria-hidden /></button><button type="button" disabled={!canManage(user)} title={actionTitle(user, t("user_delete"))} aria-label={actionTitle(user, t("user_delete"))} onClick={() => setDeletingUser(user)} className="icon-button"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button><button type="button" disabled={!canManage(user)} title={actionTitle(user, user.is_active ? t("disable") : t("enable"))} aria-label={actionTitle(user, user.is_active ? t("disable") : t("enable"))} onClick={() => void update(user, { is_active: !user.is_active })} className="icon-button">{user.is_active ? <UserX className="h-3.5 w-3.5" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}</button><button type="button" disabled={!canManage(user)} title={actionTitle(user, t("reset_password"))} aria-label={actionTitle(user, t("reset_password"))} onClick={() => void resetPassword(user)} className="icon-button"><KeyRound className="h-3.5 w-3.5" aria-hidden /></button></div></td></tr>)}</tbody></table></div><Pagination page={page} pages={pages} onPageChange={setPage} totalCount={total} /></>}
      </SectionFrame>

      <GlassModal
        open={createOpen}
        onClose={closeCreateDialog}
        ariaLabel={t("create_user")}
        widthClassName="w-full max-w-lg"
        closeOnBackdrop={!saving}
        closeOnEscape={!saving}
      >
        <form onSubmit={(event) => { void handleCreate(event); }} className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-text">{t("create_user")}</h2>
              <p className="mt-1 max-w-md text-xs leading-5 text-text-3">{t("create_user_description")}</p>
            </div>
            <button type="button" className="icon-button" title={t("cancel")} aria-label={t("cancel")} onClick={closeCreateDialog} disabled={saving}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="grid gap-4">
            <div className="max-w-[360px]">
              <FieldLabel htmlFor="admin-new-username" required>{t("username")}</FieldLabel>
              <input
                id="admin-new-username"
                value={createUsername}
                minLength={USERNAME_MIN_LENGTH}
                maxLength={USERNAME_MAX_LENGTH}
                placeholder={t("username_input_placeholder")}
                onChange={(event) => setCreateUsername(event.target.value)}
                onInvalid={(event) => {
                  event.preventDefault();
                  const validationKey = usernameErrorKey(createUsername.trim());
                  if (validationKey) setCreateError(t(validationKey, { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH }));
                }}
                className={`${INPUT_CLS} ${createError ? "border-red-400/60 focus:border-red-400/70 focus-visible:ring-red-400/25" : ""}`}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(createError)}
                aria-describedby={createError ? "admin-new-username-help admin-create-user-error" : "admin-new-username-help"}
                required
              />
              <p id="admin-new-username-help" className="mt-1.5 text-[11px] leading-4 text-text-4">{t("username_rules", { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH })}</p>
              {createError ? (
                <p id="admin-create-user-error" role="alert" className="mt-2 text-xs leading-5 text-red-300">{createError}</p>
              ) : null}
            </div>
            <div className="max-w-[360px]">
              <FieldLabel htmlFor="admin-new-nickname">{t("nickname")}</FieldLabel>
              <input
                id="admin-new-nickname"
                value={createNickname}
                maxLength={NICKNAME_MAX_LENGTH}
                placeholder={t("nickname_input_placeholder")}
                onChange={(event) => setCreateNickname(event.target.value)}
                className={`${INPUT_CLS} ${nicknameError ? "border-red-400/60 focus:border-red-400/70 focus-visible:ring-red-400/25" : ""}`}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(nicknameError)}
                aria-describedby={nicknameError ? "admin-new-nickname-help admin-create-nickname-error" : "admin-new-nickname-help"}
              />
              <p id="admin-new-nickname-help" className="mt-1.5 text-[11px] leading-4 text-text-4">{t("nickname_rules", { min: NICKNAME_MIN_LENGTH, max: NICKNAME_MAX_LENGTH })}</p>
              {nicknameError ? (
                <p id="admin-create-nickname-error" role="alert" className="mt-2 text-xs leading-5 text-red-300">{nicknameError}</p>
              ) : null}
            </div>
            <div className="max-w-[360px]">
              <FieldLabel htmlFor="admin-new-email">{t("email")}</FieldLabel>
              <input id="admin-new-email" type="email" maxLength={254} value={createEmail} onChange={(event) => setCreateEmail(event.target.value)} className={INPUT_CLS} placeholder={t("email_input_placeholder")} />
            </div>
            <div className="max-w-[360px]">
              <FieldLabel htmlFor="admin-new-password">{t("password")}</FieldLabel>
              <input id="admin-new-password" type="password" minLength={8} maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} className={INPUT_CLS} placeholder={t("password_optional")} />
            </div>
            <div className="max-w-[220px]">
              <FieldLabel htmlFor="admin-new-role">{t("role")}</FieldLabel>
              <RoleSelect id="admin-new-role" ariaLabel={t("role")} value={role} onChange={setRole} allowAdmin={isSuperadmin} />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" onClick={closeCreateDialog} disabled={saving} className="rounded-md border border-hairline-soft px-3 py-2 text-xs text-text-3 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">{t("cancel")}</button>
            <button type="submit" disabled={saving} className={`${ACCENT_BTN_CLS} justify-center`} style={ACCENT_BUTTON_STYLE}>
              {saving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
              {t("save_user")}
            </button>
          </div>
        </form>
      </GlassModal>

      <GlassModal open={editingUser !== null} onClose={closeEditDialog} labelledBy="admin-edit-user-title" widthClassName="w-full max-w-lg">
        <div className="px-6 pb-6 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="admin-edit-user-title" className="display-serif text-[17px] font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>{t("edit_user")} — {editingUser?.username}</h2>
              <p className="mt-1 text-[12px] text-text-3">{t("edit_user_description")}</p>
            </div>
            <button type="button" onClick={closeEditDialog} disabled={editSaving} aria-label={t("common:close")} className="rounded-md border border-hairline-soft p-1.5 text-text-4 transition-colors hover:border-hairline-strong hover:text-text disabled:opacity-50"><X className="h-4 w-4" aria-hidden /></button>
          </div>
          {editError ? <p role="alert" className="mt-3 rounded-md border border-warm/30 bg-warm/10 px-3 py-2 text-[12px] text-warm-bright">{editError}</p> : null}
          <form className="mt-4 grid gap-4" onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
            <div className="max-w-[360px]">
              <FieldLabel htmlFor="admin-edit-nickname">{t("nickname")}</FieldLabel>
              <input id="admin-edit-nickname" value={editNickname} maxLength={NICKNAME_MAX_LENGTH} placeholder={t("nickname_input_placeholder")} onChange={(event) => setEditNickname(event.target.value)} className={INPUT_CLS} autoComplete="off" spellCheck={false} disabled={editSaving} />
              <p className="mt-1.5 text-[11px] leading-4 text-text-4">{t("nickname_rules", { min: NICKNAME_MIN_LENGTH, max: NICKNAME_MAX_LENGTH })}</p>
            </div>
            <div className="max-w-[360px]">
              <FieldLabel htmlFor="admin-edit-email">{t("email")}</FieldLabel>
              <input id="admin-edit-email" type="email" maxLength={254} value={editEmail} placeholder={t("email_input_placeholder")} onChange={(event) => setEditEmail(event.target.value)} className={INPUT_CLS} disabled={editSaving} />
            </div>
            <div className="max-w-[220px]">
              <FieldLabel>{t("role")}</FieldLabel>
              <RoleSelect ariaLabel={t("role")} value={editRole} onChange={setEditRole} allowAdmin={isSuperadmin} />
            </div>
            <div className="max-w-[360px]">
              <FieldLabel htmlFor="admin-edit-password">{t("password")}</FieldLabel>
              <input id="admin-edit-password" type="password" value="unchangeable" readOnly disabled aria-disabled="true" className={`${INPUT_CLS} opacity-60`} />
              <p className="mt-1.5 text-[11px] leading-4 text-warm-bright/90">{t("password_disabled_hint")}</p>
            </div>
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" onClick={closeEditDialog} disabled={editSaving} className="rounded-md border border-hairline-soft px-3 py-2 text-xs text-text-3 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">{t("cancel")}</button>
              <button type="submit" disabled={editSaving} className={`${ACCENT_BTN_CLS} justify-center`} style={ACCENT_BUTTON_STYLE}>
                {editSaving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                {t("save_changes")}
              </button>
            </div>
          </form>
        </div>
      </GlassModal>

      <ConfirmDialog
        open={deletingUser !== null}
        tone="danger"
        title={t("delete_user_confirm_title")}
        description={t("delete_user_confirm_description")}
        confirmLabel={t("user_delete")}
        cancelLabel={t("cancel")}
        onCancel={() => setDeletingUser(null)}
        onConfirm={() => { if (deletingUser) void deleteUser(deletingUser); }}
      />
    </>
  );
}

function SessionsSection({ onError, onNotice }: Pick<SectionProps, "onError" | "onNotice">) {
  const { t } = useTranslation("admin"); const [sessions, setSessions] = useState<AdminSession[]>([]); const [username, setUsername] = useState(""); const [page, setPage] = useState(1); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true);
  const load = useCallback(async (targetPage = 1) => { setLoading(true); try { const response = await API.listAdminSessions({ page: targetPage, pageSize: PAGE_SIZE, username }); setSessions(response.sessions); setTotal(response.total); setPage(response.page); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } finally { setLoading(false); } }, [onError, t, username]); useEffect(() => { const timer = window.setTimeout(() => { void load(1); }, 0); return () => window.clearTimeout(timer); }, [load]); const revoke = async (item: AdminSession) => { try { await API.revokeAdminSession(item.id); onNotice(t("session_revoke_success")); await load(page); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } }; const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => {
    const timer = window.setInterval(() => { void load(page); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load, page]);
  return <SectionFrame icon={<Laptop className="h-4 w-4 text-accent-2" aria-hidden />} title={t("nav_sessions")} description={t("sessions_description")} action={<button type="button" onClick={() => void load()} className="icon-button" title={t("refresh")} aria-label={t("refresh")}><RefreshCw className="h-4 w-4" aria-hidden /></button>}><form className="flex flex-wrap items-end gap-3 border-b border-hairline-soft p-5" onSubmit={(event) => { event.preventDefault(); void load(1); }}><div className="w-full max-w-[320px]"><FieldLabel htmlFor="session-username">{t("username")}</FieldLabel><input id="session-username" value={username} onChange={(event) => setUsername(event.target.value)} className={INPUT_CLS} placeholder={t("session_username_placeholder")} /></div><button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-hairline-soft px-3 text-xs text-text-2 hover:border-accent/45 hover:text-text"><Search className="h-3.5 w-3.5" aria-hidden />{t("audit_filter")}</button></form>{loading ? <LoadingState label={t("sessions_loading")} /> : sessions.length === 0 ? <EmptyState label={t("sessions_empty")} /> : <><div className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-xs"><thead className="border-b border-hairline-soft bg-bg-grad-a/50 text-text-4"><tr><th className="w-16 px-5 py-3">{t("sequence")}</th><th className="px-5 py-3">{t("username")}</th><th className="px-5 py-3">{t("session_device")}</th><th className="px-5 py-3">{t("session_ip")}</th><th className="px-5 py-3">{t("session_agent")}</th><th className="px-5 py-3">{t("status")}</th><th className="px-5 py-3">{t("session_last_seen")}</th><th className="px-5 py-3 text-right">{t("actions")}</th></tr></thead><tbody className="divide-y divide-hairline-soft">{sessions.map((item, index) => <tr key={item.id}><td className="px-5 py-4 font-mono tabular-nums text-text-4">{rowNumber(page, index)}</td><td className="px-5 py-4 font-medium text-text">{item.username}</td><td className="px-5 py-4 font-mono text-text-3">{item.device_id}</td><td className="px-5 py-4 font-mono text-text-3">{item.ip_address || "-"}</td><td className="max-w-[260px] truncate px-5 py-4 text-text-4" title={item.user_agent || undefined}>{item.user_agent || "-"}</td><td className="px-5 py-4"><StatusBadge status="active" label={t("session_active")} /></td><td className="whitespace-nowrap px-5 py-4 text-text-4">{formatDateTime(item.last_seen_at)}</td><td className="px-5 py-4 text-right"><button type="button" onClick={() => void revoke(item)} title={t("revoke_session")} aria-label={t("revoke_session")} className="icon-button"><LogOut className="h-3.5 w-3.5" aria-hidden /></button></td></tr>)}</tbody></table></div><Pagination page={page} pages={pages} onPageChange={(next) => void load(next)} totalCount={total} /></>}</SectionFrame>;
}

function AuditDetails({ details }: { details: Record<string, unknown> }) {
  const { t } = useTranslation("admin");
  const entries = Object.entries(details);
  if (entries.length === 0) {
    return <span className="text-xs text-text-4">{t("audit_no_details")}</span>;
  }
  return (
    <dl className="min-w-[240px] space-y-1.5 py-0.5 text-xs leading-5">
      {entries.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[minmax(76px,auto)_minmax(0,1fr)] gap-x-3 rounded-md bg-bg-grad-a/45 px-2.5 py-1.5">
          <dt className="text-text-4">{t(`audit_detail_${key}`, { defaultValue: key })}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words font-medium text-text-2">{formatAuditDetailValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function OperationLogsSection({ onError }: Pick<SectionProps, "onError">) {
  const { t } = useTranslation("admin");
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AdminAuditEvent | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [actorUsername, setActorUsername] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (targetPage = 1) => {
    setLoading(true);
    try {
      const response = await API.listAdminAuditEvents({ page: targetPage, pageSize: PAGE_SIZE, action, actorUsername });
      setEvents(response.events);
      setTotal(response.total);
      setPage(response.page);
    } catch (error) {
      onError(error instanceof Error ? error.message : t("request_failed"));
    } finally {
      setLoading(false);
    }
  }, [action, actorUsername, onError, t]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(1); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const actionLabels: Record<string, string> = { "system.users.create": "audit_op_user_create", "system.users.update": "audit_op_user_update", "system.users.reset_password": "audit_op_password_reset", "system.users.revoke_sessions": "audit_op_sessions_revoke", "system.sessions.revoke": "audit_op_session_revoke", "system.tasks.cancel": "audit_op_task_cancel", "system.tasks.retry": "audit_op_task_retry", "project.members.add": "audit_op_member_add", "project.members.update": "audit_op_member_update", "project.members.remove": "audit_op_member_remove", "project.transfer": "audit_op_project_transfer", "project.delete": "audit_op_project_delete" };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const detailSummary = (event: AdminAuditEvent) => {
    const entries = Object.entries(event.details);
    if (entries.length === 0) return t("audit_no_details");
    return entries.map(([key, value]) => `${t(`audit_detail_${key}`, { defaultValue: key })}: ${formatAuditDetailValue(value).replace(/\s+/g, " ")}`).join(" · ");
  };
  return (
    <>
      <SectionFrame icon={<FileClock className="h-4 w-4 text-accent-2" aria-hidden />} title={t("nav_logs")} description={t("logs_description")}>
        <form className="flex flex-wrap items-end gap-3 border-b border-hairline-soft p-5" onSubmit={(event) => { event.preventDefault(); void load(1); }}>
          <div className="w-full max-w-[320px]"><FieldLabel htmlFor="audit-action">{t("audit_action")}</FieldLabel><input id="audit-action" value={action} onChange={(event) => setAction(event.target.value)} className={INPUT_CLS} placeholder={t("audit_action_placeholder")} /></div>
          <div className="w-full max-w-[320px]"><FieldLabel htmlFor="audit-actor">{t("audit_actor")}</FieldLabel><input id="audit-actor" value={actorUsername} onChange={(event) => setActorUsername(event.target.value)} className={INPUT_CLS} placeholder={t("audit_actor_placeholder")} /></div>
          <button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-hairline-soft px-3 text-xs text-text-2 hover:border-accent/45 hover:text-text"><Search className="h-3.5 w-3.5" aria-hidden />{t("audit_filter")}</button>
        </form>
        {loading ? <LoadingState label={t("audit_loading")} /> : events.length === 0 ? <EmptyState label={t("audit_empty")} /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] table-fixed text-left text-xs">
                <thead className="border-b border-hairline-soft bg-bg-grad-a/50 text-text-4">
                  <tr>
                    <th className="w-14 px-5 py-3">{t("sequence")}</th>
                    <th className="w-40 px-5 py-3">{t("audit_time")}</th>
                    <th className="w-32 px-5 py-3">{t("audit_actor")}</th>
                    <th className="w-40 px-5 py-3">{t("audit_action")}</th>
                    <th className="w-36 px-5 py-3">{t("audit_resource")}</th>
                    <th className="w-72 px-5 py-3">{t("audit_details")}</th>
                    <th className="w-16 px-5 py-3 text-right">{t("actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline-soft">
                  {events.map((event, index) => (
                    <tr key={event.id}>
                      <td className="px-5 py-4 font-mono tabular-nums text-text-4">{rowNumber(page, index)}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-text-3">{formatDateTime(event.created_at)}</td>
                      <td className="truncate px-5 py-4 font-medium text-text-2" title={event.actor_username || undefined}>{event.actor_username || t("audit_system_actor")}</td>
                      <td className="truncate px-5 py-4 text-text-2" title={t(actionLabels[event.action] ?? "audit_op_unknown")}>{t(actionLabels[event.action] ?? "audit_op_unknown")}</td>
                      <td className="truncate px-5 py-4 text-text-3" title={event.project_name || event.resource_id || event.resource_type || undefined}>{event.project_name || event.resource_id || event.resource_type}</td>
                      <td className="px-5 py-4"><span className="block truncate text-text-3" title={detailSummary(event)}>{detailSummary(event)}</span></td>
                      <td className="px-5 py-4 text-right">
                        <button type="button" className="icon-button" title={t("view_details")} aria-label={t("view_details")} onClick={() => setSelectedEvent(event)}>
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pages={pages} onPageChange={(next) => void load(next)} totalCount={total} />
          </>
        )}
      </SectionFrame>

      <GlassModal open={selectedEvent !== null} onClose={() => setSelectedEvent(null)} labelledBy="admin-audit-detail-title" widthClassName="w-full max-w-[680px]" panelStyle={{ maxHeight: "min(720px, calc(100vh - 32px))" }}>
        {selectedEvent ? (
          <div className="flex min-h-0 flex-col" style={{ maxHeight: "min(720px, calc(100vh - 32px))" }}>
            <div className="flex items-start justify-between gap-4 border-b border-hairline-soft px-6 py-5">
              <div>
                <h2 id="admin-audit-detail-title" className="text-base font-semibold text-text">{t("audit_detail_title")}</h2>
                <p className="mt-1 font-mono text-[11px] text-text-4">#{selectedEvent.id}</p>
              </div>
              <button type="button" className="icon-button" title={t("common:close")} aria-label={t("common:close")} onClick={() => setSelectedEvent(null)}><X className="h-4 w-4" aria-hidden /></button>
            </div>
            <div className="min-h-0 overflow-y-auto p-6">
              <dl className="mb-5 grid gap-3 rounded-lg border border-hairline-soft bg-bg-grad-a/35 p-4 sm:grid-cols-2">
                <div><dt className="text-[11px] text-text-4">{t("audit_time")}</dt><dd className="mt-1 text-xs text-text-2">{formatDateTime(selectedEvent.created_at)}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("audit_actor")}</dt><dd className="mt-1 text-xs text-text-2">{selectedEvent.actor_username || t("audit_system_actor")}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("audit_action")}</dt><dd className="mt-1 text-xs text-text-2">{t(actionLabels[selectedEvent.action] ?? "audit_op_unknown")}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("audit_resource")}</dt><dd className="mt-1 break-words text-xs text-text-2">{selectedEvent.project_name || selectedEvent.resource_id || selectedEvent.resource_type}</dd></div>
              </dl>
              <h3 className="mb-2 text-xs font-semibold text-text-2">{t("audit_details")}</h3>
              <AuditDetails details={selectedEvent.details} />
            </div>
          </div>
        ) : null}
      </GlassModal>
    </>
  );
}

function LoginLogsSection({ onError }: Pick<SectionProps, "onError">) {
  const { t } = useTranslation("admin");
  const [events, setEvents] = useState<AdminLoginEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AdminLoginEvent | null>(null);
  const [username, setUsername] = useState("");
  const [outcome, setOutcome] = useState<AdminLoginOutcome | "">("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (targetPage = 1) => {
    setLoading(true);
    try {
      const response = await API.listAdminLoginEvents({
        page: targetPage,
        pageSize: PAGE_SIZE,
        username,
        outcome,
      });
      setEvents(response.events);
      setTotal(response.total);
      setPage(response.page);
    } catch (error) {
      onError(error instanceof Error ? error.message : t("request_failed"));
    } finally {
      setLoading(false);
    }
  }, [onError, outcome, t, username]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(1); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const outcomeLabel = (value: AdminLoginOutcome) => t(`login_outcome_${value}`);
  const reasonLabel = (value: string | null) => value
    ? t(`login_reason_${value}`, { defaultValue: value })
    : t("login_reason_none");
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <SectionFrame
        icon={<LogIn className="h-4 w-4 text-accent-2" aria-hidden />}
        title={t("login_logs_title")}
        description={t("login_logs_description")}
      >
        <form className="flex flex-wrap items-end gap-3 border-b border-hairline-soft p-5" onSubmit={(event) => { event.preventDefault(); void load(1); }}>
          <div className="w-full max-w-[320px]">
            <FieldLabel htmlFor="login-event-username">{t("username")}</FieldLabel>
            <input id="login-event-username" value={username} onChange={(event) => setUsername(event.target.value)} className={INPUT_CLS} placeholder={t("login_username_placeholder")} />
          </div>
          <div className="w-full max-w-[220px]">
            <FieldLabel htmlFor="login-event-outcome">{t("login_outcome")}</FieldLabel>
            <select id="login-event-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value as AdminLoginOutcome | "")} className={`${INPUT_CLS} appearance-none`}>
              <option value="">{t("login_outcome_all")}</option>
              <option value="success">{t("login_outcome_success")}</option>
              <option value="failure">{t("login_outcome_failure")}</option>
              <option value="rate_limited">{t("login_outcome_rate_limited")}</option>
            </select>
          </div>
          <button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-hairline-soft px-3 text-xs text-text-2 hover:border-accent/45 hover:text-text">
            <Search className="h-3.5 w-3.5" aria-hidden />{t("audit_filter")}
          </button>
        </form>
        {loading ? <LoadingState label={t("login_logs_loading")} /> : events.length === 0 ? <EmptyState label={t("login_logs_empty")} /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] table-fixed text-left text-xs">
                <thead className="border-b border-hairline-soft bg-bg-grad-a/50 text-text-4">
                  <tr>
                    <th className="w-14 px-5 py-3">{t("sequence")}</th>
                    <th className="w-40 px-5 py-3">{t("audit_time")}</th>
                    <th className="w-36 px-5 py-3">{t("username")}</th>
                    <th className="w-28 px-5 py-3">{t("login_outcome")}</th>
                    <th className="w-40 px-5 py-3">{t("login_reason")}</th>
                    <th className="w-36 px-5 py-3">{t("session_ip")}</th>
                    <th className="w-64 px-5 py-3">{t("session_agent")}</th>
                    <th className="w-16 px-5 py-3 text-right">{t("actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline-soft">
                  {events.map((event, index) => (
                    <tr key={event.id}>
                      <td className="px-5 py-4 font-mono tabular-nums text-text-4">{rowNumber(page, index)}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-text-3">{formatDateTime(event.created_at)}</td>
                      <td className="truncate px-5 py-4 font-medium text-text-2" title={event.username || undefined}>{event.username || t("login_unknown_username")}</td>
                      <td className="px-5 py-4"><StatusBadge status={event.outcome === "success" ? "succeeded" : event.outcome === "failure" ? "failed" : "rate_limited"} label={outcomeLabel(event.outcome)} /></td>
                      <td className="truncate px-5 py-4 text-text-3" title={reasonLabel(event.reason)}>{reasonLabel(event.reason)}</td>
                      <td className="truncate px-5 py-4 font-mono text-text-3" title={event.ip_address || undefined}>{event.ip_address || "-"}</td>
                      <td className="truncate px-5 py-4 text-text-3" title={event.user_agent || undefined}>{event.user_agent || "-"}</td>
                      <td className="px-5 py-4 text-right">
                        <button type="button" className="icon-button" title={t("view_details")} aria-label={t("view_details")} onClick={() => setSelectedEvent(event)}>
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pages={pages} onPageChange={(next) => void load(next)} totalCount={total} />
          </>
        )}
      </SectionFrame>

      <GlassModal open={selectedEvent !== null} onClose={() => setSelectedEvent(null)} labelledBy="admin-login-event-detail-title" widthClassName="w-full max-w-[680px]" panelStyle={{ maxHeight: "min(720px, calc(100vh - 32px))" }}>
        {selectedEvent ? (
          <div className="flex min-h-0 flex-col" style={{ maxHeight: "min(720px, calc(100vh - 32px))" }}>
            <div className="flex items-start justify-between gap-4 border-b border-hairline-soft px-6 py-5">
              <div>
                <h2 id="admin-login-event-detail-title" className="text-base font-semibold text-text">{t("login_event_detail_title")}</h2>
                <p className="mt-1 font-mono text-[11px] text-text-4">#{selectedEvent.id}</p>
              </div>
              <button type="button" className="icon-button" title={t("common:close")} aria-label={t("common:close")} onClick={() => setSelectedEvent(null)}><X className="h-4 w-4" aria-hidden /></button>
            </div>
            <div className="min-h-0 overflow-y-auto p-6">
              <dl className="grid gap-3 rounded-lg border border-hairline-soft bg-bg-grad-a/35 p-4 sm:grid-cols-2">
                <div><dt className="text-[11px] text-text-4">{t("audit_time")}</dt><dd className="mt-1 text-xs text-text-2">{formatDateTime(selectedEvent.created_at)}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("username")}</dt><dd className="mt-1 break-words text-xs text-text-2">{selectedEvent.username || t("login_unknown_username")}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("login_outcome")}</dt><dd className="mt-1 text-xs text-text-2">{outcomeLabel(selectedEvent.outcome)}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("login_reason")}</dt><dd className="mt-1 break-words text-xs text-text-2">{reasonLabel(selectedEvent.reason)}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("session_ip")}</dt><dd className="mt-1 break-words font-mono text-xs text-text-2">{selectedEvent.ip_address || "-"}</dd></div>
                <div><dt className="text-[11px] text-text-4">{t("session_device")}</dt><dd className="mt-1 break-words font-mono text-xs text-text-2">{selectedEvent.device_id || "-"}</dd></div>
                <div className="sm:col-span-2"><dt className="text-[11px] text-text-4">{t("session_agent")}</dt><dd className="mt-1 break-words text-xs text-text-2">{selectedEvent.user_agent || "-"}</dd></div>
                <div className="sm:col-span-2"><dt className="text-[11px] text-text-4">{t("login_endpoint")}</dt><dd className="mt-1 break-words font-mono text-xs text-text-2">{selectedEvent.endpoint}</dd></div>
              </dl>
            </div>
          </div>
        ) : null}
      </GlassModal>
    </>
  );
}

function LogsSection({ onError }: Pick<SectionProps, "onError">) {
  const { t } = useTranslation("admin");
  const [view, setView] = useState<"operations" | "logins">("operations");
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-hairline-soft bg-bg-grad-a/45 p-1" role="tablist" aria-label={t("logs_view_label")}>
        <button type="button" role="tab" aria-selected={view === "operations"} onClick={() => setView("operations")} className={`inline-flex min-h-9 items-center gap-2 rounded px-3 text-xs transition-colors ${view === "operations" ? "bg-accent/15 font-medium text-accent-2" : "text-text-3 hover:text-text"}`}>
          <FileClock className="h-3.5 w-3.5" aria-hidden />{t("operation_logs_tab")}
        </button>
        <button type="button" role="tab" aria-selected={view === "logins"} onClick={() => setView("logins")} className={`inline-flex min-h-9 items-center gap-2 rounded px-3 text-xs transition-colors ${view === "logins" ? "bg-accent/15 font-medium text-accent-2" : "text-text-3 hover:text-text"}`}>
          <LogIn className="h-3.5 w-3.5" aria-hidden />{t("login_logs_tab")}
        </button>
      </div>
      {view === "operations" ? <OperationLogsSection onError={onError} /> : <LoginLogsSection onError={onError} />}
    </div>
  );
}

function TasksSection({ onError, onNotice }: Pick<SectionProps, "onError" | "onNotice">) {
  const { t } = useTranslation("admin"); const [tasks, setTasks] = useState<TaskItem[]>([]); const [stats, setStats] = useState<{ queued?: number; running?: number; failed?: number; total?: number }>({}); const [status, setStatus] = useState(""); const [projectName, setProjectName] = useState(""); const [taskType, setTaskType] = useState(""); const [page, setPage] = useState(1); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true);
  const load = useCallback(async (targetPage = 1) => { setLoading(true); try { const [response, statResponse] = await Promise.all([API.listAdminTasks({ page: targetPage, pageSize: PAGE_SIZE, status, projectName, taskType }), API.getAdminTaskStats()]); setTasks(response.items); setTotal(response.total); setPage(response.page); setStats(statResponse.stats); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } finally { setLoading(false); } }, [onError, projectName, status, t, taskType]); useEffect(() => { const timer = window.setTimeout(() => { void load(1); }, 0); return () => window.clearTimeout(timer); }, [load]); const cancel = async (task: TaskItem) => { try { await API.cancelAdminTask(task.task_id); onNotice(t("task_cancelled")); await load(); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } }; const retry = async (task: TaskItem) => { try { await API.retryAdminTask(task.task_id); onNotice(t("task_retried")); await load(); } catch (error) { onError(error instanceof Error ? error.message : t("request_failed")); } }; const statusLabel: Record<TaskStatus, string> = { queued: t("task_queued"), running: t("task_running"), cancelling: t("task_cancelling"), succeeded: t("task_succeeded"), failed: t("task_failed"), cancelled: t("task_cancelled_status") }; const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return <SectionFrame icon={<ClipboardList className="h-4 w-4 text-accent-2" aria-hidden />} title={t("nav_tasks")} description={t("tasks_description")} action={<button type="button" onClick={() => void load()} className="icon-button" title={t("refresh")} aria-label={t("refresh")}><RefreshCw className="h-4 w-4" aria-hidden /></button>}><div className="grid grid-cols-2 gap-px border-b border-hairline-soft bg-hairline-soft sm:grid-cols-4">{[["queued", stats.queued], ["running", stats.running], ["failed", stats.failed], ["total", stats.total]].map(([key, value]) => <div key={key} className="bg-bg p-4"><div className="text-[10px] uppercase tracking-[0.12em] text-text-4">{t(`task_${key}`)}</div><div className="mt-1 font-mono text-xl text-text">{value ?? 0}</div></div>)}</div><form className="flex flex-wrap items-end gap-3 border-b border-hairline-soft p-5" onSubmit={(event) => { event.preventDefault(); void load(1); }}><div className="w-full max-w-[320px]"><FieldLabel htmlFor="task-project">{t("audit_project")}</FieldLabel><input id="task-project" value={projectName} onChange={(event) => setProjectName(event.target.value)} className={INPUT_CLS} placeholder={t("task_project_placeholder")} /></div><div className="w-full max-w-[320px]"><FieldLabel htmlFor="task-type">{t("task_type")}</FieldLabel><input id="task-type" value={taskType} onChange={(event) => setTaskType(event.target.value)} className={INPUT_CLS} placeholder={t("task_type_placeholder")} /></div><div className="w-full max-w-[220px]"><FieldLabel htmlFor="task-status">{t("status")}</FieldLabel><select id="task-status" value={status} onChange={(event) => setStatus(event.target.value)} className={`${INPUT_CLS} appearance-none`}><option value="">{t("task_all_statuses")}</option>{(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"] as const).map((item) => <option key={item} value={item}>{statusLabel[item]}</option>)}</select></div><button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-hairline-soft px-3 text-xs text-text-2 hover:border-accent/45 hover:text-text"><Search className="h-3.5 w-3.5" aria-hidden />{t("audit_filter")}</button></form>{loading ? <LoadingState label={t("tasks_loading")} /> : tasks.length === 0 ? <EmptyState label={t("tasks_empty")} /> : <><div className="overflow-x-auto"><table className="w-full min-w-[1040px] text-left text-xs"><thead className="border-b border-hairline-soft bg-bg-grad-a/50 text-text-4"><tr><th className="w-16 px-5 py-3">{t("sequence")}</th><th className="px-5 py-3">{t("task_id")}</th><th className="px-5 py-3">{t("audit_project")}</th><th className="px-5 py-3">{t("task_type")}</th><th className="px-5 py-3">{t("status")}</th><th className="px-5 py-3">{t("task_updated")}</th><th className="px-5 py-3 text-right">{t("actions")}</th></tr></thead><tbody className="divide-y divide-hairline-soft">{tasks.map((task, index) => <tr key={task.task_id}><td className="px-5 py-4 font-mono tabular-nums text-text-4">{rowNumber(page, index)}</td><td className="max-w-[220px] truncate px-5 py-4 font-mono text-text-3" title={task.task_id}>{task.task_id}</td><td className="max-w-[190px] truncate px-5 py-4 text-text-2">{task.project_name}</td><td className="px-5 py-4 text-text-3">{task.task_type}</td><td className="px-5 py-4"><StatusBadge status={task.status} label={statusLabel[task.status]} /></td><td className="whitespace-nowrap px-5 py-4 text-text-4">{formatDateTime(task.updated_at)}</td><td className="px-5 py-4"><div className="flex justify-end gap-2">{["queued", "running", "cancelling"].includes(task.status) ? <button type="button" onClick={() => void cancel(task)} title={t("task_cancel_action")} aria-label={t("task_cancel_action")} className="icon-button"><X className="h-3.5 w-3.5" aria-hidden /></button> : null}{["failed", "cancelled"].includes(task.status) ? <button type="button" onClick={() => void retry(task)} title={t("task_retry_action")} aria-label={t("task_retry_action")} className="icon-button"><RefreshCw className="h-3.5 w-3.5" aria-hidden /></button> : null}</div></td></tr>)}</tbody></table></div><Pagination page={page} pages={pages} onPageChange={(next) => void load(next)} totalCount={total} /></>}</SectionFrame>;
}

function StatusBadge({ status, label }: { status: string; label: string }) { return <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] ${status === "active" || status === "succeeded" ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : status === "failed" ? "border-red-400/25 bg-red-400/10 text-red-200" : "border-hairline-soft bg-bg-grad-a/40 text-text-3"}`}>{label}</span>; }
function LoadingState({ label }: { label: string }) { return <div className="flex items-center justify-center gap-2 p-12 text-sm text-text-3"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />{label}</div>; }
function EmptyState({ label }: { label: string }) { return <div className="p-12 text-center text-sm text-text-4">{label}</div>; }
function getPageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const candidates = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = [...candidates].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const page of sorted) {
    if (page - previous > 1) items.push("ellipsis");
    items.push(page);
    previous = page;
  }
  return items;
}

function Pagination({ page, pages, totalCount, onPageChange }: { page: number; pages: number; totalCount?: number; onPageChange: (page: number) => void }) {
  const { t } = useTranslation("admin");
  const items = getPageItems(page, pages);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline-soft px-5 py-3">
      <span className="font-mono text-[11px] text-text-3">{totalCount !== undefined ? t("pagination_total", { total: totalCount }) : ""}</span>
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(1)} className="icon-button" title={t("first_page")} aria-label={t("first_page")}><ChevronsLeft className="h-4 w-4" aria-hidden /></button>
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="icon-button" title={t("previous_page")} aria-label={t("previous_page")}><ChevronLeft className="h-4 w-4" aria-hidden /></button>
        {items.map((item, index) => (item === "ellipsis" ? (
          <span key={`ellipsis-${index}`} className="px-1 text-[11px] text-text-4" aria-hidden>…</span>
        ) : (
          <button
            key={item}
            type="button"
            disabled={item === page}
            aria-current={item === page ? "page" : undefined}
            onClick={() => onPageChange(item)}
            className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 font-mono text-[11.5px] transition-colors ${item === page ? "border-accent/40 bg-accent/15 text-accent-2" : "border-hairline-soft text-text-3 hover:border-accent/45 hover:text-text"}`}
          >
            {item}
          </button>
        )))}
        <button type="button" disabled={page >= pages} onClick={() => onPageChange(page + 1)} className="icon-button" title={t("next_page")} aria-label={t("next_page")}><ChevronRight className="h-4 w-4" aria-hidden /></button>
        <button type="button" disabled={page >= pages} onClick={() => onPageChange(pages)} className="icon-button" title={t("last_page")} aria-label={t("last_page")}><ChevronsRight className="h-4 w-4" aria-hidden /></button>
      </div>
    </div>
  );
}
function SectionFrame({ icon, title, description, action, children }: { icon: ReactNode; title: string; description: string; action?: ReactNode; children: ReactNode }) { return <section className="overflow-hidden rounded-lg border border-hairline-soft" style={CARD_STYLE}><div className="flex flex-wrap items-start justify-between gap-4 border-b border-hairline-soft px-5 py-4"><div className="min-w-0"><div className="flex items-center gap-2 text-[15px] font-semibold text-text">{icon}{title}</div><p className="mt-1 max-w-2xl text-[12.5px] leading-5 text-text-3">{description}</p></div>{action}</div>{children}</section>; }

export function AdminManagerPage({ section = "users" }: { section?: AdminSection }) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const [, navigate] = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isAuthLoading = useAuthStore((state) => state.isLoading);
  const role = useAuthStore((state) => state.role);
  const logout = useAuthStore((state) => state.logout);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await sessionFetch(`/api/v1${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Accept-Language": i18n.language || "zh",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) throw await readError(response, t("request_failed"));
    return response;
  }, [i18n.language, t]);
  useEffect(() => {
    if (!isAuthLoading && (!isAuthenticated || role !== "admin")) {
      navigate(`${ROUTE_ADMIN_LOGIN}?from=${encodeURIComponent(`${ROUTE_ADMIN_MANAGER}/${section}`)}`);
    }
  }, [isAuthenticated, isAuthLoading, navigate, role, section]);
  const onError = useCallback((message: string) => {
    useAppStore.getState().pushToast(message, "error");
  }, []);
  const onNotice = useCallback((message: string) => {
    useAppStore.getState().pushToast(message, "success");
  }, []);
  const confirmLogout = () => {
    setLogoutConfirmOpen(false);
    logout();
    navigate(ROUTE_ADMIN_LOGIN);
  };
  const items = useMemo(() => [{ section: "users" as const, href: ROUTE_ADMIN_USERS, icon: UserRound, label: t("nav_users") }, { section: "sessions" as const, href: ROUTE_ADMIN_SESSIONS, icon: Laptop, label: t("nav_sessions") }, { section: "logs" as const, href: ROUTE_ADMIN_LOGS, icon: FileClock, label: t("nav_logs") }, { section: "tasks" as const, href: ROUTE_ADMIN_TASKS, icon: ClipboardList, label: t("nav_tasks") }], [t]);
  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="app-topbar-surface sticky top-0 z-30">
        <div className="app-topbar-inner flex w-full items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-accent/25 bg-accent/10 text-accent-2">
              <ShieldCheck className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold text-text">{t("manager_title")}</h1>
              <p className="hidden truncate text-[11.5px] text-text-4 sm:block">{t("manager_subtitle")}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={ROUTE_APP}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-3 text-[11.5px] font-medium text-accent-2 transition-colors hover:border-accent/45 hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t("back_to_workspace")}</span>
            </Link>
            <button
              type="button"
              onClick={() => setLogoutConfirmOpen(true)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] text-text-3 transition-colors hover:bg-warm-tint-faint hover:text-warm-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t("common:logout")}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex w-full">
        <aside
          className={`sticky top-[60px] flex h-[calc(100vh-60px)] w-[64px] shrink-0 flex-col border-r border-hairline-strong bg-bg-grad-b shadow-[6px_0_18px_-16px_rgba(0,0,0,0.95)] transition-[width] duration-200 motion-reduce:transition-none sm:w-60 ${sidebarCollapsed ? "lg:w-[72px]" : "lg:w-60"}`}
        >
          <div className={`flex h-14 shrink-0 items-center justify-center border-b border-hairline-strong px-3 sm:justify-between ${sidebarCollapsed ? "lg:justify-center" : ""}`}>
            <div className={`hidden min-w-0 sm:block ${sidebarCollapsed ? "lg:hidden" : ""}`}>
              <p className="truncate text-xs font-semibold text-text-2">{t("admin_portal")}</p>
            </div>
            <button
              type="button"
              className="icon-button hidden lg:inline-flex"
              title={sidebarCollapsed ? t("expand_navigation") : t("collapse_navigation")}
              aria-label={sidebarCollapsed ? t("expand_navigation") : t("collapse_navigation")}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden /> : <PanelLeftClose className="h-4 w-4" aria-hidden />}
            </button>
            <ShieldCheck className="h-4 w-4 text-accent-2 lg:hidden" aria-hidden />
          </div>
          <nav className="flex-1 space-y-1 p-2 sm:p-3" aria-label={t("admin_navigation")}>
            {items.map((item) => {
              const Icon = item.icon;
              const active = item.section === section;
              return (
                <Link
                  key={item.section}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  className={`flex min-h-10 items-center justify-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:justify-start sm:gap-3 sm:px-3 ${sidebarCollapsed ? "lg:justify-center lg:px-0" : ""} ${active ? "border border-accent/25 bg-accent/12 font-medium text-accent-2" : "border border-transparent text-text-3 hover:bg-bg-grad-b hover:text-text"}`}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className={`hidden sm:inline ${sidebarCollapsed ? "lg:hidden" : ""}`}>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-6 2xl:px-10">
          <div className="w-full">
            {section === "users" ? <UsersSection request={request} onError={onError} onNotice={onNotice} /> : section === "sessions" ? <SessionsSection onError={onError} onNotice={onNotice} /> : section === "logs" ? <LogsSection onError={onError} /> : <TasksSection onError={onError} onNotice={onNotice} />}
          </div>
        </main>
      </div>

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
    </div>
  );
}
