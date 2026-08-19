import { useMemo, useState } from "react";
import { ChevronDown, Clock3, History, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FreeCreation } from "@/types";

interface FreeCreationSessionSummaryProps {
  creations: FreeCreation[];
}

function statusKey(status: FreeCreation["status"]): string {
  return `free_creation_status_${status}`;
}

export function FreeCreationSessionSummary({ creations }: FreeCreationSessionSummaryProps) {
  const { t } = useTranslation("dashboard");
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const requests = useMemo(() => {
    const groups = new Map<string, FreeCreation[]>();
    creations.forEach((creation) => {
      const requestId = creation.request_id ?? creation.creation_id;
      const group = groups.get(requestId) ?? [];
      group.push(creation);
      groups.set(requestId, group);
    });
    return [...groups.entries()]
      .map(([requestId, items]) => ({
        requestId,
        items: [...items].sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? "")),
      }))
      .sort((left, right) => (right.items[0]?.updated_at ?? "").localeCompare(left.items[0]?.updated_at ?? ""));
  }, [creations]);
  const latest = requests[0]?.items[0] ?? null;

  return (
    <div className="absolute left-4 top-4 z-30 w-[min(360px,calc(100vw-2rem))]" data-testid="free-creation-session-summary">
      <div className="border border-[var(--color-hairline)] bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-lg">
        <div className="flex items-start gap-3 px-3 py-2.5">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-2)]" aria-hidden />
          <button type="button" className="focus-ring min-w-0 flex-1 text-left" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
            <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("free_creation_session_summary")}</span>
            <span className="mt-1 block truncate text-xs text-[var(--color-text-2)]">
              {latest?.prompt || t("free_creation_session_empty")}
            </span>
          </button>
          <button type="button" onClick={() => setHistoryOpen(true)} className="focus-ring grid h-7 w-7 shrink-0 place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)]" aria-label={t("free_creation_request_history")} title={t("free_creation_request_history")}>
            <History className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" onClick={() => setExpanded((value) => !value)} className="focus-ring grid h-7 w-7 shrink-0 place-items-center text-[var(--color-text-muted)]" aria-label={t("free_creation_toggle_session_summary")}>
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
          </button>
        </div>
        {expanded ? (
          <div className="border-t border-[var(--color-hairline)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            {latest ? (
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">{latest.model || t("free_creation_model_auto")}</span>
                <span className="shrink-0">{t(statusKey(latest.status))}</span>
              </div>
            ) : t("free_creation_session_empty")}
          </div>
        ) : null}
      </div>

      {historyOpen ? (
        <div className="fixed inset-0 z-[220]" role="presentation" onMouseDown={() => setHistoryOpen(false)}>
          {/* The dialog must stop backdrop clicks from closing the drawer. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div className="absolute left-4 top-20 w-[min(420px,calc(100vw-2rem))] border border-[var(--color-hairline)] bg-[var(--color-surface-2)] p-3 text-[var(--color-text)] shadow-2xl" onMouseDown={(event) => event.stopPropagation()} role="dialog" tabIndex={-1} aria-modal="true" aria-label={t("free_creation_request_history")}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{t("free_creation_request_history")}</h2>
              <button type="button" onClick={() => setHistoryOpen(false)} className="focus-ring grid h-7 w-7 place-items-center text-[var(--color-text-muted)]" aria-label={t("close")}><X className="h-4 w-4" aria-hidden /></button>
            </div>
            <div className="max-h-[min(60vh,460px)] space-y-1 overflow-y-auto">
              {requests.length ? requests.map(({ requestId, items }) => {
                const item = items[0];
                return (
                  <div key={requestId} className="border border-[var(--color-hairline)] px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-[var(--color-text-2)]">{item.prompt || t("free_creation_prompt")}</span>
                      <span className="shrink-0 text-[var(--color-text-muted)]">{t(statusKey(item.status))}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{requestId} · {items.length}</div>
                  </div>
                );
              }) : <p className="py-6 text-center text-xs text-[var(--color-text-muted)]">{t("free_creation_session_empty")}</p>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
