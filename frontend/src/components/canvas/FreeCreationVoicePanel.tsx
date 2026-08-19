import { AudioLines, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { errMsg } from "@/utils/async";

interface FreeCreationVoicePanelProps {
  projectName: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function FreeCreationVoicePanel({ projectName, open, onClose, onCreated }: FreeCreationVoicePanelProps) {
  const { t } = useTranslation("dashboard");
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [voices, setVoices] = useState<Array<{ id: string; label: string }>>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void API.getAudioBackendVoices(projectName)
      .then((result) => {
        setConfigured(result.configured);
        setVoices(result.voices);
        setVoice((current) => current || result.voices[0]?.id || "");
      })
      .catch((nextError) => setError(errMsg(nextError)))
      .finally(() => setLoading(false));
  }, [open, projectName]);

  if (!open) return null;

  const submit = async () => {
    if (!text.trim() || submitting || !configured) return;
    setSubmitting(true);
    setError(null);
    try {
      await API.createFreeCreationVoice(projectName, { text: text.trim(), voice: voice || undefined });
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
      <section className="w-[min(520px,100%)] overflow-hidden rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface)] shadow-2xl" role="dialog" aria-modal="true" aria-label={t("free_creation_voice_title")} onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-5 py-4">
          <AudioLines className="h-5 w-5 text-[var(--color-accent-2)]" aria-hidden />
          <h2 className="min-w-0 flex-1 text-base font-semibold">{t("free_creation_voice_title")}</h2>
          <button type="button" onClick={onClose} className="focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.06)]" aria-label={t("close")} title={t("close")}><X className="h-4 w-4" aria-hidden /></button>
        </header>
        <div className="space-y-4 px-5 py-4">
          {error ? <p className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">{error}</p> : null}
          {!loading && !configured ? <p className="text-sm text-[var(--color-text-muted)]">{t("free_creation_voice_unavailable")}</p> : null}
          <label className="block text-xs font-medium text-[var(--color-text-2)]">
            {t("free_creation_voice_text")}
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={5} maxLength={12000} className="focus-ring mt-1.5 min-h-28 w-full resize-y rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-background)] px-3 py-2 text-sm leading-5" disabled={!configured || loading || submitting} />
          </label>
          <label className="block text-xs font-medium text-[var(--color-text-2)]">
            {t("free_creation_voice_select")}
            <select value={voice} onChange={(event) => setVoice(event.target.value)} className="focus-ring mt-1.5 h-9 w-full rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-background)] px-3 text-sm" disabled={!configured || loading || submitting || !voices.length}>
              {!voices.length ? <option value="">{loading ? t("free_creation_voice_loading") : t("free_creation_voice_unavailable")}</option> : null}
              {voices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[var(--color-hairline)] px-5 py-3">
          <button type="button" onClick={onClose} className="focus-ring h-9 rounded-md border border-[var(--color-hairline-strong)] px-3 text-xs text-[var(--color-text-2)]">{t("cancel")}</button>
          <button type="button" onClick={() => void submit()} disabled={!text.trim() || !configured || loading || submitting || !voices.length} className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-[oklch(0.15_0_0)] disabled:opacity-40" style={{ background: "linear-gradient(135deg, var(--color-accent-2), var(--color-accent))" }}>{submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <AudioLines className="h-3.5 w-3.5" aria-hidden />}{t("free_creation_voice_generate")}</button>
        </footer>
      </section>
    </div>
  );
}
