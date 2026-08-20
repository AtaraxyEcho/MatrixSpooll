/* eslint-disable jsx-a11y/media-has-caption */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Bot,
  Captions,
  Clapperboard,
  Download,
  FileText,
  Image,
  Layers3,
  Link2,
  Library,
  Loader2,
  Pencil,
  Send,
  Settings2,
  Video,
  WandSparkles,
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
  FreeCreationArtifactMediaType,
  FreeCreationCapabilities,
  FreeCreationMediaType,
  FreeCreationReferenceClaim,
  FreeCreationRequestSummary,
  FreeCreationUpload,
} from "@/types";
import { errMsg } from "@/utils/async";
import { FreeCreationInfiniteCanvas } from "./FreeCreationInfiniteCanvas";
import { FreeCreationPreviewDialog, type FreeCreationPreviewTarget } from "./FreeCreationPreviewDialog";
import { FreeCreationSessionSummary } from "./FreeCreationSessionSummary";
import { FreeCreationStoryboardPanel } from "./FreeCreationStoryboardPanel";
import { FreeCreationVoicePanel } from "./FreeCreationVoicePanel";
import { FreeCreationSubtitlePanel } from "./FreeCreationSubtitlePanel";
import { AgentCopilot } from "@/components/copilot/AgentCopilot";
import {
  AgentParameterControl,
  type AgentGenerationPreference,
  DurationControl,
  handleComposerStripWheel,
  HomeMenu,
  ImageParameterControl,
  HomeSelect,
  modelLabel,
  VideoParameterControl,
} from "@/components/generation/GenerationComposer";
import { FreeCreationAssetPickerModal } from "@/components/generation/FreeCreationAssetPickerModal";
import {
  readGenerationModelPreferences,
  writeGenerationModelPreference,
} from "@/components/generation/generationModelPreference";
import {
  referenceCompatibilityIssue,
} from "@/components/generation/FreeCreationReferenceRoleSelect";
import {
  automaticReferenceRole,
  FreeCreationReferenceInput,
  type FreeCreationReferenceItem,
  type FreeCreationReferenceMode,
  referenceAccept,
  referenceAdmissionIssue,
  referenceUploadLimit,
  supportsFrameReferences,
} from "@/components/generation/FreeCreationReferenceInput";
import type { Asset } from "@/types/asset";

export interface FreeCreationWorkspaceProps {
  projectName: string;
  readOnly?: boolean;
  initialMode?: ComposerMode;
}

interface ComposerReference {
  claim: FreeCreationReferenceClaim;
  label: string;
}

type ComposerMode = "agent" | FreeCreationMediaType;

function creationMediaType(creation: FreeCreation): FreeCreationArtifactMediaType {
  return creation.media_type ?? (creation.output_type === "video" ? "video" : creation.output_type === "audio" ? "audio" : "image");
}

function creationReferenceRole(creation: FreeCreation) {
  const artifactType = creationMediaType(creation);
  return artifactType === "video" ? "reference_video" : artifactType === "audio" ? "reference_audio" : "reference_image";
}

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

function claimIdentity(claim: FreeCreationReferenceClaim): string {
  return claim.type === "upload"
    ? `upload:${claim.reference_id}`
    : `creation:${claim.creation_id}:${claim.version ?? "current"}`;
}

function uploadMediaTypeForFile(file: File): FreeCreationUpload["media_type"] {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("text/") || /\.(?:txt|text|md|markdown|rtf|docx?|pdf|epub)$/i.test(file.name)) {
    return "text";
  }
  return "image";
}

