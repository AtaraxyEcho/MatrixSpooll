/* eslint-disable jsx-a11y/media-has-caption */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Download,
  FileText,
  Image,
  Link2,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Settings2,
  Video,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { ASPECT_RATIO_OPTIONS } from "@/components/shared/AspectRatioPicker";
import { useModelCandidates } from "@/hooks/useModelCandidates";
import { useAppStore } from "@/stores/app-store";
import { useFreeCreationStore } from "@/stores/free-creation-store";
import type {
  CreateFreeCreationRequest,
  FreeCreation,
  FreeCreationCapabilities,
  FreeCreationMediaType,
  FreeCreationReferenceClaim,
  FreeCreationReferenceRole,
  FreeCreationUpload,
} from "@/types";
import { freeCreationUploadRole } from "@/types";
import { errMsg } from "@/utils/async";
import { FreeCreationInfiniteCanvas } from "./FreeCreationInfiniteCanvas";
import { FreeCreationPreviewDialog, type FreeCreationPreviewTarget } from "./FreeCreationPreviewDialog";
import { FreeCreationSessionSummary } from "./FreeCreationSessionSummary";
import {
  DurationControl,
  ImageParameterControl,
  HomeSelect,
  modelLabel,
  VideoParameterControl,
} from "@/components/pages/HomeHeroComposer";

export interface FreeCreationWorkspaceProps {
  projectName: string;
  readOnly?: boolean;
  initialOutputType?: FreeCreationMediaType;
}

interface ComposerReference {
  claim: FreeCreationReferenceClaim;
  label: string;
}

const VIDEO_REFERENCE_ROLES: FreeCreationReferenceRole[] = [
  "first_frame",
  "last_frame",
  "reference_image",
  "reference_video",
  "reference_audio",
  "prompt_context",
];

const IMAGE_RESOLUTION_PIXELS: Record<string, number> = {
  "1.5k": 1536,
  "2k": 2048,
  "4k": 4096,
};
const IMAGE_RESOLUTIONS = ["1.5k", "2k", "4k"] as const;

function dimensionsFor(resolution: string, ratio: string): { width: number; height: number } {
  const edge = IMAGE_RESOLUTION_PIXELS[resolution] ?? 1536;
  const [rawWidth, rawHeight] = ratio.split(":").map(Number);
  if (!rawWidth || !rawHeight) return { width: edge, height: edge };
  if (rawWidth >= rawHeight) return { width: edge, height: Math.max(1, Math.round(edge * rawHeight / rawWidth)) };
  return { width: Math.max(1, Math.round(edge * rawWidth / rawHeight)), height: edge };
}

function claimKey(claim: FreeCreationReferenceClaim): string {
  return claim.type === "upload"
    ? `upload:${claim.reference_id}:${claim.role ?? "unassigned"}`
    : `creation:${claim.creation_id}:${claim.version ?? "current"}:${claim.role ?? "unassigned"}`;
}

