import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Loader2, Pencil, Sparkles, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { ASPECT_RATIO_OPTIONS } from "@/components/shared/AspectRatioPicker";
import { useModelCandidates } from "@/hooks/useModelCandidates";
import type {
  CreateFreeCreationRequest,
  FreeCreation,
  FreeCreationCapabilities,
  FreeCreationOutputType,
} from "@/types";
import { errMsg } from "@/utils/async";
import { useAppStore } from "@/stores/app-store";
import { FreeCreationInfiniteCanvas } from "./FreeCreationInfiniteCanvas";

export interface FreeCreationWorkspaceProps {
  projectName: string;
  readOnly?: boolean;
}

const outputTypes: { value: FreeCreationOutputType; icon: typeof Image; label: string }[] = [
  { value: "image", icon: Image, label: "free_creation_image" },
  { value: "video", icon: Video, label: "free_creation_video" },
  { value: "edit", icon: Pencil, label: "free_creation_edit" },
];

const IMAGE_RESOLUTION_PIXELS: Record<string, number> = {
  "1.5k": 1536,
  "2k": 2048,
  "4k": 4096,
};

const VIDEO_DURATIONS = [4, 5, 6, 8, 10, 12, 15] as const;
const IMAGE_RESOLUTIONS = ["1.5k", "2k", "4k"] as const;
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
const IMAGE_REFERENCE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webp"] as const;
const VIDEO_REFERENCE_SUFFIXES = [".mp4", ".mov"] as const;

