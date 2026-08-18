import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  Image,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  Video,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import { ASPECT_RATIO_OPTIONS } from "@/components/shared/AspectRatioPicker";
import { AspectFrame } from "@/components/ui/AspectFrame";
import { useModelCandidates } from "@/hooks/useModelCandidates";
import type { CreateFreeCreationRequest, FreeCreation, FreeCreationOutputType } from "@/types";
import { errMsg } from "@/utils/async";
import { useAppStore } from "@/stores/app-store";

interface FreeCreationCanvasProps {
  projectName: string;
  readOnly?: boolean;
}

const outputTypes: { value: FreeCreationOutputType; icon: typeof Image; label: string }[] = [
  { value: "image", icon: Image, label: "free_creation_image" },
  { value: "video", icon: Video, label: "free_creation_video" },
  { value: "edit", icon: Pencil, label: "free_creation_edit" },
];

export function FreeCreationCanvas({ projectName, readOnly = false }: FreeCreationCanvasProps) {
  const { t } = useTranslation("dashboard");
  const [outputType, setOutputType] = useState<FreeCreationOutputType>("image");
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState("");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [resolution, setResolution] = useState("");
  const [size, setSize] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [model, setModel] = useState("auto");
  const [duration, setDuration] = useState("4");
  const [parentId, setParentId] = useState("");
  const [creations, setCreations] = useState<FreeCreation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { candidates, reload: reloadCandidates } = useModelCandidates();

  useEffect(() => {
    void reloadCandidates();
  }, [reloadCandidates]);

  const modelOptions = useMemo(() => {
    const values = outputType === "video" ? candidates?.video.default : candidates?.image.default;
    return [...new Set(values ?? [])];
  }, [candidates, outputType]);
  const selectedModel = model === "auto" || modelOptions.includes(model) ? model : "auto";

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

  const imageCreations = useMemo(
    () =>
      creations.filter(
        (item) =>
          ["image", "edit"].includes(item.output_type) && item.status === "succeeded",
      ),
    [creations],
  );

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
      aspect_ratio: aspectRatio,
      resolution: resolution || undefined,
      size: outputType === "video" ? undefined : size.trim() || undefined,
      model: selectedModel === "auto" ? undefined : selectedModel,
      quantity: outputType === "edit" ? 1 : Number(quantity) || 1,
      ...(outputType === "video" ? { duration_seconds: Number(duration) || 4 } : {}),
      ...(outputType === "edit" && parentId ? { parent_creation_id: parentId } : {}),
    };
    try {
      await API.createFreeCreation(projectName, payload);
      setPrompt("");
      await loadCreations();
    } catch (err) {
      setError(errMsg(err));
      useAppStore.getState().pushToast(errMsg(err), "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-[var(--color-background)] px-5 py-6 text-[var(--color-text)] lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-hairline)] pb-5">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase text-[var(--color-text-muted)]">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {t("free_creation")}
            </div>
            <h1 className="text-2xl font-semibold">{t("free_creation_prompt")}</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
              {t("content_mode_free_desc")}
            </p>
          </div>
        </header>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="border border-[var(--color-hairline)] bg-[var(--color-surface)] p-5 shadow-sm">
            <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label={t("free_creation")}>
              {outputTypes.map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setOutputType(value)}
                  disabled={readOnly || submitting}
                  className={`inline-flex min-h-10 items-center gap-2 border px-3 text-sm transition-colors ${
                    outputType === value
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                      : "border-[var(--color-hairline)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                  aria-pressed={outputType === value}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t(label)}
                </button>
              ))}
            </div>

            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={7}
              placeholder={t("free_creation_prompt")}
              className="w-full resize-y border border-[var(--color-hairline)] bg-[var(--color-background)] p-3 text-sm outline-none transition-colors focus:border-[var(--color-accent)]"
              disabled={readOnly || submitting}
            />

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="text-sm text-[var(--color-text-muted)]">
                <span className="mb-1.5 block">{t("free_creation_aspect_ratio")}</span>
                <input
                  list="free-creation-ratios"
                  value={aspectRatio}
                  onChange={(event) => setAspectRatio(event.target.value)}
                  className="h-10 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                  disabled={readOnly || submitting}
                />
                <datalist id="free-creation-ratios">
                  {ASPECT_RATIO_OPTIONS.map(({ value: ratio }) => (
                    <option key={ratio} value={ratio} />
                  ))}
                </datalist>
              </label>
              <label className="text-sm text-[var(--color-text-muted)]">
                <span className="mb-1.5 block">{t("free_creation_model")}</span>
                <select
                  value={selectedModel}
                  onChange={(event) => setModel(event.target.value)}
                  className="h-10 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                  disabled={readOnly || submitting}
                >
                  <option value="auto">{t("free_creation_model_auto")}</option>
                  {modelOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-[var(--color-text-muted)]">
                <span className="mb-1.5 block">{t("free_creation_resolution")}</span>
                <select
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  className="h-10 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                  disabled={readOnly || submitting}
                >
                  <option value="">{t("free_creation_resolution_auto")}</option>
                  {(outputType === "video"
                    ? ["480p", "720p", "1080p", "4k"]
                    : ["1.5k", "2k", "4k"]
                  ).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-[var(--color-text-muted)]">
                <span className="mb-1.5 block">{t("free_creation_quantity")}</span>
                <select
                  value={outputType === "edit" ? "1" : quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  className="h-10 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                  disabled={readOnly || submitting || outputType === "edit"}
                >
                  {[1, 2, 3, 4].map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              {outputType !== "video" ? (
                <label className="text-sm text-[var(--color-text-muted)]">
                  <span className="mb-1.5 block">{t("free_creation_size")}</span>
                  <input
                    value={size}
                    onChange={(event) => setSize(event.target.value)}
                    placeholder="1536x864"
                    className="h-10 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                    disabled={readOnly || submitting}
                  />
                </label>
              ) : null}
              {outputType === "video" ? (
                <label className="text-sm text-[var(--color-text-muted)]">
                  <span className="mb-1.5 block">{t("free_creation_duration")}</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                    className="h-10 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                    disabled={readOnly || submitting}
                  />
                </label>
              ) : (
                <div />
              )}
            </div>

            <label className="mt-4 block text-sm text-[var(--color-text-muted)]">
              <span className="mb-1.5 block">{t("free_creation_reference_paths")}</span>
              <textarea
                value={references}
                onChange={(event) => setReferences(event.target.value)}
                rows={3}
                className="w-full resize-y border border-[var(--color-hairline)] bg-[var(--color-background)] p-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                disabled={readOnly || submitting}
              />
            </label>

            {outputType === "edit" && (
              <label className="mt-4 block text-sm text-[var(--color-text-muted)]">
                <span className="mb-1.5 block">{t("free_creation_edit")}</span>
                <select
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                  className="h-10 w-full border border-[var(--color-hairline)] bg-[var(--color-background)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                  disabled={readOnly || submitting}
                >
                  <option value="">{t("free_creation_empty")}</option>
                  {imageCreations.map((creation) => (
                    <option key={creation.creation_id} value={creation.creation_id}>
                      {creation.creation_id}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="mt-5 flex items-center justify-between gap-4">
              <p className="text-xs text-[var(--color-text-muted)]">{error ?? ""}</p>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={
                  readOnly ||
                  submitting ||
                  !prompt.trim() ||
                  (outputType === "edit" && !parentId)
                }
                className="inline-flex min-h-10 items-center gap-2 bg-[var(--color-accent)] px-4 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                )}
                {submitting ? t("free_creation_generating") : t("free_creation_submit")}
              </button>
            </div>
          </div>

          <aside className="border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t("free_creation")}</h2>
              <span className="text-xs text-[var(--color-text-muted)]">{creations.length}</span>
            </div>
            {creations.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">{t("free_creation_empty")}</p>
            ) : (
              <div className="space-y-3">
                {creations.map((creation) => (
                  <article
                    key={creation.creation_id}
                    className="overflow-hidden border border-[var(--color-hairline)] bg-[var(--color-background)]"
                  >
                    {creation.status === "succeeded" && creation.media_path ? (
                      <AspectFrame ratio={creation.aspect_ratio ?? "9:16"} className="bg-black">
                        {creation.output_type === "video" ? (
                          // eslint-disable-next-line jsx-a11y/media-has-caption -- free creation results do not carry caption tracks
                          <video
                            className="h-full w-full object-contain"
                            src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)}
                            aria-label={creation.prompt ?? creation.creation_id}
                            controls
                          />
                        ) : (
                          <img
                            className="h-full w-full object-contain"
                            src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)}
                            alt={creation.prompt ?? creation.creation_id}
                          />
                        )}
                      </AspectFrame>
                    ) : (
                      <AspectFrame ratio={creation.aspect_ratio ?? "9:16"} className="bg-black">
                        <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
                          {creation.status === "failed"
                            ? t("free_creation_failed")
                            : t(`free_creation_status_${creation.status}`)}
                        </div>
                      </AspectFrame>
                    )}
                    <div className="p-3">
                      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                        <span>{t(`free_creation_${creation.output_type}`)}</span>
                        <span>{t(`free_creation_status_${creation.status}`)}</span>
                      </div>
                      <p className="line-clamp-3 text-xs text-[var(--color-text)]">
                        {creation.prompt}
                      </p>
                      {creation.error ? (
                        <p className="mt-2 line-clamp-3 text-xs text-[var(--color-danger)]">
                          {t("free_creation_error_generic")}
                        </p>
                      ) : null}
                      {!readOnly ? (
                        <div className="mt-3 flex min-h-8 items-center justify-end gap-1 border-t border-[var(--color-hairline)] pt-2">
                          {creation.status === "queued" || creation.status === "running" ? (
                            <button
                              type="button"
                              onClick={() =>
                                void runCreationAction(creation.creation_id, "cancel")
                              }
                              disabled={actingId === creation.creation_id}
                              className="inline-flex h-8 w-8 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
                              aria-label={t("free_creation_cancel")}
                              title={t("free_creation_cancel")}
                            >
                              {actingId === creation.creation_id ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <XCircle className="h-4 w-4" aria-hidden="true" />
                              )}
                            </button>
                          ) : null}
                          {creation.status === "failed" || creation.status === "cancelled" ? (
                            <button
                              type="button"
                              onClick={() =>
                                void runCreationAction(creation.creation_id, "retry")
                              }
                              disabled={actingId === creation.creation_id}
                              className="inline-flex h-8 w-8 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
                              aria-label={t("free_creation_retry")}
                              title={t("free_creation_retry")}
                            >
                              {actingId === creation.creation_id ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                              )}
                            </button>
                          ) : null}
                          {creation.status === "succeeded" && creation.output_type !== "video" ? (
                            <button
                              type="button"
                              onClick={() => editFromCreation(creation.creation_id)}
                              className="inline-flex h-8 w-8 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
                              aria-label={t("free_creation_use_as_parent")}
                              title={t("free_creation_use_as_parent")}
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </button>
                          ) : null}
                          {creation.status === "succeeded" && creation.media_path ? (
                            <VersionTimeMachine
                              projectName={projectName}
                              resourceType={creation.output_type === "video" ? "free_videos" : "free_images"}
                              resourceId={creation.creation_id}
                              iconOnly
                              readOnly
                            />
                          ) : null}
                          {creation.status === "succeeded" && creation.media_path ? (
                            <a
                              href={API.getFreeCreationMediaUrl(projectName, creation.creation_id)}
                              download
                              className="inline-flex h-8 w-8 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
                              aria-label={t("free_creation_download")}
                              title={t("free_creation_download")}
                            >
                              <Download className="h-4 w-4" aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}
