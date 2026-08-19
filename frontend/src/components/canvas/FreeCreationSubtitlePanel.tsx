import { Captions, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import type { FreeCreation } from "@/types";
import { errMsg } from "@/utils/async";

interface FreeCreationSubtitlePanelProps {
  projectName: string;
  open: boolean;
  creations: FreeCreation[];
  onClose: () => void;
  onCreated: () => void;
}

export function FreeCreationSubtitlePanel({ projectName, open, creations, onClose, onCreated }: FreeCreationSubtitlePanelProps) {
  const { t } = useTranslation("dashboard");
  const videos = useMemo(() => creations.filter((item) => item.status === "succeeded" && (item.media_type === "video" || item.output_type === "video")), [creations]);
  const [creationId, setCreationId] = useState("");
  const [text, setText] = useState("");
  const [duration, setDuration] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const activeCreationId = videos.some((item) => item.creation_id === creationId) ? creationId : videos[0]?.creation_id || "";

  const submit = async () => {
    if (!activeCreationId || !text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await API.createFreeSubtitleTrack(projectName, { creation_id: activeCreationId, text: text.trim(), duration_seconds: duration });
      setText("");
      onCreated();
      onClose();
    } catch (nextError) {
      setError(errMsg(nextError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[2px]" role="presentation" onMouseDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <section className="w-[min(520px,100%)] overflow-hidden rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface)] shadow-2xl" role="dialog" aria-modal="true" aria-label={t("free_creation_subtitle_title")} onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-5 py-4"><Captions className="h-5 w-5 text-[var(--color-accent-2)]" aria-hidden /><h2 className="min-w-0 flex-1 text-base font-semibold">{t("free_creation_subtitle_title")}</h2><button type="button" onClick={onClose} className="focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.06)]" aria-label={t("close")} title={t("close")}><X className="h-4 w-4" aria-hidden /></button></header>
        <div className="space-y-4 px-5 py-4">
          {error ? <p className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">{error}</p> : null}
          {!videos.length ? <p className="text-sm text-[var(--color-text-muted)]">{t("free_creation_subtitle_video_required")}</p> : <>
            <label className="block text-xs font-medium text-[var(--color-text-2)]">{t("free_creation_subtitle_video")}<select value={activeCreationId} onChange={(event) => { setCreationId(event.target.value); const selected = videos.find((item) => item.creation_id === event.target.value); setDuration(Math.max(1, selected?.duration_seconds || 5)); }} className="focus-ring mt-1.5 h-9 w-full rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-background)] px-3 text-sm">{videos.map((video) => <option key={video.creation_id} value={video.creation_id}>{video.prompt || video.creation_id}</option>)}</select></label>
            <label className="block text-xs font-medium text-[var(--color-text-2)]">{t("free_creation_subtitle_text")}<textarea value={text} onChange={(event) => setText(event.target.value)} rows={5} className="focus-ring mt-1.5 min-h-28 w-full resize-y rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-background)] px-3 py-2 text-sm leading-5" /></label>
            <label className="block text-xs font-medium text-[var(--color-text-2)]">{t("free_creation_subtitle_duration")}<input type="number" min={1} max={3600} value={duration} onChange={(event) => setDuration(Math.max(1, Math.min(3600, Number(event.target.value) || 1)))} className="focus-ring mt-1.5 h-9 w-full rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-background)] px-3 text-sm" /></label>
          </>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--color-hairline)] px-5 py-3"><button type="button" onClick={onClose} className="focus-ring h-9 rounded-md border border-[var(--color-hairline-strong)] px-3 text-xs text-[var(--color-text-2)]">{t("cancel")}</button><button type="button" onClick={() => void submit()} disabled={!videos.length || !activeCreationId || !text.trim() || submitting} className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-[oklch(0.15_0_0)] disabled:opacity-40" style={{ background: "linear-gradient(135deg, var(--color-accent-2), var(--color-accent))" }}>{submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Captions className="h-3.5 w-3.5" aria-hidden />}{t("free_creation_subtitle_create")}</button></footer>
      </section>
    </div>
  );
}
