import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Clapperboard, Film, Loader2, Save, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import type { FreeStoryboardPlan, FreeStoryboardShot } from "@/types";
import { errMsg } from "@/utils/async";

interface FreeCreationStoryboardPanelProps {
  projectName: string;
  open: boolean;
  prompt: string;
  sourceReferenceId?: string;
  aspectRatio: string;
  resolution?: string;
  model?: string;
  durationOptions?: readonly number[];
  onClose: () => void;
  onCreated: () => void;
}

function reorder(shots: FreeStoryboardShot[], index: number, direction: -1 | 1): FreeStoryboardShot[] {
  const target = index + direction;
  if (target < 0 || target >= shots.length) return shots;
  const next = [...shots];
  [next[index], next[target]] = [next[target], next[index]];
  return next.map((shot, sequenceIndex) => ({ ...shot, sequence_index: sequenceIndex }));
}

function normalizeDuration(value: number, durationOptions?: readonly number[]): number {
  if (!durationOptions?.length) return Math.max(1, Math.round(value));
  return durationOptions.reduce(
    (closest, candidate) => Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
    durationOptions[0],
  );
}

export function FreeCreationStoryboardPanel({
  projectName,
  open,
  prompt,
  sourceReferenceId,
  aspectRatio,
  resolution,
  model,
  durationOptions,
  onClose,
  onCreated,
}: FreeCreationStoryboardPanelProps) {
  const { t } = useTranslation("dashboard");
  const [plan, setPlan] = useState<FreeStoryboardPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setPlan(null);
      setError(null);
      setLoading(true);
      try {
        const { plan: nextPlan } = await API.createFreeStoryboardPlan(projectName, {
          prompt: prompt.trim() || undefined,
          reference_id: sourceReferenceId,
          title: prompt.trim().split(/\r?\n/)[0]?.slice(0, 80),
        });
        setPlan({
          ...nextPlan,
          shots: nextPlan.shots.map((shot) => ({
            ...shot,
            duration_seconds: normalizeDuration(shot.duration_seconds, durationOptions),
          })),
        });
      } catch (nextError) {
        setError(errMsg(nextError));
      } finally {
        setLoading(false);
      }
    })();
  }, [durationOptions, open, projectName, prompt, sourceReferenceId]);

  const sortedShots = useMemo(
    () => [...(plan?.shots ?? [])].sort((left, right) => left.sequence_index - right.sequence_index),
    [plan?.shots],
  );

  if (!open) return null;

  const updateShot = (shotId: string, patch: Partial<FreeStoryboardShot>) => {
    setPlan((current) => current ? {
      ...current,
      shots: current.shots.map((shot) => shot.shot_id === shotId
        ? {
            ...shot,
            ...patch,
            ...(patch.duration_seconds !== undefined
              ? { duration_seconds: normalizeDuration(patch.duration_seconds, durationOptions) }
              : {}),
          }
        : shot),
    } : current);
  };

  const save = async (): Promise<boolean> => {
    if (!plan || saving) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await API.updateFreeStoryboardPlan(projectName, plan.plan_id, {
        title: plan.title.trim() || t("free_creation_storyboard_default_title"),
        shots: sortedShots,
        expected_revision: plan.revision,
      });
      setPlan(result.plan);
      return true;
    } catch (saveError) {
      setError(errMsg(saveError));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const generateImages = async () => {
    if (!plan || generating || !sortedShots.length) return;
    setGenerating(true);
    setError(null);
    try {
      if (!await save()) return;
      const result = await API.generateFreeStoryboardBatch(projectName, plan.plan_id, {
        shot_ids: sortedShots.map((shot) => shot.shot_id),
        output_type: "image",
        aspect_ratio: aspectRatio,
        resolution,
        model,
        expected_revision: plan.revision + 1,
      });
      setPlan(result.plan);
      onCreated();
    } catch (generationError) {
      setError(errMsg(generationError));
    } finally {
      setGenerating(false);
    }
  };

  const generateVideos = async () => {
    if (!plan || generating || !sortedShots.length || sortedShots.some((shot) => !shot.image_creation_id)) return;
    setGenerating(true);
    setError(null);
    try {
      if (!await save()) return;
      const result = await API.generateFreeStoryboardBatch(projectName, plan.plan_id, {
        shot_ids: sortedShots.map((shot) => shot.shot_id),
        output_type: "video",
        aspect_ratio: aspectRatio,
        resolution,
        model,
        expected_revision: plan.revision + 1,
      });
      setPlan(result.plan);
      onCreated();
    } catch (generationError) {
      setError(errMsg(generationError));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[240] flex items-start justify-center bg-black/45 px-4 py-16 backdrop-blur-[2px]" role="presentation" onMouseDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <section
        className="flex max-h-[min(760px,calc(100vh-8rem))] w-[min(760px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--color-hairline-strong)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={t("free_creation_storyboard_title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-5 py-4">
          <Clapperboard className="h-5 w-5 text-[var(--color-accent-2)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t("free_creation_storyboard_title")}</h2>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t("free_creation_storyboard_subtitle")}</p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.06)] hover:text-[var(--color-text)]" aria-label={t("close")} title={t("close")}><X className="h-4 w-4" aria-hidden /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--color-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("free_creation_storyboard_loading")}</div> : null}
          {error ? <p className="mb-3 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">{error}</p> : null}
          {plan ? (
            <>
              <label className="block text-xs font-medium text-[var(--color-text-2)]">
                {t("free_creation_storyboard_name")}
                <input value={plan.title} onChange={(event) => setPlan({ ...plan, title: event.target.value })} className="focus-ring mt-1.5 h-9 w-full rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-background)] px-3 text-sm" />
              </label>
              <div className="mt-4 space-y-3">
                {sortedShots.map((shot, index) => (
                  <article key={shot.shot_id} className="border border-[var(--color-hairline-strong)] bg-[var(--color-background)] p-3">
                    <div className="flex items-center gap-2">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--color-accent-dim)] text-[11px] font-semibold text-[var(--color-accent-2)]">{index + 1}</span>
                      <input value={shot.title} onChange={(event) => updateShot(shot.shot_id, { title: event.target.value })} className="focus-ring min-w-0 flex-1 bg-transparent text-sm font-medium outline-none" aria-label={t("free_creation_storyboard_shot_title", { index: index + 1 })} />
                      <button type="button" disabled={index === 0} onClick={() => setPlan({ ...plan, shots: reorder(sortedShots, index, -1) })} className="focus-ring grid h-7 w-7 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.06)] disabled:opacity-30" aria-label={t("free_creation_storyboard_move_up")} title={t("free_creation_storyboard_move_up")}><ArrowUp className="h-3.5 w-3.5" aria-hidden /></button>
                      <button type="button" disabled={index === sortedShots.length - 1} onClick={() => setPlan({ ...plan, shots: reorder(sortedShots, index, 1) })} className="focus-ring grid h-7 w-7 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.06)] disabled:opacity-30" aria-label={t("free_creation_storyboard_move_down")} title={t("free_creation_storyboard_move_down")}><ArrowDown className="h-3.5 w-3.5" aria-hidden /></button>
                    </div>
                    <textarea value={shot.prompt} onChange={(event) => updateShot(shot.shot_id, { prompt: event.target.value })} rows={3} className="focus-ring mt-2 min-h-16 w-full resize-y rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-2 text-xs leading-5 text-[var(--color-text-2)]" aria-label={t("free_creation_storyboard_shot_prompt", { index: index + 1 })} />
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                      <label className="inline-flex items-center gap-1.5">{t("free_creation_duration")}<input type="number" min={1} max={120} value={shot.duration_seconds} onChange={(event) => updateShot(shot.shot_id, { duration_seconds: Math.max(1, Math.min(120, Number(event.target.value) || 1)) })} className="focus-ring h-7 w-16 rounded border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)]" /></label>
                      {shot.image_creation_id ? <span className="text-[var(--color-accent-2)]">{t("free_creation_storyboard_image_ready")}</span> : null}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </div>

        {plan ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-hairline)] px-5 py-3">
          <button type="button" onClick={() => void save()} disabled={saving || generating} className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-hairline-strong)] px-3 text-xs font-medium text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.06)] disabled:opacity-50"><Save className="h-3.5 w-3.5" aria-hidden />{saving ? t("free_creation_storyboard_saving") : t("free_creation_storyboard_save")}</button>
          <button type="button" onClick={() => void generateImages()} disabled={generating || saving || !sortedShots.length} className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-[oklch(0.15 0 0)] disabled:opacity-50" style={{ background: "linear-gradient(135deg, var(--color-accent-2), var(--color-accent))" }}>{generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}{t("free_creation_storyboard_generate_images")}</button>
          <button type="button" onClick={() => void generateVideos()} disabled={generating || saving || !sortedShots.length || sortedShots.some((shot) => !shot.image_creation_id)} className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-hairline-strong)] px-3 text-xs font-medium text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.06)] disabled:opacity-50"><Film className="h-3.5 w-3.5" aria-hidden />{t("free_creation_storyboard_generate_videos")}</button>
        </footer> : null}
      </section>
    </div>
  );
}