export function FreeCreationWorkspace({ projectName, readOnly = false, initialOutputType }: FreeCreationWorkspaceProps) {
  const { t } = useTranslation("dashboard");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadSequenceRef = useRef(0);
  const [mediaType, setMediaType] = useState<FreeCreationMediaType>(initialOutputType ?? "video");
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [uploads, setUploads] = useState<FreeCreationUpload[]>([]);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1080p");
  const initialDimensions = dimensionsFor("1.5k", "16:9");
  const [imageWidth, setImageWidth] = useState(initialDimensions.width);
  const [imageHeight, setImageHeight] = useState(initialDimensions.height);
  const [customSize, setCustomSize] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [model, setModel] = useState("auto");
  const [duration, setDuration] = useState(4);
  const [parentId, setParentId] = useState("");
  const [creations, setCreations] = useState<FreeCreation[]>([]);
  const [totalCreations, setTotalCreations] = useState(0);
  const [capabilities, setCapabilities] = useState<FreeCreationCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<FreeCreationPreviewTarget | null>(null);
  const refreshToken = useFreeCreationStore((state) => state.refreshToken);
  const { candidates, reload: reloadCandidates } = useModelCandidates();

  useEffect(() => {
    void reloadCandidates();
  }, [reloadCandidates]);

  const selectedParent = useMemo(
    () => creations.find((item) => item.creation_id === parentId) ?? null,
    [creations, parentId],
  );
  const effectiveMediaType: FreeCreationMediaType = selectedParent
    ? selectedParent.media_type ?? (selectedParent.output_type === "video" ? "video" : "image")
    : mediaType;
  const modelOptions = useMemo(() => {
    const values = effectiveMediaType === "video" ? candidates?.video.default : candidates?.image.default;
    return [...new Set(values ?? [])];
  }, [candidates, effectiveMediaType]);
  const selectedModel = model === "auto" || modelOptions.includes(model) ? model : "auto";

  const referenceKind = useMemo<"none" | "image" | "video">(() => {
    if (effectiveMediaType !== "video") return "none";
    if (selectedParent && (selectedParent.media_type === "video" || selectedParent.output_type === "video")) return "video";
    for (const reference of references) {
      const claim = reference.claim;
      if (claim.type === "upload") {
        const upload = uploads.find((item) => item.reference_id === claim.reference_id);
        if (upload?.media_type === "video") return "video";
        if (upload?.media_type === "image") return "image";
      } else {
        const creation = creations.find((item) => item.creation_id === claim.creation_id);
        if (creation?.media_type === "video" || creation?.output_type === "video") return "video";
        if (creation) return "image";
      }
    }
    return "none";
  }, [creations, effectiveMediaType, references, selectedParent, uploads]);

  useEffect(() => {
    const controller = new AbortController();
    void API.getFreeCreationCapabilities({
      outputType: effectiveMediaType,
      model: selectedModel === "auto" ? undefined : selectedModel,
      referenceKind,
      projectName,
      signal: controller.signal,
    }).then((next) => {
      setCapabilities(next);
      setCapabilityError(null);
    }).catch((nextError) => {
      if (!controller.signal.aborted && effectiveMediaType === "video") setCapabilityError(errMsg(nextError));
    });
    return () => controller.abort();
  }, [effectiveMediaType, projectName, referenceKind, selectedModel]);

  const ratioOptions = useMemo(
    () => capabilities?.output_type === effectiveMediaType && capabilities.ratios.length
      ? capabilities.ratios
      : effectiveMediaType === "image"
        ? ASPECT_RATIO_OPTIONS.map((option) => option.value)
        : [],
    [capabilities, effectiveMediaType],
  );
  const resolutionOptions = useMemo(
    () => capabilities?.output_type === effectiveMediaType && capabilities.resolutions.length
      ? capabilities.resolutions
      : effectiveMediaType === "image"
        ? [...IMAGE_RESOLUTIONS]
        : [],
    [capabilities, effectiveMediaType],
  );
  const durationOptions = useMemo(
    () => capabilities?.output_type === "video"
      ? capabilities.durations.filter((value) => Number.isInteger(value) && value > 0)
      : [],
    [capabilities],
  );
  const effectiveAspectRatio = ratioOptions.includes(aspectRatio) ? aspectRatio : ratioOptions[0] ?? "16:9";
  const selectedResolution = resolutionOptions.includes(resolution) ? resolution : resolutionOptions[0] ?? "";
  const safeDuration = durationOptions.reduce((closest, candidate) => (
    Math.abs(candidate - duration) < Math.abs(closest - duration) ? candidate : closest
  ), durationOptions[0] ?? duration);
  const capabilitiesReady = effectiveMediaType !== "video"
    || (capabilities?.output_type === "video" && ratioOptions.length > 0 && durationOptions.length > 0);
  const parameterRatioOptions = useMemo(
    () => ratioOptions.map((value) => ({
      value,
      label: (() => {
        const known = ASPECT_RATIO_OPTIONS.find((option) => option.value === value);
        return known ? t(known.labelKey) : value;
      })(),
    })),
    [ratioOptions, t],
  );

  const loadCreations = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    try {
      const loaded: FreeCreation[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let total = 0;
      do {
        const response = await API.listFreeCreations(projectName, 100, cursor);
        loaded.push(...response.creations);
        total = response.total ?? loaded.length;
        if (!response.next_cursor || seen.has(response.next_cursor)) break;
        seen.add(response.next_cursor);
        cursor = response.next_cursor;
      } while (loaded.length < total && loaded.length < 500);
      if (loadSequenceRef.current !== sequence) return;
      setCreations(loaded);
      setTotalCreations(total);
      setError(null);
    } catch (loadError) {
      if (loadSequenceRef.current === sequence) setError(errMsg(loadError));
    }
  }, [projectName]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCreations(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCreations, refreshToken]);

  useEffect(() => {
    void API.listFreeCreationReferences(projectName).then(({ references: next }) => setUploads(next)).catch(() => undefined);
  }, [projectName]);

  const hasActiveCreation = creations.some((item) => ["queued", "running", "cancelling"].includes(item.status));
  useEffect(() => {
    if (!hasActiveCreation) return;
    const timer = window.setInterval(() => void loadCreations(), 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveCreation, loadCreations]);

  const addReference = useCallback((claim: FreeCreationReferenceClaim, label: string) => {
    setReferences((current) => {
      const normalized: FreeCreationReferenceClaim = claim.role ? claim : { ...claim, role: claim.type === "upload" ? "reference_image" : "reference_image" };
      return current.some((item) => claimKey(item.claim) === claimKey(normalized))
        ? current
        : [...current, { claim: normalized, label }];
    });
  }, []);

  const referenceFromShortcut = (
    event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
    claim: FreeCreationReferenceClaim,
    label: string,
  ) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    addReference(claim, label);
  };

  const editFromCreation = (creationId: string) => {
    const creation = creations.find((item) => item.creation_id === creationId);
    if (!creation) return;
    setParentId(creationId);
    setMediaType(creation.media_type ?? (creation.output_type === "video" ? "video" : "image"));
  };

  const clearEdit = () => setParentId("");

  const changeMediaType = (next: FreeCreationMediaType) => {
    setMediaType(next);
    clearEdit();
    setModel("auto");
    if (next === "video") {
      setResolution("1080p");
    } else {
      setResolution("1.5k");
      const nextDimensions = dimensionsFor("1.5k", effectiveAspectRatio);
      setImageWidth(nextDimensions.width);
      setImageHeight(nextDimensions.height);
      setCustomSize(false);
    }
  };

  const changeAspectRatio = (next: string) => {
    setAspectRatio(next);
    if (effectiveMediaType === "image" && !customSize) {
      const nextDimensions = dimensionsFor(selectedResolution, next);
      setImageWidth(nextDimensions.width);
      setImageHeight(nextDimensions.height);
    }
  };

  const changeResolution = (next: string) => {
    setResolution(next);
    if (effectiveMediaType === "image") {
      const nextDimensions = dimensionsFor(next, effectiveAspectRatio);
      setImageWidth(nextDimensions.width);
      setImageHeight(nextDimensions.height);
      setCustomSize(false);
    }
  };

  const commitImageDimensions = (width: number, height: number) => {
    setImageWidth(width);
    setImageHeight(height);
    setCustomSize(true);
  };

  const runCreationAction = async (creationId: string, action: "cancel" | "retry") => {
    if (readOnly) return;
    setActingId(creationId);
    try {
      if (action === "cancel") await API.cancelFreeCreation(projectName, creationId);
      else await API.retryFreeCreation(projectName, creationId);
      await loadCreations();
    } catch (actionError) {
      useAppStore.getState().pushToast(errMsg(actionError), "error");
    } finally {
      setActingId(null);
    }
  };

  const uploadReferences = async (files: FileList | null) => {
    if (!files?.length || readOnly) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const result = await API.uploadFreeCreationReference(projectName, file);
        setUploads((current) => [result.reference, ...current.filter((item) => item.reference_id !== result.reference.reference_id)]);
      }
    } catch (uploadError) {
      useAppStore.getState().pushToast(errMsg(uploadError), "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const deleteUpload = async (referenceId: string) => {
    if (readOnly) return;
    try {
      await API.deleteFreeCreationReference(projectName, referenceId);
      setUploads((current) => current.filter((item) => item.reference_id !== referenceId));
      setReferences((current) => current.filter((item) => item.claim.type !== "upload" || item.claim.reference_id !== referenceId));
    } catch (deleteError) {
      useAppStore.getState().pushToast(errMsg(deleteError), "error");
    }
  };

  const detachUpload = async (referenceId: string) => {
    if (readOnly) return;
    try {
      await API.detachFreeCreationReference(projectName, referenceId);
      setUploads((current) => current.filter((item) => item.reference_id !== referenceId));
      setReferences((current) => current.filter((item) => item.claim.type !== "upload" || item.claim.reference_id !== referenceId));
    } catch (detachError) {
      useAppStore.getState().pushToast(errMsg(detachError), "error");
    }
  };

  const handleSubmit = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || readOnly || submitting || !capabilitiesReady) return;
    setSubmitting(true);
    setError(null);
    const editing = Boolean(parentId);
    const payload: CreateFreeCreationRequest = {
      output_type: editing ? "edit" : mediaType,
      prompt: cleanPrompt,
      references: references.map((item) => item.claim),
      aspect_ratio: effectiveAspectRatio,
      resolution: effectiveMediaType === "image" && customSize ? undefined : selectedResolution || undefined,
      size: effectiveMediaType === "image" ? `${imageWidth}x${imageHeight}` : undefined,
      model: selectedModel === "auto" ? undefined : selectedModel,
      quantity: editing ? 1 : quantity,
      duration_seconds: effectiveMediaType === "video" ? safeDuration : undefined,
      parent_creation_id: editing ? parentId : undefined,
    };
    try {
      await API.createFreeCreation(projectName, payload);
      setPrompt("");
      clearEdit();
      await loadCreations();
    } catch (submitError) {
      const message = errMsg(submitError);
      setError(message);
      useAppStore.getState().pushToast(message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const durationMinimum = durationOptions[0] ?? 1;
  const durationMaximum = durationOptions[durationOptions.length - 1] ?? durationMinimum;
  const mobileCreations = [...creations].sort(
    (left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""),
  );

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[var(--color-background)] text-[var(--color-text)]">
      <FreeCreationSessionSummary creations={creations} />
      <div className="absolute inset-0 hidden md:block">
        <FreeCreationInfiniteCanvas
          projectName={projectName}
          creations={creations}
          uploads={uploads}
          readOnly={readOnly}
          actingId={actingId}
          onCancel={(creationId) => void runCreationAction(creationId, "cancel")}
          onRetry={(creationId) => void runCreationAction(creationId, "retry")}
          onEdit={editFromCreation}
          onReference={addReference}
          onPreview={setPreviewTarget}
          onDetachUpload={(referenceId) => void detachUpload(referenceId)}
          onDeleteUpload={(referenceId) => void deleteUpload(referenceId)}
        />
      </div>

      <div className="absolute inset-0 overflow-y-auto px-3 pb-[330px] pt-3 md:hidden">
        <div className="grid gap-3">
          {uploads.map((upload) => (
            <article key={upload.reference_id} className="overflow-hidden rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)]" onDoubleClick={(event) => { event.preventDefault(); setPreviewTarget({ kind: "upload", upload }); }}>
              <div className="flex h-10 items-center justify-between gap-3 border-b border-[var(--color-hairline)] px-3 text-xs"><span className="truncate font-medium">{upload.original_filename}</span><span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{t("free_creation_reference")}</span></div>
              <div role={upload.media_type === "audio" || upload.media_type === "video" ? undefined : "button"} tabIndex={upload.media_type === "audio" || upload.media_type === "video" ? undefined : 0} className="aspect-video w-full bg-black" onClick={(event) => referenceFromShortcut(event, { type: "upload", reference_id: upload.reference_id, role: freeCreationUploadRole(upload.media_type) }, upload.original_filename)} onKeyDown={upload.media_type === "audio" || upload.media_type === "video" ? undefined : (event) => referenceFromShortcut(event, { type: "upload", reference_id: upload.reference_id, role: freeCreationUploadRole(upload.media_type) }, upload.original_filename)} title={t("free_creation_reference_shortcut")}>
                {upload.media_type === "image" ? <img src={API.getFileUrl(projectName, upload.path)} alt={upload.original_filename} className="h-full w-full object-contain" /> : upload.media_type === "video" ? (
                  <video src={API.getFileUrl(projectName, upload.path)} className="h-full w-full object-contain" aria-label={upload.original_filename} controls onClick={(event) => referenceFromShortcut(event, { type: "upload", reference_id: upload.reference_id, role: freeCreationUploadRole(upload.media_type) }, upload.original_filename)} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); setPreviewTarget({ kind: "upload", upload }); }} />
                ) : upload.media_type === "audio" ? <div className="flex h-full flex-col items-center justify-center gap-3 px-4"><AudioLines className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><audio src={API.getFileUrl(projectName, upload.path)} className="w-full" aria-label={upload.original_filename} controls /></div> : upload.media_type === "text" ? <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-muted)]"><FileText className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><span className="text-xs">{t("media_type_text")}</span></div> : <Link2 className="mx-auto pt-12 h-8 w-8 text-[var(--color-text-muted)]" aria-hidden />}
              </div>
              <div className="flex justify-end px-3 py-2"><button type="button" onClick={() => addReference({ type: "upload", reference_id: upload.reference_id, role: freeCreationUploadRole(upload.media_type) }, upload.original_filename)} className="focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button></div>
            </article>
          ))}
          {mobileCreations.map((creation) => {
            const isVideo = creation.media_type === "video" || creation.output_type === "video";
            return (
              <article key={creation.creation_id} className="overflow-hidden rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)]" onDoubleClick={(event) => { event.preventDefault(); if (creation.status === "succeeded" && creation.media_path) setPreviewTarget({ kind: "creation", creation }); }}>
                <div className="flex h-10 items-center justify-between gap-3 border-b border-[var(--color-hairline)] px-3 text-xs"><span className="font-medium">{t(`free_creation_${creation.output_type}`)}</span><span className="text-[10px] text-[var(--color-text-muted)]">{t(`free_creation_status_${creation.status}`)}</span></div>
                {creation.status === "succeeded" && creation.media_path ? isVideo ? (
                  <video src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} className="aspect-video w-full bg-black object-contain" aria-label={creation.prompt ?? creation.creation_id} controls onClick={(event) => referenceFromShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: "reference_video" }, creation.prompt || t("free_creation"))} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); setPreviewTarget({ kind: "creation", creation }); }} />
                ) : <div role="button" tabIndex={0} className="aspect-video w-full bg-black" onClick={(event) => referenceFromShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: "reference_image" }, creation.prompt || t("free_creation"))} onKeyDown={(event) => referenceFromShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: "reference_image" }, creation.prompt || t("free_creation"))}><img src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} alt={creation.prompt ?? creation.creation_id} className="h-full w-full object-contain" /></div> : <div className="grid aspect-video place-items-center bg-black px-3 text-center text-xs text-[var(--color-text-muted)]">{creation.status === "failed" ? t("free_creation_failed") : t(`free_creation_status_${creation.status}`)}</div>}
                <p className="line-clamp-2 px-3 py-2 text-xs leading-5 text-[var(--color-text-2)]">{creation.prompt || t("free_creation_prompt")}</p>
                {creation.status === "succeeded" && creation.media_path ? <div className="flex justify-end gap-1 border-t border-[var(--color-hairline)] p-2"><button type="button" onClick={() => addReference({ type: "creation", creation_id: creation.creation_id, version: creation.version, role: isVideo ? "reference_video" : "reference_image" }, creation.prompt || t("free_creation"))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)]" aria-label={t("free_creation_add_reference")}><Link2 className="h-4 w-4" aria-hidden /></button><button type="button" onClick={() => editFromCreation(creation.creation_id)} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)]" aria-label={t("free_creation_use_as_parent")}><Pencil className="h-4 w-4" aria-hidden /></button><a href={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} download className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)]" aria-label={t("free_creation_download")}><Download className="h-4 w-4" aria-hidden /></a></div> : null}
              </article>
            );
          })}
          {uploads.length === 0 && mobileCreations.length === 0 ? <p className="py-20 text-center text-sm text-[var(--color-text-muted)]">{t("free_creation_empty")}</p> : null}
        </div>
      </div>

      <section className="free-creation-composer absolute bottom-3 left-1/2 z-30 w-[min(780px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)]/96 p-3 shadow-lg backdrop-blur-md sm:bottom-4 sm:p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          {!initialOutputType ? <div className="flex items-center gap-1 rounded-md bg-[var(--color-background)] p-1" role="tablist" aria-label={t("free_creation")}>
            {([[
              "image", Image, "free_creation_image",
            ], ["video", Video, "free_creation_video"]] as const).map(([value, Icon, label]) => (
              <button key={value} type="button" role="tab" aria-selected={!parentId && mediaType === value} onClick={() => changeMediaType(value)} disabled={readOnly || submitting} className={`focus-ring inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${!parentId && mediaType === value ? "bg-[var(--color-surface-2)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}><Icon className="h-3.5 w-3.5" aria-hidden />{t(label)}</button>
            ))}
          </div> : <span className="text-xs font-medium text-[var(--color-text-2)]">{t(`free_creation_${mediaType}`)}</span>}
          <span className="text-[11px] text-[var(--color-text-muted)]">{totalCreations}</span>
        </div>

        {selectedParent ? (
          <div className="mb-2 flex items-center gap-2 rounded-md bg-[var(--color-accent-dim)] px-2.5 py-1.5 text-xs text-[var(--color-accent-2)]">
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("free_creation_editing_result", { prompt: selectedParent.prompt || t("free_creation") })}</span>
            <button type="button" onClick={clearEdit} className="focus-ring grid h-6 w-6 place-items-center rounded" aria-label={t("free_creation_cancel_edit")}><X className="h-3.5 w-3.5" aria-hidden /></button>
          </div>
        ) : null}

        {references.length ? (
          <div className="mb-2 flex max-h-16 flex-wrap gap-1.5 overflow-y-auto">
            {references.map((reference) => (
              <span key={claimKey(reference.claim)} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-[var(--color-background)] px-2 py-1 text-[11px] text-[var(--color-text-2)]"><Paperclip className="h-3 w-3 shrink-0" aria-hidden /><span className="max-w-32 truncate">{reference.label}</span><select value={reference.claim.role ?? "reference_image"} onChange={(event) => setReferences((current) => current.map((item) => claimKey(item.claim) === claimKey(reference.claim) ? { ...item, claim: { ...item.claim, role: event.target.value as FreeCreationReferenceRole } } : item))} className="h-6 max-w-32 border border-[var(--color-hairline)] bg-[var(--color-surface-2)] px-1 text-[10px] text-[var(--color-text-2)]" aria-label={reference.label}>{VIDEO_REFERENCE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select><button type="button" onClick={() => setReferences((current) => current.filter((item) => claimKey(item.claim) !== claimKey(reference.claim)))} className="focus-ring grid h-4 w-4 shrink-0 place-items-center rounded-full" aria-label={t("free_creation_remove_reference")}><X className="h-3 w-3" aria-hidden /></button></span>
            ))}
          </div>
        ) : null}

        <div className="rounded-md border border-[var(--color-hairline)] bg-[var(--color-background)] transition-colors focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-dim)]">
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void handleSubmit(); } }} rows={2} maxLength={10000} placeholder={t("free_creation_prompt")} className="min-h-[68px] w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-5 outline-none placeholder:text-[var(--color-text-muted)]" disabled={readOnly || submitting} />
          <div className="flex items-center gap-1.5 border-t border-[var(--color-hairline)] px-2 py-2">
            <input ref={fileInputRef} type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/wav,audio/mpeg,text/plain,text/markdown,application/rtf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,application/epub+zip,.txt,.text,.md,.markdown,.rtf,.doc,.docx,.pdf,.epub" className="sr-only" onChange={(event) => void uploadReferences(event.target.files)} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={readOnly || uploading || submitting} className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)] disabled:opacity-50" aria-label={t("free_creation_upload_reference")} title={t("free_creation_upload_reference")}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}</button>

            <div className="flex min-w-0 items-end gap-1.5">
              <HomeSelect
                label={t("home_model")}
                value={selectedModel}
                icon={Settings2}
                className="home-model-control free-creation-model-control"
                hint={t("home_model_keyboard_hint")}
                options={[
                  { value: "auto", label: t("home_model_auto") },
                  ...modelOptions.map((option) => ({ value: option, label: modelLabel(option, t("home_model_auto")) })),
                ]}
                onChange={setModel}
              />
              {effectiveMediaType === "image" ? (
                <ImageParameterControl
                  label={t("home_image_settings")}
                  ratioLabel={t("home_ratio")}
                  resolutionLabel={t("home_resolution")}
                  quantityLabel={t("home_quantity")}
                  sizeLabel={t("home_size")}
                  widthLabel={t("home_width")}
                  heightLabel={t("home_height")}
                  sizeHint={t("home_size_hint")}
                  ratio={effectiveAspectRatio}
                  resolution={selectedResolution || "1.5k"}
                  quantity={quantity}
                  width={imageWidth}
                  height={imageHeight}
                  ratioOptions={parameterRatioOptions}
                  resolutionOptions={resolutionOptions}
                  onRatioChange={changeAspectRatio}
                  onResolutionChange={changeResolution}
                  onQuantityChange={setQuantity}
                  onDimensionsCommit={commitImageDimensions}
                />
              ) : (
                <VideoParameterControl
                  label={t("home_video_settings")}
                  ratioLabel={t("home_ratio")}
                  resolutionLabel={t("home_resolution")}
                  quantityLabel={t("home_quantity")}
                  autoLabel={t("home_auto")}
                  ratio={effectiveAspectRatio}
                  resolution={selectedResolution || "auto"}
                  quantity={quantity}
                  ratioOptions={parameterRatioOptions}
                  resolutionOptions={resolutionOptions}
                  onRatioChange={changeAspectRatio}
                  onResolutionChange={changeResolution}
                  onQuantityChange={setQuantity}
                />
              )}
              {effectiveMediaType === "video" && durationOptions.length ? (
                <DurationControl
                  label={t("free_creation_duration")}
                  minimumLabel={t("home_duration_minimum", { value: durationOptions[0] ?? safeDuration })}
                  value={safeDuration}
                  durations={durationOptions}
                  onChange={setDuration}
                  ariaLabel={`${t("free_creation_duration")} control`}
                />
              ) : null}
              <select
                className="sr-only"
                aria-label={t("free_creation_resolution")}
                value={selectedResolution}
                onChange={(event) => changeResolution(event.target.value)}
                tabIndex={-1}
              >
                {resolutionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <select
                className="sr-only"
                aria-label={t("free_creation_quantity")}
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value))}
                tabIndex={-1}
              >
                {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              {effectiveMediaType === "image" ? <>
                <input className="sr-only" aria-label="W" type="number" value={imageWidth} onChange={(event) => commitImageDimensions(Number(event.target.value) || imageWidth, imageHeight)} tabIndex={-1} />
                <input className="sr-only" aria-label="H" type="number" value={imageHeight} onChange={(event) => commitImageDimensions(imageWidth, Number(event.target.value) || imageHeight)} tabIndex={-1} />
              </> : null}
              {effectiveMediaType === "video" && durationOptions.length ? (
                <input
                  className="sr-only"
                  type="range"
                  min={0}
                  max={durationMaximum}
                  step={1}
                  value={safeDuration}
                  aria-label={t("free_creation_duration")}
                  aria-valuemin={durationMinimum}
                  onChange={(event) => {
                    const requested = event.currentTarget.valueAsNumber;
                    setDuration(durationOptions.reduce((closest, candidate) => Math.abs(candidate - requested) < Math.abs(closest - requested) ? candidate : closest, durationOptions[0] ?? requested));
                  }}
                  tabIndex={-1}
                />
              ) : null}
            </div>

          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--color-hairline)] pt-2">
          <p className="min-h-4 min-w-0 flex-1 truncate text-xs text-[var(--color-danger)]" role="alert">{capabilityError || error}</p>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!prompt.trim() || readOnly || submitting || !capabilitiesReady}
            className="focus-ring inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-[9px] px-3 text-xs font-semibold text-[oklch(0.15_0_0)] transition-transform motion-safe:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--color-accent-2), var(--color-accent))" }}
            aria-label={t("free_creation_submit")}
            title={t("free_creation_submit")}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
            <span>{t("free_creation_submit")}</span>
          </button>
        </div>
      </section>
      <FreeCreationPreviewDialog
        projectName={projectName}
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
      />
    </div>
  );
}
