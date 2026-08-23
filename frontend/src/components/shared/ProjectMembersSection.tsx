import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Eye, Loader2, PencilLine, ShieldCheck, Trash2, UserPlus, UserRound, Users, UserRoundCog, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import type { ProjectMember, ProjectMemberCandidate, ProjectMemberRole, ProjectRef } from "@/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { GlassModal } from "@/components/ui/GlassModal";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { SecondaryButton } from "@/components/ui/SecondaryButton";
import { ACCENT_BTN_CLS, ACCENT_BUTTON_STYLE, DROPDOWN_PANEL_STYLE } from "@/components/ui/darkroom-tokens";

interface ProjectMembersSectionProps {
  project: ProjectRef;
  currentRole?: ProjectMemberRole | null;
}

type PendingAction =
  | { kind: "remove"; member: ProjectMember }
  | { kind: "transfer"; username: string }
  | null;

const editableRoles: Array<Exclude<ProjectMemberRole, "owner">> = ["editor", "viewer"];

function ProjectRoleSelect({
  value,
  onChange,
  disabled = false,
  compact = false,
  className = "",
}: {
  value: Exclude<ProjectMemberRole, "owner">;
  onChange: (role: Exclude<ProjectMemberRole, "owner">) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("dashboard");
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

  const options = editableRoles.map((item) => ({ value: item, label: t(`project_role_${item}`) }));
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        ref={buttonRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected.label}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            updateMenuPosition();
            setOpen(true);
          }
        }}
        className={`inline-flex w-full items-center justify-between gap-1.5 rounded-md border border-hairline-soft bg-bg-grad-a/55 text-left text-text outline-none transition-colors hover:border-accent/45 focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-60 disabled:hover:border-hairline-soft ${compact ? "min-h-[30px] px-2 py-1 text-[11px]" : "min-h-9 px-2.5 py-1.5 text-xs"}`}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {value === "editor" ? (
            <PencilLine className="h-3.5 w-3.5 shrink-0 text-accent-2" aria-hidden />
          ) : (
            <Eye className="h-3.5 w-3.5 shrink-0 text-text-4" aria-hidden />
          )}
          <span className="truncate">{selected.label}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={t("project_member_role")}
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
                  {option.value === "editor" ? (
                    <PencilLine className="h-3.5 w-3.5 text-accent-2" aria-hidden />
                  ) : (
                    <Eye className="h-3.5 w-3.5 text-text-4" aria-hidden />
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

function AddMemberDialog({
  open,
  candidates,
  loading,
  error,
  selectedIds,
  role,
  busy,
  onToggleSelected,
  onRoleChange,
  onAdd,
  onClose,
}: {
  open: boolean;
  candidates: ProjectMemberCandidate[];
  loading: boolean;
  error: string;
  selectedIds: Set<string>;
  role: Exclude<ProjectMemberRole, "owner">;
  busy: boolean;
  onToggleSelected: (next: Set<string>) => void;
  onRoleChange: (role: Exclude<ProjectMemberRole, "owner">) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const titleId = useId();

  const toggleCandidate = (userId: string) => {
    const next = new Set(selectedIds);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    onToggleSelected(next);
  };

  return (
    <GlassModal open={open} onClose={onClose} labelledBy={titleId} widthClassName="w-full max-w-lg">
      <div className="px-6 pb-6 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="display-serif text-[17px] font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>{t("project_member_add_title")}</h2>
            <p className="mt-1 text-[12px] text-text-3">{t("project_member_add_hint")}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t("common:close")} className="rounded-md border border-hairline-soft p-1.5 text-text-4 transition-colors hover:border-hairline-strong hover:text-text disabled:opacity-50"><X className="h-4 w-4" aria-hidden /></button>
        </div>

        <div className="mt-4">
          {loading ? (
            <div className="flex items-center gap-2 rounded-lg border border-hairline-soft px-3 py-4 text-[12px] text-text-3"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />{t("project_members_loading")}</div>
          ) : error ? (
            <p role="alert" className="rounded-md border border-warm/30 bg-warm/10 px-3 py-2 text-[12px] text-warm-bright">{error}</p>
          ) : candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-hairline-soft px-3 py-5 text-center text-[12px] text-text-4">{t("project_member_candidates_empty")}</div>
          ) : (
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-hairline-soft p-1.5">
              {candidates.map((candidate) => {
                const displayName = candidate.nickname || candidate.username;
                const avatarUrl = candidate.avatar_path ? API.getAvatarUrl(candidate.avatar_path, candidate.avatar_path) : null;
                const checked = selectedIds.has(candidate.user_id);
                return (
                  <button type="button" key={candidate.user_id} onClick={() => toggleCandidate(candidate.user_id)} aria-pressed={checked} className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${checked ? "bg-accent/10" : "hover:bg-bg-grad-a/50"}`}>
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${checked ? "border-accent bg-accent/20 text-accent-2" : "border-hairline-strong bg-bg-grad-a/60 text-transparent"}`}>{checked && <Check className="h-3.5 w-3.5" aria-hidden />}</span>
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full border border-hairline object-cover" />
                    ) : (
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-hairline bg-bg-grad-a/60 text-[10px] font-semibold text-text-3">{displayName.slice(0, 1).toUpperCase()}</span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-text">{displayName}</span>
                      <span className="block truncate text-[10.5px] text-text-4">@{candidate.username}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-4">
          <span className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-4">{t("project_member_role")}</span>
          <ProjectRoleSelect value={role} onChange={onRoleChange} />
          <p className="mt-1.5 text-[11px] leading-5 text-text-4">{role === "editor" ? t("project_role_editor_hint") : t("project_role_viewer_hint")}</p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-text-4">{t("project_member_selected_count", { count: selectedIds.size })}</p>
          <div className="flex gap-2">
            <SecondaryButton size="sm" onClick={onClose} disabled={busy}>{t("common:cancel")}</SecondaryButton>
            <PrimaryButton size="sm" onClick={onAdd} disabled={busy || selectedIds.size === 0} leadingIcon={busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <UserPlus className="h-3.5 w-3.5" aria-hidden />}>
              {busy ? t("project_members_saving") : t("project_member_add_selected", { count: selectedIds.size })}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </GlassModal>
  );
}

function TransferOwnerDialog({
  open,
  members,
  selectedId,
  busy,
  onSelect,
  onConfirm,
  onClose,
}: {
  open: boolean;
  members: ProjectMember[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (userId: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const titleId = useId();
  const candidates = members.filter((member) => !member.is_owner);

  return (
    <GlassModal open={open} onClose={onClose} labelledBy={titleId} widthClassName="w-full max-w-lg">
      <div className="px-6 pb-6 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="display-serif text-[17px] font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>{t("project_owner_transfer_title")}</h2>
            <p className="mt-1 text-[12px] text-text-3">{t("project_owner_transfer_hint")}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t("common:close")} className="rounded-md border border-hairline-soft p-1.5 text-text-4 transition-colors hover:border-hairline-strong hover:text-text disabled:opacity-50"><X className="h-4 w-4" aria-hidden /></button>
        </div>

        <div className="mt-4">
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-hairline-soft px-3 py-5 text-center text-[12px] text-text-4">{t("project_owner_transfer_empty")}</div>
          ) : (
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-hairline-soft p-1.5">
              {candidates.map((member) => {
                const checked = member.user_id === selectedId;
                return (
                  <button type="button" key={member.user_id} onClick={() => onSelect(member.user_id)} aria-pressed={checked} className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${checked ? "bg-accent/10" : "hover:bg-bg-grad-a/50"}`}>
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${checked ? "border-accent bg-accent/20" : "border-hairline-strong bg-bg-grad-a/60"}`}>{checked && <span className="h-1.5 w-1.5 rounded-full bg-accent-2" />}</span>
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-hairline bg-bg-grad-a/60 text-[10px] font-semibold text-text-3"><UserRound className="h-3.5 w-3.5 text-text-4" aria-hidden /></span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-text">{member.username}</span>
                    <span className="text-[10.5px] text-text-4">{member.role === "editor" ? t("project_role_editor") : t("project_role_viewer")}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <SecondaryButton size="sm" onClick={onClose} disabled={busy}>{t("common:cancel")}</SecondaryButton>
          <PrimaryButton size="sm" onClick={onConfirm} disabled={busy || !selectedId} leadingIcon={busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : <Users className="h-3.5 w-3.5" aria-hidden />}>
            {busy ? t("project_members_saving") : t("project_owner_transfer")}
          </PrimaryButton>
        </div>
      </div>
    </GlassModal>
  );
}

export function ProjectMembersSection({ project, currentRole }: ProjectMembersSectionProps) {
  const { t } = useTranslation("dashboard");
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [candidates, setCandidates] = useState<ProjectMemberCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dialogRole, setDialogRole] = useState<Exclude<ProjectMemberRole, "owner">>("viewer");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [ownershipTransferred, setOwnershipTransferred] = useState(false);

  const canManage = currentRole === "owner" && !ownershipTransferred;

  const loadMembers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await API.listProjectMembers(project);
      setMembers(result.members);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("project_members_request_failed"));
    } finally {
      setLoading(false);
    }
  }, [project, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMembers(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMembers]);

  const runMutation = async (operation: () => Promise<void>, successMessage: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await loadMembers();
      setNotice(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("project_members_request_failed"));
    } finally {
      setBusy(false);
    }
  };

  const openAddDialog = async () => {
    setCandidatesError("");
    setSelectedIds(new Set());
    setDialogRole("viewer");
    setShowAddDialog(true);
    // 每次打开都重新拉取候选：确保已加入的成员从列表中被过滤，避免旧缓存
    setCandidatesLoading(true);
    try {
      const result = await API.listProjectMemberCandidates(project);
      setCandidates(result.candidates);
    } catch (err) {
      setCandidatesError(err instanceof Error ? err.message : t("project_members_request_failed"));
    } finally {
      setCandidatesLoading(false);
    }
  };

  const submitAddMembers = async () => {
    if (selectedIds.size === 0 || dialogBusy) return;
    setDialogBusy(true);
    setCandidatesError("");
    try {
      await API.addProjectMember(project, Array.from(selectedIds), dialogRole);
      setShowAddDialog(false);
      setSelectedIds(new Set());
      setNotice(t("project_member_added"));
      await loadMembers();
    } catch (err) {
      setCandidatesError(err instanceof Error ? err.message : t("project_members_request_failed"));
    } finally {
      setDialogBusy(false);
    }
  };

  const updateMember = async (member: ProjectMember, nextRole: Exclude<ProjectMemberRole, "owner">) => {
    await runMutation(
      () => API.updateProjectMember(project, member.user_id, nextRole).then(() => undefined),
      t("project_member_updated"),
    );
  };

  const removeMember = async (member: ProjectMember) => {
    setPendingAction(null);
    await runMutation(
      () => API.removeProjectMember(project, member.user_id).then(() => undefined),
      t("project_member_removed"),
    );
  };

  const transferOwner = async (targetUsername: string) => {
    setPendingAction(null);
    await runMutation(
      () => API.transferProjectOwner(project, targetUsername).then(() => undefined),
      t("project_owner_transferred"),
    );
    setOwnershipTransferred(true);
    setShowTransferDialog(false);
    setTransferTargetId(null);
  };

  const confirmTransferSelection = () => {
    if (!transferTargetId) return;
    const target = members.find((member) => member.user_id === transferTargetId);
    if (!target || target.is_owner) return;
    setShowTransferDialog(false);
    setTransferTargetId(null);
    setPendingAction({ kind: "transfer", username: target.username });
  };

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="rounded-md border border-warm/30 bg-warm/10 px-3 py-2 text-[12px] text-warm-bright">{error}</p> : null}
      {notice ? <p role="status" className="rounded-md border border-accent/25 bg-accent/10 px-3 py-2 text-[12px] text-accent-2">{notice}</p> : null}

      {canManage ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-hairline-soft bg-bg-grad-a/30 p-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-text">{t("project_member_add_title")}</p>
            <p className="text-[11px] text-text-4">{t("project_member_add_hint")}</p>
          </div>
          <button type="button" disabled={busy} onClick={() => void openAddDialog()} className={`${ACCENT_BTN_CLS} shrink-0 justify-center`} style={ACCENT_BUTTON_STYLE}>
            <UserPlus className="h-3.5 w-3.5" aria-hidden />
            {t("project_member_add")}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-5 text-[12px] text-text-3"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />{t("project_members_loading")}</div>
      ) : members.length ? (
        <div className="overflow-x-auto rounded-[9px] border border-hairline-soft">
          <table className="w-full min-w-[400px] table-fixed text-left text-[12px]">
            <thead className="border-b border-hairline-soft bg-bg-grad-a/35 text-[10px] uppercase tracking-[0.12em] text-text-4">
              <tr><th className="px-3 py-2.5">{t("project_member_account")}</th><th className="w-[160px] px-3 py-2.5">{t("project_member_role")}</th><th className="w-[96px] px-3 py-2.5 text-right">{t("project_member_actions")}</th></tr>
            </thead>
            <tbody className="divide-y divide-hairline-soft">
              {members.map((member) => (
                <tr key={member.user_id}>
                  <td className="px-3 py-3"><span className="inline-flex min-w-0 max-w-full items-center gap-2 text-text"><UserRound className="h-3.5 w-3.5 shrink-0 text-text-4" aria-hidden /><span className="truncate" title={member.username}>{member.username}</span></span></td>
                  <td className="px-3 py-3">
                    {member.is_owner ? (
                      <span className="inline-flex items-center gap-1.5 text-accent-2"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t("project_role_owner")}</span>
                    ) : (
                      <ProjectRoleSelect
                        compact
                        disabled={!canManage || busy}
                        value={member.role === "owner" ? "viewer" : member.role}
                        onChange={(nextRole) => void updateMember(member, nextRole)}
                        className="inline-block w-[130px]"
                      />
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">{canManage && !member.is_owner ? <button type="button" disabled={busy} onClick={() => setPendingAction({ kind: "remove", member })} className="inline-flex items-center gap-1.5 rounded-md border border-hairline-soft px-2 py-1.5 text-[11px] text-text-3 hover:border-warm/40 hover:text-warm-bright disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("project_member_remove")}</button> : <span className="text-text-4">{t("project_member_no_action")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="rounded-[9px] border border-dashed border-hairline-soft px-3 py-5 text-center text-[12px] text-text-4">{t("project_members_empty")}</div>}

      {canManage ? (
        <div className="rounded-[9px] border border-warm/20 bg-warm/5 p-3">
          <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-text"><UserRoundCog className="h-3.5 w-3.5 text-warm-bright" aria-hidden />{t("project_owner_transfer_title")}</div>
          <p className="text-[11px] leading-5 text-text-4">{t("project_owner_transfer_hint")}</p>
          <button type="button" disabled={busy} onClick={() => { setTransferTargetId(null); setShowTransferDialog(true); }} className="mt-2 inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-warm/35 px-3 py-2 text-[11px] text-warm-bright hover:bg-warm/10 disabled:opacity-50"><Users className="h-3.5 w-3.5" aria-hidden />{t("project_owner_transfer")}</button>
        </div>
      ) : null}

      <AddMemberDialog
        open={showAddDialog}
        candidates={candidates}
        loading={candidatesLoading}
        error={candidatesError}
        selectedIds={selectedIds}
        role={dialogRole}
        busy={dialogBusy}
        onToggleSelected={setSelectedIds}
        onRoleChange={setDialogRole}
        onAdd={() => void submitAddMembers()}
        onClose={() => {
          if (!dialogBusy) setShowAddDialog(false);
        }}
      />

      <TransferOwnerDialog
        open={showTransferDialog}
        members={members}
        selectedId={transferTargetId}
        busy={busy}
        onSelect={setTransferTargetId}
        onConfirm={confirmTransferSelection}
        onClose={() => {
          if (!busy) setShowTransferDialog(false);
        }}
      />

      <ConfirmDialog
        open={pendingAction !== null}
        tone="danger"
        title={pendingAction?.kind === "transfer" ? t("project_owner_transfer_confirm_title") : t("project_member_remove_confirm_title")}
        description={pendingAction?.kind === "transfer" ? t("project_owner_transfer_confirm_description", { username: pendingAction.username }) : pendingAction ? t("project_member_remove_confirm_description", { username: pendingAction.member.username }) : undefined}
        confirmLabel={pendingAction?.kind === "transfer" ? t("project_owner_transfer") : t("project_member_remove")}
        loadingLabel={t("project_members_saving")}
        cancelLabel={t("common:cancel")}
        loading={busy}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => pendingAction?.kind === "transfer" ? transferOwner(pendingAction.username) : pendingAction ? removeMember(pendingAction.member) : undefined}
      />
    </div>
  );
}
