import { useMemo, useState } from "react";
import { History, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FreeCreationRequestStatus, FreeCreationRequestSummary } from "@/types";
import { formatShortDateTime } from "@/utils/date-format";

interface FreeCreationSessionSummaryProps {
  requests: FreeCreationRequestSummary[];
}

function statusKey(status: FreeCreationRequestStatus): string {
  return `free_creation_status_${status}`;
}

function RequestMetadata({ request }: { request: FreeCreationRequestSummary }) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-4 text-[var(--color-text-muted)]">
      {request.effective_mode ? (
        <span>{t(`free_creation_mode_${request.effective_mode}`, { defaultValue: request.effective_mode })}</span>
      ) : null}
      {request.model ? <span className="max-w-48 truncate">{request.model}</span> : null}
      <span>{t("free_creation_bound_resources", { count: request.reference_count })}</span>
      <span>{t("free_creation_request_results", { completed: request.result_count, total: request.quantity })}</span>
    </div>
  );
}

export function FreeCreationSessionSummary({ requests }: FreeCreationSessionSummaryProps) {
  const { t } = useTranslation("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const entries = useMemo(
    () => [...requests]
      .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""))
      .slice(0, 40),
    [requests],
  );

  return (
    <section
      className={`absolute left-4 top-4 z-40 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-[0_18px_45px_-24px_oklch(0_0_0_/_0.9)] transition-[width] duration-200 ease-out ${collapsed ? "w-12" : "w-[clamp(288px,30vw,390px)]"}`}
      data-testid="free-creation-session-summary"
      aria-label={t("free_creation_session_summary")}
    >
      {collapsed ? (
        <div className="flex justify-center py-3">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text)]"
            aria-expanded={false}
            aria-label={t("free_creation_toggle_session_summary")}
            title={t("free_creation_toggle_session_summary")}
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <>
          <header className="flex items-center gap-2.5 border-b border-[var(--color-hairline)] px-3 py-2.5">
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text)]"
              aria-expanded={true}
              aria-label={t("free_creation_toggle_session_summary")}
              title={t("free_creation_toggle_session_summary")}
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold leading-5 text-[var(--color-text)]">
                {t("free_creation_session_summary")}
              </h2>
              <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-text-muted)]">
                {t("free_creation_session_count", { count: entries.length })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text)]"
              aria-label={t("free_creation_request_history")}
              title={t("free_creation_request_history")}
            >
              <History className="h-4 w-4" aria-hidden />
            </button>
          </header>

          <div className="max-h-[min(58vh,560px)] overflow-y-auto px-3.5 py-3">
            {entries.length ? (
              <div className="divide-y divide-[var(--color-hairline)]">
                {entries.map((request) => (
                  <article key={request.request_id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
                      <span className="font-medium text-[var(--color-text-2)]">
                        {t(`free_creation_${request.output_type}`)}
                      </span>
                      <span className="rounded-sm bg-[var(--color-surface-3)] px-1.5 py-0.5">
                        {t(statusKey(request.status))}
                      </span>
                      <time className="ml-auto shrink-0" dateTime={request.updated_at ?? request.created_at ?? undefined}>
                        {formatShortDateTime(request.updated_at ?? request.created_at) ?? ""}
                      </time>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text)]">
                      {request.prompt || t("free_creation_prompt")}
                    </p>
                    <RequestMetadata request={request} />
                  </article>
                ))}
              </div>
            ) : (
              <p className="py-12 text-center text-xs text-[var(--color-text-muted)]">
                {t("free_creation_session_empty")}
              </p>
            )}
          </div>
        </>
      )}

      {historyOpen ? (
        <>
          <div className="fixed inset-0 z-[218]" aria-hidden onMouseDown={() => setHistoryOpen(false)} />
          <div
            className="absolute top-0 z-[220] w-[clamp(280px,34vw,440px)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-2xl"
            style={{ left: "calc(100% + 8px)" }}
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-label={t("free_creation_request_history")}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-hairline)] px-3.5 py-2.5">
              <h2 className="text-sm font-semibold leading-5">{t("free_creation_request_history")}</h2>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text)]"
                aria-label={t("close")}
                title={t("close")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="max-h-[min(48vh,420px)] divide-y divide-[var(--color-hairline)] overflow-y-auto px-3.5 py-3">
              {entries.length ? entries.map((request) => (
                <article key={request.request_id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
                    <span>{t(statusKey(request.status))}</span>
                    <span>{t("free_creation_request_results", { completed: request.result_count, total: request.quantity })}</span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-2)]">
                    {request.prompt || t("free_creation_prompt")}
                  </p>
                  <RequestMetadata request={request} />
                </article>
              )) : (
                <p className="py-8 text-center text-xs text-[var(--color-text-muted)]">
                  {t("free_creation_session_empty")}
                </p>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