export function FreeCreationWorkspace({ projectName, readOnly = false }: FreeCreationWorkspaceProps) {
  const { t } = useTranslation("dashboard");
  const [outputType, setOutputType] = useState<FreeCreationOutputType>("video");
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1080p");
  const [size, setSize] = useState("1536x1536");
  const [quantity, setQuantity] = useState("1");
  const [model, setModel] = useState("auto");
  const [duration, setDuration] = useState("4");
  const [parentId, setParentId] = useState("");
  const [creations, setCreations] = useState<FreeCreation[]>([]);
  const [capabilities, setCapabilities] = useState<FreeCreationCapabilities | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { candidates, reload: reloadCandidates } = useModelCandidates();

  useEffect(() => {
    void reloadCandidates();
  }, [reloadCandidates]);

  const editableCreations = useMemo(
    () => creations.filter((item) => item.status === "succeeded" && item.media_path),
    [creations],
  );
  const selectedParent = useMemo(
    () => editableCreations.find((item) => item.creation_id === parentId),
    [editableCreations, parentId],
  );
  const usesVideo = outputType === "video"
    || (outputType === "edit"
      && (selectedParent?.media_type === "video" || selectedParent?.output_type === "video"));
  const modelOptions = useMemo(() => {
    const values = usesVideo ? candidates?.video.default : candidates?.image.default;
    return [...new Set(values ?? [])];
  }, [candidates, usesVideo]);
  const selectedModel = model === "auto" || modelOptions.includes(model) ? model : "auto";
  const referenceKind = useMemo<"none" | "image" | "video">(() => {
    if (!usesVideo) return "none";
    if (selectedParent?.media_type === "video" || selectedParent?.output_type === "video") return "video";
    const paths = references.split(/\r?\n/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (paths.some((item) => VIDEO_REFERENCE_SUFFIXES.some((suffix) => item.endsWith(suffix)))) return "video";
    if (paths.some((item) => IMAGE_REFERENCE_SUFFIXES.some((suffix) => item.endsWith(suffix)))) return "image";
    return "none";
  }, [references, selectedParent, usesVideo]);

  useEffect(() => {
    const controller = new AbortController();
    void API.getFreeCreationCapabilities({
      outputType: usesVideo ? "video" : "image",
      model: selectedModel === "auto" ? undefined : selectedModel,
      referenceKind,
      signal: controller.signal,
    })
      .then(setCapabilities)
      .catch(() => {
        // The submit preflight remains authoritative if capabilities cannot be loaded.
      });
    return () => controller.abort();
  }, [referenceKind, selectedModel, usesVideo]);

  const ratioOptions = useMemo<string[]>(
    () => capabilities?.ratios.length
      ? capabilities.ratios
      : ASPECT_RATIO_OPTIONS.map(({ value }) => value),
    [capabilities],
  );
  const resolutionOptions = useMemo<string[]>(
    () => capabilities?.resolutions.length
      ? capabilities.resolutions
      : [...(usesVideo ? VIDEO_RESOLUTIONS : IMAGE_RESOLUTIONS)],
    [capabilities, usesVideo],
  );
  const durationOptions = useMemo<readonly number[]>(
    () => capabilities?.output_type === "video" && capabilities.durations.length
      ? capabilities.durations
      : VIDEO_DURATIONS,
    [capabilities],
  );
  const selectableDurationOptions = useMemo<readonly number[]>(() => {
    const supported = durationOptions.filter((value) => value >= 4 && value <= 15);
    return supported.length ? supported : VIDEO_DURATIONS;
  }, [durationOptions]);
  const effectiveAspectRatio = ratioOptions.includes(aspectRatio) ? aspectRatio : ratioOptions[0] ?? "9:16";
  const selectedResolution = resolutionOptions.includes(resolution) ? resolution : "";
  const safeDuration = selectableDurationOptions.reduce(
    (closest, candidate) => (
      Math.abs(candidate - (Number(duration) || 4)) < Math.abs(closest - (Number(duration) || 4))
        ? candidate
        : closest
    ),
    selectableDurationOptions[0] ?? 4,
  );

  const loadCreations = useCallback(async () => {
    try {
      const response = await API.listFreeCreations(projectName, 40);
      setCreations(response.creations);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, [projectName]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadCreations(), 0);
    const timer = window.setInterval(() => void loadCreations(), 4000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [loadCreations]);

  const runCreationAction = async (creationId: string, action: "cancel" | "retry") => {
    if (readOnly) return;
    setActingId(creationId);
    setError(null);
    try {
      if (action === "cancel") {
        await API.cancelFreeCreation(projectName, creationId);
      } else {
        await API.retryFreeCreation(projectName, creationId);
      }
      await loadCreations();
    } catch (err) {
      const message = errMsg(err);
      setError(message);
      useAppStore.getState().pushToast(message, "error");
    } finally {
      setActingId(null);
    }
  };

  const editFromCreation = (creationId: string) => {
    setOutputType("edit");
    setParentId(creationId);
    if (!["1.5k", "2k", "4k"].includes(resolution)) {
      setResolution("1.5k");
      setSize("1536x1536");
    }
  };

  const changeOutputType = (next: FreeCreationOutputType) => {
    setOutputType(next);
    if (next === "video") {
      setResolution("1080p");
      return;
    }
    if (!["1.5k", "2k", "4k"].includes(resolution)) {
      setResolution("1.5k");
      setSize("1536x1536");
    }
  };

  const handleSubmit = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || readOnly) return;
    setSubmitting(true);
    setError(null);
    const payload: CreateFreeCreationRequest = {
      output_type: outputType,
      prompt: cleanPrompt,
      references: references
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
      aspect_ratio: effectiveAspectRatio,
      resolution: selectedResolution || undefined,
      size: usesVideo ? undefined : size.trim() || undefined,
      model: selectedModel === "auto" ? undefined : selectedModel,
      quantity: outputType === "edit" ? 1 : Number(quantity) || 1,
      ...(usesVideo ? { duration_seconds: safeDuration } : {}),
      ...(outputType === "edit" && parentId ? { parent_creation_id: parentId } : {}),
    };
    try {
      await API.createFreeCreation(projectName, payload);
      setPrompt("");
      await loadCreations();
    } catch (err) {
      const message = errMsg(err);
      setError(message);
      useAppStore.getState().pushToast(message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[var(--color-background)] text-[var(--color-text)]">
      <FreeCreationInfiniteCanvas
        projectName={projectName}
        creations={creations}
        readOnly={readOnly}
        actingId={actingId}
        onCancel={(creationId) => void runCreationAction(creationId, "cancel")}
        onRetry={(creationId) => void runCreationAction(creationId, "retry")}
        onEdit={editFromCreation}
      />

      <section className="absolute bottom-2 left-1/2 z-30 max-h-[calc(100%-1rem)] w-[min(920px,calc(100vw-1rem))] -translate-x-1/2 overflow-y-auto border border-[var(--color-hairline)] bg-[var(--color-surface)]/95 p-3 shadow-2xl backdrop-blur-md sm:bottom-4 sm:max-h-[calc(100%-2rem)] sm:w-[min(920px,calc(100vw-2rem))] sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--color-text)]">
            <Sparkles className="h-4 w-4 shrink-0 text-[var(--color-accent-2)]" aria-hidden="true" />
            <span className="truncate">{t("free_creation")}</span>
          </div>
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{creations.length}</span>
        </div>

        <div className="mb-3 flex gap-1" role="group" aria-label={t("free_creation")}>
          {outputTypes.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => changeOutputType(value)}
              disabled={readOnly || submitting}
              className={`inline-flex min-h-8 items-center gap-1.5 border px-2.5 text-xs transition-colors ${
                outputType === value
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                  : "border-[var(--color-hairline)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
              aria-pressed={outputType === value}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {t(label)}
            </button>
          ))}
        </div>

        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={2}
          placeholder={t("free_creation_prompt")}
          className="w-full resize-none border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 py-2.5 text-sm leading-5 outline-none transition-colors focus:border-[var(--color-accent)]"
          disabled={readOnly || submitting}
        />

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-[11px] text-[var(--color-text-muted)]">
            <span className="mb-1 block">{t("free_creation_aspect_ratio")}</span>
            <input
              list="free-creation-ratios"
              value={effectiveAspectRatio}
              onChange={(event) => setAspectRatio(event.target.value)}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              disabled={readOnly || submitting}
              aria-label={t("free_creation_aspect_ratio")}
            />
            <datalist id="free-creation-ratios">
              {ratioOptions.map((ratio) => <option key={ratio} value={ratio} />)}
            </datalist>
          </label>
          <label className="text-[11px] text-[var(--color-text-muted)]">
            <span className="mb-1 block">{t("free_creation_model")}</span>
            <select
              value={selectedModel}
              onChange={(event) => setModel(event.target.value)}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              disabled={readOnly || submitting}
              aria-label={t("free_creation_model")}
            >
              <option value="auto">{t("free_creation_model_auto")}</option>
              {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--color-text-muted)]">
            <span className="mb-1 block">{t("free_creation_resolution")}</span>
            <select
              value={selectedResolution}
              onChange={(event) => {
                const nextResolution = event.target.value;
                setResolution(nextResolution);
                if (!usesVideo) {
                  const pixels = IMAGE_RESOLUTION_PIXELS[nextResolution];
                  if (pixels) setSize(`${pixels}x${pixels}`);
                }
              }}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              disabled={readOnly || submitting}
              aria-label={t("free_creation_resolution")}
            >
              <option value="">{t("free_creation_resolution_auto")}</option>
              {resolutionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--color-text-muted)]">
            <span className="mb-1 block">{t("free_creation_quantity")}</span>
            <select
              value={outputType === "edit" ? "1" : quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              disabled={readOnly || submitting || outputType === "edit"}
              aria-label={t("free_creation_quantity")}
            >
              {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {usesVideo ? (
            <label className="text-[11px] text-[var(--color-text-muted)]">
              <span className="mb-1 flex items-center justify-between gap-2">
                <span>{t("free_creation_duration")}</span>
                <strong className="font-medium text-[var(--color-text)]">{safeDuration}s</strong>
              </span>
              <input
                type="range"
                min={0}
                max={15}
                step={1}
                value={safeDuration}
                onChange={(event) => {
                  const requested = Math.max(4, event.currentTarget.valueAsNumber);
                  const next = selectableDurationOptions.reduce(
                    (closest, candidate) => (
                      Math.abs(candidate - requested) < Math.abs(closest - requested)
                        ? candidate
                        : closest
                    ),
                    selectableDurationOptions[0] ?? 4,
                  );
                  setDuration(String(next));
                }}
                className="home-duration-slider mt-1 h-2 w-full accent-[var(--color-accent)]"
                disabled={readOnly || submitting}
                aria-label={t("free_creation_duration")}
                aria-valuemin={4}
                aria-valuemax={15}
                style={{
                  background: `linear-gradient(90deg, oklch(0.34 0.006 265) 0 26.67%, var(--color-accent) 26.67% ${(safeDuration / 15) * 100}%, oklch(0.27 0.012 265) ${(safeDuration / 15) * 100}% 100%)`,
                }}
              />
              <span className="mt-1 flex justify-between text-[9px] text-[var(--color-text-muted)]" aria-hidden="true">
                <span>0s</span>
                <span>4s</span>
                <span>15s</span>
              </span>
            </label>
          ) : (
            <label className="text-[11px] text-[var(--color-text-muted)]">
              <span className="mb-1 block">{t("free_creation_size")}</span>
              <input
                value={size}
                onChange={(event) => setSize(event.target.value)}
                placeholder="1536x1536"
                className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-2 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
                disabled={readOnly || submitting}
                aria-label={t("free_creation_size")}
              />
            </label>
          )}
        </div>

        {outputType === "edit" ? (
          <label className="mt-2 block text-[11px] text-[var(--color-text-muted)]">
            <span className="mb-1 block">{t("free_creation_edit")}</span>
            <select
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              className="h-9 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              disabled={readOnly || submitting}
              aria-label={t("free_creation_edit")}
            >
              <option value="">{t("free_creation_empty")}</option>
              {editableCreations.map((creation) => (
                <option key={creation.creation_id} value={creation.creation_id}>
                  {creation.prompt?.slice(0, 80) || creation.creation_id}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <label className="min-w-0 flex-1 text-[11px] text-[var(--color-text-muted)]">
            <span className="mb-1 block">{t("free_creation_reference_paths")}</span>
            <textarea
              value={references}
              onChange={(event) => setReferences(event.target.value)}
              rows={1}
              className="min-h-9 w-full resize-none border border-[var(--color-hairline)] bg-[var(--color-background)] px-2 py-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              disabled={readOnly || submitting}
              aria-label={t("free_creation_reference_paths")}
            />
          </label>
          <div className="flex items-center gap-3 sm:pl-3">
            <p className="min-h-5 max-w-[280px] text-[11px] text-[var(--color-danger)]" role="alert">
              {error}
            </p>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={readOnly || submitting || !prompt.trim() || (outputType === "edit" && !parentId)}
              className="inline-flex min-h-9 shrink-0 items-center gap-1.5 bg-[var(--color-accent)] px-3 text-xs font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
              {submitting ? t("free_creation_generating") : t("free_creation_submit")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
