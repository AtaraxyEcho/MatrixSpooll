import { useMemo, useState } from "react";
import { ChevronDown, History, MessageSquareText } from "lucide-react";
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
  const [expanded, setExpanded] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const messages = useMemo(
    () => [...creations]
      .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""))
      .slice(0, 40),
    [creations],
  );
  const requestCount = new Set(messages.map((item) => item.request_id ?? item.creation_id)).size;

  return (
    <section
      className="absolute left-4 top-4 z-20 w-[clamp(280px,32vw,420px)] max-w-[calc(100vw-2rem)] overflow-hidden border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-[0_18px_45px_-24px_oklch(0_0_0_/_0.9)]"
      data-testid="free-creation-session-summary"
      aria-label={t("free_creation_session_summary")}
    >
      <header className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-3.5 py-3">
        <MessageSquareText className="h-4 w-4 shrink-0 text-[var(--color-accent-2)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">{t("free_creation_session_summary")}</h2>
          <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
            {t("free_creation_session_count", { count: requestCount })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="focus-ring grid h-8 w-8 shrink-0 place-items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label={t("free_creation_request_history")}
          title={t("free_creation_request_history")}
        >
          <History className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="focus-ring grid h-8 w-8 shrink-0 place-items-center text-[var(--color-text-muted)]"
          aria-expanded={expanded}
          aria-label={t("free_creation_toggle_session_summary")}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </header>

      {expanded ? (
        <div className="max-h-[min(58vh,560px)] overflow-y-auto px-3.5 py-3">
          {messages.length ? (
            <div className="space-y-3">
              {messages.map((message) => (
                <article key={message.creation_id} className="space-y-1.5">
                  <div className="flex justify-end">
                    <p className="max-w-[92%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-[var(--color-accent-dim)] px-3 py-2 text-xs leading-5 text-[var(--color-text)]">
                      {message.prompt || t("free_creation_prompt")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 pl-2 text-[10px] text-[var(--color-text-muted)]">
                    <span>{t(`free_creation_${message.output_type}`)}</span>
                    <span aria-hidden>·</span>
                    <span>{t(statusKey(message.status))}</span>
                    {message.model ? <><span aria-hidden>·</span><span className="max-w-48 truncate">{message.model}</span></> : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="py-12 text-center text-xs text-[var(--color-text-muted)]">{t("free_creation_session_empty")}</p>
          )}
        </div>
      ) : null}

      {historyOpen ? (
        <div className="fixed inset-0 z-[220]" role="presentation" onMouseDown={() => setHistoryOpen(false)}>
          {/* Keep backdrop clicks outside the history panel. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            className="absolute left-4 top-20 w-[clamp(280px,32vw,420px)] max-w-[calc(100vw-2rem)] border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] p-4 text-[var(--color-text)] shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-label={t("free_creation_request_history")}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{t("free_creation_request_history")}</h2>
              <button type="button" onClick={() => setHistoryOpen(false)} className="focus-ring px-2 py-1 text-xs text-[var(--color-text-muted)]">
                {t("close")}
              </button>
            </div>
            <div className="max-h-[min(60vh,520px)] space-y-2 overflow-y-auto">
              {messages.length ? messages.map((message) => (
                <div key={message.creation_id} className="border border-[var(--color-hairline)] px-3 py-2">
                  <p className="whitespace-pre-wrap text-xs leading-5 text-[var(--color-text-2)]">{message.prompt || t("free_creation_prompt")}</p>
                  <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{t(statusKey(message.status))}</p>
                </div>
              )) : <p className="py-8 text-center text-xs text-[var(--color-text-muted)]">{t("free_creation_session_empty")}</p>}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