export function FreeCreationWorkspace({ projectName, readOnly = false, initialMode = "video" }: FreeCreationWorkspaceProps) {
  const { t } = useTranslation("dashboard");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFrameRoleRef = useRef<"first_frame" | "last_frame" | null>(null);
  const loadSequenceRef = useRef(0);
  const initialMediaType: FreeCreationMediaType = initialMode === "image" ? "image" : "video";
  const [mediaType, setMediaType] = useState<FreeCreationMediaType>(initialMediaType);
  const [composerMode, setComposerMode] = useState<ComposerMode>(initialMode);
  const [agentPreference, setAgentPreference] = useState<AgentGenerationPreference>("video");
  const [agentAspectRatio, setAgentAspectRatio] = useState("16:9");
  const [prompt, setPrompt] = useState("");
  const [referenceMode, setReferenceMode] = useState<FreeCreationReferenceMode>("omni");
  const [omniReferences, setOmniReferences] = useState<ComposerReference[]>([]);
  const [frameReferences, setFrameReferences] = useState<ComposerReference[]>([]);
  const [uploads, setUploads] = useState<FreeCreationUpload[]>([]);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("1080p");
  const initialDimensions = dimensionsFor("1.5k", "16:9");
  const [imageWidth, setImageWidth] = useState(initialDimensions.width);
  const [imageHeight, setImageHeight] = useState(initialDimensions.height);
  const [customSize, setCustomSize] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [modelPreferences, setModelPreferences] = useState(readGenerationModelPreferences);
  const [duration, setDuration] = useState(4);
  const [parentId, setParentId] = useState("");
  const [creations, setCreations] = useState<FreeCreation[]>([]);
  const [requests, setRequests] = useState<FreeCreationRequestSummary[]>([]);
  const [totalCreations, setTotalCreations] = useState(0);
  const [capabilities, setCapabilities] = useState<FreeCreationCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [importingAssets, setImportingAssets] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<FreeCreationPreviewTarget | null>(null);
  const [storyboardOpen, setStoryboardOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const refreshToken = useFreeCreationStore((state) => state.refreshToken);
  const { candidates, reload: reloadCandidates } = useModelCandidates();

  useEffect(() => {
    void reloadCandidates();
  }, [reloadCandidates]);

  const selectedParent = useMemo(
    () => creations.find((item) => item.creation_id === parentId) ?? null,
    [creations, parentId],
  );
  const effectiveMediaType: FreeCreationMediaType = selectedParent && creationMediaType(selectedParent) === "image"
    ? "image"
    : mediaType;
  const model = modelPreferences[effectiveMediaType];
  const setModel = useCallback((nextModel: string) => {
    setModelPreferences((current) => writeGenerationModelPreference(current, effectiveMediaType, nextModel));
  }, [effectiveMediaType]);
  const references = referenceMode === "frames" ? frameReferences : omniReferences;
  const modelOptions = useMemo(() => {
    const values = effectiveMediaType === "video" ? candidates?.video.default : candidates?.image.default;
    return [...new Set(values ?? [])];
  }, [candidates, effectiveMediaType]);
  const selectedModel = model === "auto" || modelOptions.includes(model) ? model : "auto";

  const referenceKind = useMemo<"none" | "frame" | "image" | "video" | "audio">(() => {
    if (effectiveMediaType !== "video") {
      return references.some((reference) => reference.claim.role === "reference_image") ? "image" : "none";
    }
    if (referenceMode === "frames") return "frame";
    if (selectedParent && (selectedParent.media_type === "video" || selectedParent.output_type === "video")) return "video";
    if (references.some((reference) => reference.claim.role === "reference_video")) return "video";
    if (references.some((reference) => reference.claim.role === "reference_audio")) return "audio";
    if (references.some((reference) => reference.claim.role === "reference_image")) return "image";
    return "none";
  }, [effectiveMediaType, referenceMode, references, selectedParent]);

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
  const capabilitiesReady = effectiveMediaType === "video"
    ? capabilities?.output_type === "video" && ratioOptions.length > 0 && durationOptions.length > 0
    : referenceKind !== "image" || capabilities?.output_type === "image";

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
      const requestsPromise = API.listFreeCreationRequests(projectName, 40);
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
      const requestResponse = await requestsPromise;
      if (loadSequenceRef.current !== sequence) return;
      setCreations(loaded);
      setRequests(requestResponse.requests);
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

  const referenceMediaType = useCallback((claim: FreeCreationReferenceClaim): FreeCreationUpload["media_type"] => {
    if (claim.type === "upload") {
      return uploads.find((item) => item.reference_id === claim.reference_id)?.media_type ?? "image";
    }
    const creation = creations.find((item) => item.creation_id === claim.creation_id);
    return creation ? creationMediaType(creation) : "image";
  }, [creations, uploads]);

  const referenceIssue = referenceCompatibilityIssue(
    references.map((reference) => ({
      mediaType: referenceMediaType(reference.claim),
      role: reference.claim.role,
    })),
    capabilities,
  );
  const referenceIssueMessage = referenceIssue === "missing_role"
    ? t("free_creation_reference_roles_incomplete")
    : referenceIssue === "slot_limit"
      ? t("free_creation_reference_role_limit")
      : referenceIssue
        ? t("free_creation_reference_roles_incompatible")
        : null;

  const showReferenceAdmissionIssue = useCallback((issue: Exclude<ReturnType<typeof referenceAdmissionIssue>, null>) => {
    const limit = referenceUploadLimit(capabilities, referenceMode, effectiveMediaType);
    const message = issue === "unsupported_type"
      ? t("free_creation_reference_type_unsupported")
      : t("free_creation_reference_limit_reached", { count: limit ?? 0 });
    useAppStore.getState().pushToast(message, "error");
  }, [capabilities, effectiveMediaType, referenceMode, t]);

  const addReferences = useCallback((incoming: Array<{ claim: FreeCreationReferenceClaim; label: string }>) => {
    if (referenceMode === "frames") {
      const next = [...frameReferences];
      for (const { claim, label } of incoming) {
        if (next.some((item) => claimIdentity(item.claim) === claimIdentity(claim))) continue;
        const role = !next.some((item) => item.claim.role === "first_frame")
          ? "first_frame"
          : !next.some((item) => item.claim.role === "last_frame")
            ? "last_frame"
            : null;
        if (!role) {
          showReferenceAdmissionIssue("total_limit");
          break;
        }
        const mediaType = referenceMediaType(claim);
        const issue = capabilities ? referenceAdmissionIssue({
          items: next.map((item) => ({
            id: claimKey(item.claim),
            name: item.label,
            mediaType: referenceMediaType(item.claim),
            role: item.claim.role!,
          })),
          mediaType,
          role,
          capabilities,
          outputType: effectiveMediaType,
          mode: "frames",
        }) : null;
        if (issue) {
          showReferenceAdmissionIssue(issue);
          break;
        }
        next.push({ claim: { ...claim, role }, label });
      }
      setFrameReferences(next);
      return;
    }

    const next = [...omniReferences];
    for (const { claim, label } of incoming) {
      const mediaType = referenceMediaType(claim);
      const role = automaticReferenceRole(mediaType);
      const normalized = { ...claim, role };
      if (next.some((item) => claimIdentity(item.claim) === claimIdentity(normalized))) continue;
      const issue = capabilities ? referenceAdmissionIssue({
        items: next.map((item) => ({
          id: claimKey(item.claim),
          name: item.label,
          mediaType: referenceMediaType(item.claim),
          role: item.claim.role!,
        })),
        mediaType,
        role,
        capabilities,
        outputType: effectiveMediaType,
        mode: "omni",
      }) : null;
      if (issue) {
        showReferenceAdmissionIssue(issue);
        break;
      }
      next.push({ claim: normalized, label });
    }
    setOmniReferences(next);
  }, [capabilities, effectiveMediaType, frameReferences, omniReferences, referenceMediaType, referenceMode, showReferenceAdmissionIssue]);

  const addReference = useCallback((claim: FreeCreationReferenceClaim, label: string) => {
    addReferences([{ claim, label }]);
  }, [addReferences]);

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
    if (!creation || creationMediaType(creation) !== "image") return;
    setParentId(creationId);
    setMediaType("image");
    setComposerMode("image");
    setReferenceMode("omni");
  };

  const clearEdit = () => setParentId("");

  const changeMediaType = (next: FreeCreationMediaType) => {
    setMediaType(next);
    clearEdit();
    if (next === "video") {
      setResolution("1080p");
    } else {
      setReferenceMode("omni");
      setResolution("1.5k");
      const nextDimensions = dimensionsFor("1.5k", effectiveAspectRatio);
      setImageWidth(nextDimensions.width);
      setImageHeight(nextDimensions.height);
      setCustomSize(false);
    }
  };

  const changeComposerMode = (next: ComposerMode) => {
    setComposerMode(next);
    if (next !== "agent") changeMediaType(next);
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

  const openReferencePicker = (frameRole?: "first_frame" | "last_frame") => {
    pendingFrameRoleRef.current = frameRole ?? null;
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = referenceAccept(capabilities, referenceMode, effectiveMediaType);
    fileInputRef.current.multiple = referenceMode === "omni";
    fileInputRef.current.click();
  };

  const uploadReferences = async (files: FileList | readonly File[] | null): Promise<number> => {
    if (!files?.length || readOnly) return 0;
    const selectedFiles = Array.from(files);
    let nextReferences = [...references];
    let uploadedCount = 0;
    setUploading(true);
    try {
      for (const file of selectedFiles) {
        const mediaType = uploadMediaTypeForFile(file);
        const role = referenceMode === "frames"
          ? pendingFrameRoleRef.current
            ?? (nextReferences.some((item) => item.claim.role === "first_frame") ? "last_frame" : "first_frame")
          : automaticReferenceRole(mediaType);
        const withoutReplacedFrame = referenceMode === "frames"
          ? nextReferences.filter((item) => item.claim.role !== role)
          : nextReferences;
        const issue = capabilities ? referenceAdmissionIssue({
          items: withoutReplacedFrame.map((item) => ({
            id: claimKey(item.claim),
            name: item.label,
            mediaType: referenceMediaType(item.claim),
            role: item.claim.role!,
          })),
          mediaType,
          role,
          capabilities,
          outputType: effectiveMediaType,
          mode: referenceMode,
        }) : "unsupported_type";
        if (issue) {
          showReferenceAdmissionIssue(issue);
          continue;
        }
        const result = await API.uploadFreeCreationReference(projectName, file);
        setUploads((current) => [result.reference, ...current.filter((item) => item.reference_id !== result.reference.reference_id)]);
        const uploadedReference: ComposerReference = {
          claim: {
            type: "upload",
            reference_id: result.reference.reference_id,
            role,
          },
          label: result.reference.original_filename,
        };
        nextReferences = [...withoutReplacedFrame, uploadedReference];
        uploadedCount += 1;
        if (referenceMode === "frames") break;
      }
      if (referenceMode === "frames") setFrameReferences(nextReferences);
      else setOmniReferences(nextReferences);
    } catch (uploadError) {
      useAppStore.getState().pushToast(errMsg(uploadError), "error");
    } finally {
      setUploading(false);
      pendingFrameRoleRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
    return uploadedCount;
  };

  const uploadCanvasFiles = useCallback(async (files: readonly File[]): Promise<FreeCreationUpload[]> => {
    if (!files.length || readOnly) return [];
    setUploading(true);
    const uploaded: FreeCreationUpload[] = [];
    try {
      for (const file of files) {
        const result = await API.uploadFreeCreationReference(projectName, file);
        uploaded.push(result.reference);
      }
      if (uploaded.length) {
        setUploads((current) => [
          ...uploaded,
          ...current.filter((item) => !uploaded.some((next) => next.reference_id === item.reference_id)),
        ]);
      }
      return uploaded;
    } catch (uploadError) {
      useAppStore.getState().pushToast(errMsg(uploadError), "error");
      return uploaded;
    } finally {
      setUploading(false);
    }
  }, [projectName, readOnly]);

  const importAssetReferences = async (assets: Asset[]) => {
    setImportingAssets(true);
    try {
      const files = await Promise.all(assets.map((asset) => API.getGlobalAssetFile(asset)));
      if (await uploadReferences(files)) setAssetPickerOpen(false);
    } catch (importError) {
      useAppStore.getState().pushToast(errMsg(importError), "error");
    } finally {
      setImportingAssets(false);
    }
  };

  const deleteUpload = async (referenceId: string) => {
    if (readOnly) return;
    try {
      await API.deleteFreeCreationReference(projectName, referenceId);
      setUploads((current) => current.filter((item) => item.reference_id !== referenceId));
      setOmniReferences((current) => current.filter((item) => item.claim.type !== "upload" || item.claim.reference_id !== referenceId));
      setFrameReferences((current) => current.filter((item) => item.claim.type !== "upload" || item.claim.reference_id !== referenceId));
    } catch (deleteError) {
      useAppStore.getState().pushToast(errMsg(deleteError), "error");
    }
  };

  const detachUpload = async (referenceId: string) => {
    if (readOnly) return;
    try {
      await API.detachFreeCreationReference(projectName, referenceId);
      setUploads((current) => current.filter((item) => item.reference_id !== referenceId));
      setOmniReferences((current) => current.filter((item) => item.claim.type !== "upload" || item.claim.reference_id !== referenceId));
      setFrameReferences((current) => current.filter((item) => item.claim.type !== "upload" || item.claim.reference_id !== referenceId));
    } catch (detachError) {
      useAppStore.getState().pushToast(errMsg(detachError), "error");
    }
  };

  const handleSubmit = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || readOnly || submitting || !capabilitiesReady || referenceIssue) return;
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
  const storyboardSourceReferenceId = uploads.find((upload) => upload.media_type === "text")?.reference_id;
  const ComposerModeIcon = composerMode === "agent" ? Bot : composerMode === "image" ? Image : Video;
  const agentRatioOptions = ASPECT_RATIO_OPTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }));
  const composerModeControl = (
    <HomeSelect
      label={t("free_creation_mode")}
      value={composerMode}
      icon={ComposerModeIcon}
      hideLabel
      placement={composerMode === "agent" ? "top" : "auto"}
      className="free-creation-mode-control"
      options={[
        { value: "agent", label: t("free_creation_mode_agent") },
        { value: "image", label: t("free_creation_mode_image") },
        { value: "video", label: t("free_creation_mode_video") },
      ]}
      onChange={changeComposerMode}
    />
  );
  const agentParameterControl = (
    <AgentParameterControl
      label={t("free_creation_agent_parameters")}
      preferenceLabel={t("free_creation_agent_generation_preference")}
      imageLabel={t("free_creation_agent_preference_image")}
      videoLabel={t("free_creation_agent_preference_video")}
      ratioLabel={t("free_creation_aspect_ratio")}
      preference={agentPreference}
      ratio={agentAspectRatio}
      ratioOptions={agentRatioOptions}
      onPreferenceChange={setAgentPreference}
      onRatioChange={setAgentAspectRatio}
      hideLabel
      placement="top"
    />
  );
  const agentMessageContext = t("free_creation_agent_prompt_context", {
    preference: agentPreference === "image"
      ? t("free_creation_agent_preference_image")
      : t("free_creation_agent_preference_video"),
    ratio: agentAspectRatio,
  });
  const referenceCardData = (reference: ComposerReference | null) => {
    if (!reference) return {};
    const claim = reference.claim;
    const resolvedMediaType = referenceMediaType(claim);
    if (claim.type === "upload") {
      const upload = uploads.find((item) => item.reference_id === claim.reference_id);
      return {
        mediaType: resolvedMediaType,
        previewUrl: upload ? API.getFileUrl(projectName, upload.path) : undefined,
      };
    }
    return {
      mediaType: resolvedMediaType,
      previewUrl: resolvedMediaType === "image"
        ? API.getFreeCreationMediaUrl(projectName, claim.creation_id)
        : undefined,
    };
  };
  const referenceItems: FreeCreationReferenceItem[] = references.map((reference) => {
    const cardData = referenceCardData(reference);
    return {
      id: claimKey(reference.claim),
      name: reference.label,
      mediaType: cardData.mediaType ?? referenceMediaType(reference.claim),
      role: reference.claim.role!,
      previewUrl: cardData.previewUrl,
    };
  });
  const removeComposerReference = (id: string) => {
    if (referenceMode === "frames") {
      setFrameReferences((current) => current.filter((item) => claimKey(item.claim) !== id));
    } else {
      setOmniReferences((current) => current.filter((item) => claimKey(item.claim) !== id));
    }
  };
  const swapFrameReferences = () => {
    setFrameReferences((current) => current.map((item) => ({
      ...item,
      claim: {
        ...item.claim,
        role: item.claim.role === "first_frame" ? "last_frame" : "first_frame",
      },
    })));
  };
  const hasCompletedVideo = creations.some((item) => (
    item.status === "succeeded" && (item.media_type === "video" || item.output_type === "video")
  ));
  const storyboardDisabledReason = readOnly
    ? t("free_creation_action_read_only")
    : submitting
      ? t("free_creation_action_busy")
      : !prompt.trim() && !storyboardSourceReferenceId
        ? t("free_creation_storyboard_prompt_required")
        : null;
  const subtitleDisabledReason = readOnly
    ? t("free_creation_action_read_only")
    : submitting
      ? t("free_creation_action_busy")
      : !hasCompletedVideo
        ? t("free_creation_subtitle_video_required")
        : null;
  const voiceDisabledReason = readOnly
    ? t("free_creation_action_read_only")
    : submitting
      ? t("free_creation_action_busy")
      : null;

  const mergeCreationVideos = async (creationIds: string[]) => {
    if (readOnly || merging || creationIds.length < 2) return;
    setMerging(true);
    try {
      const blob = await API.mergeFreeCreationVideos(projectName, creationIds);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${projectName}-merged.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      useAppStore.getState().pushToast(t("free_creation_merge_started"), "success");
    } catch (mergeError) {
      useAppStore.getState().pushToast(t("free_creation_merge_failed", { message: errMsg(mergeError) }), "error");
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[var(--color-background)] text-[var(--color-text)]">
      {composerMode === "agent" ? (
        <section className="absolute left-4 top-4 z-20 h-[min(68vh,600px)] w-[clamp(280px,28vw,380px)] max-w-[calc(100vw-2rem)] overflow-hidden border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] shadow-[0_18px_45px_-24px_oklch(0_0_0_/_0.9)]">
          <AgentCopilot
            embedded
            detachedComposer
            footerStart={<>{composerModeControl}{agentParameterControl}</>}
            messageContext={agentMessageContext}
          />
        </section>
      ) : (
        <FreeCreationSessionSummary requests={requests} />
      )}
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
          onReferences={addReferences}
          onPreview={setPreviewTarget}
          onDetachUpload={(referenceId) => void detachUpload(referenceId)}
          onDeleteUpload={(referenceId) => void deleteUpload(referenceId)}
          onMerge={(creationIds) => void mergeCreationVideos(creationIds)}
          onUploadFiles={uploadCanvasFiles}
        />
      </div>

      <div className="absolute inset-0 overflow-y-auto px-3 pb-[330px] pt-3 md:hidden">
        <div className="grid gap-3">
          {uploads.map((upload) => (
            <article key={upload.reference_id} className="overflow-hidden rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)]" onDoubleClick={(event) => { event.preventDefault(); setPreviewTarget({ kind: "upload", upload }); }}>
              <div className="flex h-10 items-center justify-between gap-3 border-b border-[var(--color-hairline)] px-3 text-xs"><span className="truncate font-medium">{upload.original_filename}</span><span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{t("free_creation_reference")}</span></div>
              <div role={upload.media_type === "audio" || upload.media_type === "video" ? undefined : "button"} tabIndex={upload.media_type === "audio" || upload.media_type === "video" ? undefined : 0} className="aspect-video w-full bg-black" onClick={(event) => referenceFromShortcut(event, { type: "upload", reference_id: upload.reference_id }, upload.original_filename)} onKeyDown={upload.media_type === "audio" || upload.media_type === "video" ? undefined : (event) => referenceFromShortcut(event, { type: "upload", reference_id: upload.reference_id }, upload.original_filename)} title={t("free_creation_reference_shortcut")}>
                {upload.media_type === "image" ? <img src={API.getFileUrl(projectName, upload.path)} alt={upload.original_filename} className="h-full w-full object-contain" /> : upload.media_type === "video" ? (
                  <video src={API.getFileUrl(projectName, upload.path)} className="h-full w-full object-contain" aria-label={upload.original_filename} controls onClick={(event) => referenceFromShortcut(event, { type: "upload", reference_id: upload.reference_id }, upload.original_filename)} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); setPreviewTarget({ kind: "upload", upload }); }} />
                ) : upload.media_type === "audio" ? <div className="flex h-full flex-col items-center justify-center gap-3 px-4"><AudioLines className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><audio src={API.getFileUrl(projectName, upload.path)} className="w-full" aria-label={upload.original_filename} controls /></div> : upload.media_type === "text" ? <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-muted)]"><FileText className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><span className="text-xs">{t("media_type_text")}</span></div> : <Link2 className="mx-auto pt-12 h-8 w-8 text-[var(--color-text-muted)]" aria-hidden />}
              </div>
              <div className="flex justify-end px-3 py-2"><button type="button" onClick={() => addReference({ type: "upload", reference_id: upload.reference_id }, upload.original_filename)} className="focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button></div>
            </article>
          ))}
          {mobileCreations.map((creation) => {
            const artifactType = creationMediaType(creation);
            const referenceRole = creationReferenceRole(creation);
            return (
              <article key={creation.creation_id} className="overflow-hidden rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)]" onDoubleClick={(event) => { event.preventDefault(); if (creation.status === "succeeded" && creation.media_path) setPreviewTarget({ kind: "creation", creation }); }}>
                <div className="flex h-10 items-center justify-between gap-3 border-b border-[var(--color-hairline)] px-3 text-xs"><span className="font-medium">{t(`free_creation_${creation.output_type}`)}</span><span className="text-[10px] text-[var(--color-text-muted)]">{t(`free_creation_status_${creation.status}`)}</span></div>
                {creation.status === "succeeded" && creation.media_path ? artifactType === "video" ? (
                  <video src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} className="aspect-video w-full bg-black object-contain" aria-label={creation.prompt ?? creation.creation_id} controls onClick={(event) => referenceFromShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: "reference_video" }, creation.prompt || t("free_creation"))} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); setPreviewTarget({ kind: "creation", creation }); }} />
                ) : artifactType === "audio" ? <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-black px-4"><AudioLines className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><audio src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} className="w-full" aria-label={creation.prompt ?? creation.creation_id} controls /></div> : <div role="button" tabIndex={0} className="aspect-video w-full bg-black" onClick={(event) => referenceFromShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: "reference_image" }, creation.prompt || t("free_creation"))} onKeyDown={(event) => referenceFromShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: "reference_image" }, creation.prompt || t("free_creation"))}><img src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} alt={creation.prompt ?? creation.creation_id} className="h-full w-full object-contain" /></div> : <div className="grid aspect-video place-items-center bg-black px-3 text-center text-xs text-[var(--color-text-muted)]">{creation.status === "failed" ? t("free_creation_failed") : t(`free_creation_status_${creation.status}`)}</div>}
                <p className="line-clamp-2 px-3 py-2 text-xs leading-5 text-[var(--color-text-2)]">{creation.prompt || t("free_creation_prompt")}</p>
                {creation.status === "succeeded" && creation.media_path ? <div className="flex justify-end gap-1 border-t border-[var(--color-hairline)] p-2"><button type="button" onClick={() => addReference({ type: "creation", creation_id: creation.creation_id, version: creation.version, role: referenceRole }, creation.prompt || t("free_creation"))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)]" aria-label={t("free_creation_add_reference")}><Link2 className="h-4 w-4" aria-hidden /></button>{artifactType === "image" ? <button type="button" onClick={() => editFromCreation(creation.creation_id)} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)]" aria-label={t("free_creation_use_as_parent")}><Pencil className="h-4 w-4" aria-hidden /></button> : null}<a href={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} download className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)]" aria-label={t("free_creation_download")}><Download className="h-4 w-4" aria-hidden /></a></div> : null}
              </article>
            );
          })}
          {uploads.length === 0 && mobileCreations.length === 0 ? <p className="py-20 text-center text-sm text-[var(--color-text-muted)]">{t("free_creation_empty")}</p> : null}
        </div>
      </div>

      {composerMode !== "agent" ? (
      <section className="free-creation-composer absolute bottom-3 left-1/2 z-30 w-[min(920px,calc(100vw-1.5rem))] -translate-x-1/2 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)]/96 p-3 shadow-lg backdrop-blur-md sm:bottom-4 sm:p-4">
        {selectedParent ? (
          <div className="mb-2 flex items-center gap-2 rounded-md bg-[var(--color-accent-dim)] px-2.5 py-1.5 text-xs text-[var(--color-accent-2)]">
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("free_creation_editing_result", { prompt: selectedParent.prompt || t("free_creation") })}</span>
            <button type="button" onClick={clearEdit} className="focus-ring grid h-6 w-6 place-items-center rounded" aria-label={t("free_creation_cancel_edit")}><X className="h-3.5 w-3.5" aria-hidden /></button>
          </div>
        ) : null}

        <FreeCreationReferenceInput
          mode={referenceMode}
          outputType={effectiveMediaType}
          capabilities={capabilities}
          items={referenceItems}
          compact
          busy={uploading || submitting}
          disabled={readOnly || !capabilities}
          onUploadRequest={openReferencePicker}
          onFilesDropped={(files) => void uploadReferences(files)}
          onRemove={removeComposerReference}
          onSwapFrames={swapFrameReferences}
        >
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void handleSubmit(); } }} rows={3} maxLength={10000} placeholder={t("free_creation_prompt")} className="min-h-[88px] w-full min-w-0 resize-none bg-transparent px-2.5 py-2 text-sm leading-5 outline-none placeholder:text-[var(--color-text-muted)]" disabled={readOnly || submitting} />
        </FreeCreationReferenceInput>
        <input ref={fileInputRef} type="file" className="sr-only" aria-label={t("free_creation_upload_reference")} onChange={(event) => void uploadReferences(event.target.files)} />
          <div
            className="composer-param-strip free-creation-parameter-strip mt-2 flex items-center gap-1.5 border-y border-[var(--color-hairline)] py-2"
            onWheel={handleComposerStripWheel}
          >
            {composerModeControl}
            {effectiveMediaType === "video" && !selectedParent ? (
              <HomeSelect
                label={t("free_creation_reference_mode")}
                value={referenceMode}
                icon={Layers3}
                hideLabel
                className="free-creation-reference-mode-control"
                placement="top"
                options={[
                  { value: "omni", label: t("free_creation_reference_mode_all") },
                  {
                    value: "frames",
                    label: t("free_creation_reference_mode_frames"),
                    disabled: !supportsFrameReferences(capabilities),
                    disabledReason: t("free_creation_frames_model_unsupported"),
                  },
                ]}
                onChange={setReferenceMode}
              />
            ) : null}
            <div className="contents">
              <HomeSelect
                label={t("home_model")}
                value={selectedModel}
                icon={Settings2}
                hideLabel
                className="home-model-control free-creation-model-control"
                placement="top"
                searchable
                searchPlaceholder={t("home_model_search")}
                emptyLabel={t("home_model_no_results")}
                options={[
                  { value: "auto", label: t("home_model_auto") },
                  ...modelOptions.map((option) => ({ value: option, label: modelLabel(option, t("home_model_auto")) })),
                ]}
                onChange={setModel}
              />
              <div className="home-param-control free-creation-asset-control">
                <button
                  type="button"
                  onClick={() => setAssetPickerOpen(true)}
                  disabled={readOnly || uploading || submitting || (() => {
                    const limit = referenceUploadLimit(capabilities, referenceMode, effectiveMediaType);
                    return limit !== null && references.length >= limit;
                  })()}
                  className="home-param-trigger"
                  title={t("free_creation_reference_assets")}
                  aria-label={t("free_creation_reference_assets")}
                >
                  <span className="home-param-trigger__value">
                    <Library className="home-param-trigger__icon" aria-hidden />
                    <span className="truncate">{t("free_creation_reference_assets")}</span>
                  </span>
                </button>
              </div>
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
                  hideLabel
                  placement="top"
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
                  hideLabel
                  placement="top"
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
                  hideLabel
                  placement="top"
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
            <HomeMenu
              label={t("free_creation_tools")}
              icon={WandSparkles}
              placement="top"
              items={[
                { value: "storyboard", label: t("free_creation_storyboard_plan"), icon: Clapperboard, disabled: Boolean(storyboardDisabledReason), disabledReason: storyboardDisabledReason ?? undefined },
                { value: "voice", label: t("free_creation_voice_action"), icon: AudioLines, disabled: Boolean(voiceDisabledReason), disabledReason: voiceDisabledReason ?? undefined },
                { value: "subtitle", label: t("free_creation_subtitle_action"), icon: Captions, disabled: Boolean(subtitleDisabledReason), disabledReason: subtitleDisabledReason ?? undefined },
              ]}
              onSelect={(value) => {
                if (value === "storyboard") setStoryboardOpen(true);
                else if (value === "voice") setVoiceOpen(true);
                else setSubtitleOpen(true);
              }}
            />
          </div>
        {storyboardDisabledReason || voiceDisabledReason || subtitleDisabledReason ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[10px] leading-4 text-[var(--color-text-muted)]" role="status">
            {storyboardDisabledReason ? <span>{t("free_creation_storyboard_plan")}: {storyboardDisabledReason}</span> : null}
            {voiceDisabledReason ? <span>{t("free_creation_voice_action")}: {voiceDisabledReason}</span> : null}
            {subtitleDisabledReason ? <span>{t("free_creation_subtitle_action")}: {subtitleDisabledReason}</span> : null}
          </div>
        ) : null}

        <div className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--color-hairline)] pt-2">
          <p
            className={`min-h-4 min-w-0 flex-1 truncate text-xs ${capabilityError || error ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}
            role={capabilityError || error ? "alert" : "status"}
          >
            {capabilityError || error || referenceIssueMessage || t("free_creation_result_count", { count: totalCreations })}
          </p>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!prompt.trim() || readOnly || submitting || !capabilitiesReady || Boolean(referenceIssue)}
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
      ) : null}
      <FreeCreationPreviewDialog
        projectName={projectName}
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
      />
      <FreeCreationStoryboardPanel
        projectName={projectName}
        open={storyboardOpen}
        prompt={prompt}
        sourceReferenceId={storyboardSourceReferenceId}
        aspectRatio={effectiveAspectRatio}
        resolution={effectiveMediaType === "image" ? selectedResolution : undefined}
        onClose={() => setStoryboardOpen(false)}
        onCreated={() => void loadCreations()}
      />
      <FreeCreationVoicePanel
        projectName={projectName}
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onCreated={() => void loadCreations()}
      />
      <FreeCreationSubtitlePanel
        projectName={projectName}
        open={subtitleOpen}
        creations={creations}
        onClose={() => setSubtitleOpen(false)}
        onCreated={() => void loadCreations()}
      />
      {assetPickerOpen ? (
        <FreeCreationAssetPickerModal
          maxSelection={referenceUploadLimit(capabilities, referenceMode, effectiveMediaType) === null
            ? null
            : Math.max(0, (referenceUploadLimit(capabilities, referenceMode, effectiveMediaType) ?? 0) - references.length)}
          busy={importingAssets}
          onClose={() => {
            if (!importingAssets) setAssetPickerOpen(false);
          }}
          onImport={importAssetReferences}
        />
      ) : null}
    </div>
  );
}
