import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useFreeCreationStore } from "@/stores/free-creation-store";
import { errMsg } from "@/utils/async";

interface FreeCreationExportMenuProps {
  projectName: string | null;
  disabled?: boolean;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function FreeCreationExportMenu({ projectName, disabled = false }: FreeCreationExportMenuProps) {
  const { t } = useTranslation("dashboard");
  const selectedIds = useFreeCreationStore((state) => state.selectedIds);
  const selectedRequestId = useFreeCreationStore((state) => state.selectedRequestId);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const runExport = async (
    scope: "selected" | "request" | "all",
  ) => {
    if (!projectName || exporting) return;
    setOpen(false);
    setExporting(true);
    try {
      const blob = await API.exportFreeCreations(projectName, {
        scope,
        creation_ids: scope === "selected" ? selectedIds : undefined,
        request_id: scope === "request" ? selectedRequestId ?? undefined : undefined,
      });
      downloadBlob(blob, `${projectName}-creations.zip`);
      useAppStore.getState().pushToast(t("free_creation_export_started"), "success");
    } catch (error) {
      useAppStore.getState().pushToast(
        t("free_creation_export_failed", { message: errMsg(error) }),
        "error",
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled || !projectName || exporting}
        className="focus-ring inline-flex h-[32px] items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-xs font-semibold text-[oklch(0.15_0_0)] transition-colors hover:bg-[var(--color-accent-2)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
        <span className="hidden lg:inline">{t("free_creation_export")}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-[80] min-w-56 rounded-md border border-[var(--color-hairline-strong)] p-1 text-[var(--color-text)] shadow-2xl"
          style={{
            background: "oklch(0.20 0.011 265 / 0.98)",
            opacity: 1,
            backdropFilter: "blur(18px) saturate(1.15)",
            WebkitBackdropFilter: "blur(18px) saturate(1.15)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={selectedIds.length === 0}
            onClick={() => void runExport("selected")}
            className="focus-ring flex w-full items-center justify-between rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)] disabled:opacity-40"
          >
            <span>{t("free_creation_export_selected")}</span>
            <span className="text-[var(--color-text-muted)]">{selectedIds.length}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!selectedRequestId}
            onClick={() => void runExport("request")}
            className="focus-ring w-full rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)] disabled:opacity-40"
          >
            {t("free_creation_export_request")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void runExport("all")}
            className="focus-ring w-full rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"
          >
            {t("free_creation_export_all")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
