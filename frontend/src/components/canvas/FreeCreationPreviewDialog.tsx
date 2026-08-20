/* eslint-disable jsx-a11y/media-has-caption, react-hooks/set-state-in-effect */
import { useEffect, useState } from "react";
import { Download, FileText, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { GlassModal } from "@/components/ui/GlassModal";
import type { FreeCreation, FreeCreationUpload } from "@/types";

export type FreeCreationPreviewTarget =
  | { kind: "upload"; upload: FreeCreationUpload }
  | { kind: "creation"; creation: FreeCreation };

interface FreeCreationPreviewDialogProps {
  projectName: string;
  target: FreeCreationPreviewTarget | null;
  onClose: () => void;
}

export function FreeCreationPreviewDialog({ projectName, target, onClose }: FreeCreationPreviewDialogProps) {
  const { t } = useTranslation("dashboard");
  const [text, setText] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textSupported, setTextSupported] = useState(true);
  const [textTruncated, setTextTruncated] = useState(false);

  const upload = target?.kind === "upload" ? target.upload : null;
  useEffect(() => {
    let active = true;
    setText(null);
    setTextSupported(true);
    setTextTruncated(false);
    if (!upload || upload.media_type !== "text") {
      setTextLoading(false);
      return () => {
        active = false;
      };
    }
    setTextLoading(true);
    void API.getFreeCreationReferencePreview(projectName, upload.reference_id)
      .then((result) => {
        if (!active) return;
        setTextSupported(result.supported);
        setText(result.text ?? null);
        setTextTruncated(Boolean(result.truncated));
      })
      .catch(() => {
        if (!active) return;
        setTextSupported(false);
      })
      .finally(() => {
        if (active) setTextLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectName, upload]);

  const title = target?.kind === "upload"
    ? target.upload.original_filename
    : target?.creation.prompt || t("free_creation_preview");
  const downloadHref = target?.kind === "upload"
    ? API.getFileUrl(projectName, target.upload.path)
    : target?.kind === "creation" && target.creation.media_path
      ? API.getFreeCreationMediaUrl(projectName, target.creation.creation_id)
      : null;
  const mediaType = target?.kind === "upload"
    ? target.upload.media_type
    : target?.kind === "creation"
      ? target.creation.media_type ?? (target.creation.output_type === "video" ? "video" : target.creation.output_type === "audio" ? "audio" : "image")
      : null;
  const previewLoading = textLoading || (mediaType === "text" && text === null && textSupported);

  return (
    <GlassModal
      open={target !== null}
      onClose={onClose}
      labelledBy="free-creation-preview-title"
      widthClassName="w-full max-w-4xl"
      panelClassName="max-h-[90vh]"
    >
      <div className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-4 py-3">
        <h2 id="free-creation-preview-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text)]">
          {title}
        </h2>
        {downloadHref ? (
          <a
            href={downloadHref}
            download
            className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label={t("free_creation_download")}
            title={t("free_creation_download")}
          >
            <Download className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label={t("free_creation_preview_close")}
          title={t("free_creation_preview_close")}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="max-h-[calc(90vh-4.5rem)] overflow-auto bg-[var(--color-background)] p-4">
        {target?.kind === "upload" && mediaType === "text" ? (
          previewLoading ? (
            <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t("free_creation_preview_loading")}
            </div>
          ) : textSupported && text !== null ? (
            <div className="mx-auto max-w-3xl rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] p-5">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[var(--color-text-2)]">{text}</pre>
              {textTruncated ? <p className="mt-4 border-t border-[var(--color-hairline)] pt-3 text-xs text-[var(--color-text-muted)]">{t("free_creation_preview_truncated")}</p> : null}
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center text-sm text-[var(--color-text-muted)]">
              <FileText className="h-7 w-7" aria-hidden />
              <p>{t("free_creation_preview_unavailable")}</p>
            </div>
          )
        ) : target?.kind === "upload" && mediaType === "image" ? (
          <img src={API.getFileUrl(projectName, target.upload.path)} alt={target.upload.original_filename} className="mx-auto max-h-[72vh] max-w-full object-contain" />
        ) : target?.kind === "upload" && mediaType === "video" ? (
          <video src={API.getFileUrl(projectName, target.upload.path)} className="mx-auto max-h-[72vh] max-w-full" controls autoPlay={false} />
        ) : target?.kind === "upload" && mediaType === "audio" ? (
          <div className="flex min-h-64 items-center justify-center"><audio src={API.getFileUrl(projectName, target.upload.path)} controls /></div>
        ) : target?.kind === "creation" && mediaType === "video" && downloadHref ? (
          <video src={downloadHref} className="mx-auto max-h-[72vh] max-w-full" controls autoPlay={false} />
        ) : target?.kind === "creation" && mediaType === "audio" && downloadHref ? (
          <div className="flex min-h-64 items-center justify-center"><audio src={downloadHref} controls /></div>
        ) : target?.kind === "creation" && downloadHref ? (
          <img src={downloadHref} alt={title} className="mx-auto max-h-[72vh] max-w-full object-contain" />
        ) : null}
      </div>
    </GlassModal>
  );
}
