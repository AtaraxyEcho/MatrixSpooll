import {
  ArrowLeftRight,
  AudioLines,
  FileText,
  Image as ImageIcon,
  Plus,
  Video,
  X,
} from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  FreeCreationCapabilities,
  FreeCreationOutputType,
  FreeCreationReferenceRole,
  FreeCreationUploadMediaType,
} from "@/types";

export type FreeCreationReferenceMode = "omni" | "frames";

export interface FreeCreationReferenceItem {
  id: string;
  name: string;
  mediaType: FreeCreationUploadMediaType;
  role: FreeCreationReferenceRole;
  previewUrl?: string;
}

export type ReferenceAdmissionIssue = "unsupported_type" | "slot_limit" | "total_limit" | null;

const OMNI_ROLE_BY_MEDIA_TYPE: Record<FreeCreationUploadMediaType, FreeCreationReferenceRole> = {
  image: "reference_image",
  video: "reference_video",
  audio: "reference_audio",
  text: "prompt_context",
};

const OMNI_ROLES = new Set<FreeCreationReferenceRole>(Object.values(OMNI_ROLE_BY_MEDIA_TYPE));

export function automaticReferenceRole(mediaType: FreeCreationUploadMediaType): FreeCreationReferenceRole {
  return OMNI_ROLE_BY_MEDIA_TYPE[mediaType];
}

function roleLimit(
  capabilities: FreeCreationCapabilities | null,
  role: FreeCreationReferenceRole,
  outputType: FreeCreationOutputType,
): number | null {
  const declared = capabilities?.input_slots?.find((slot) => slot.role === role)?.max_count;
  if (declared !== undefined) return declared;
  // The image capability endpoint switches from t2i to i2i after the first image is attached.
  if (outputType === "image" && role === "reference_image") return 32;
  return null;
}

export function referenceUploadLimit(
  capabilities: FreeCreationCapabilities | null,
  mode: FreeCreationReferenceMode,
  outputType: FreeCreationOutputType,
): number | null {
  if (mode === "frames") return 2;
  if (!capabilities) return null;
  if (capabilities.max_reference_media_count !== null) return capabilities.max_reference_media_count;

  const limits = (capabilities.input_slots ?? [])
    .filter((slot) => OMNI_ROLES.has(slot.role))
    .map((slot) => slot.max_count);
  if (outputType === "image") limits.push(32);
  return limits.length ? limits.reduce((total, value) => total + value, 0) : 0;
}

export function referenceAdmissionIssue({
  items,
  mediaType,
  role,
  capabilities,
  outputType,
  mode,
}: {
  items: FreeCreationReferenceItem[];
  mediaType: FreeCreationUploadMediaType;
  role: FreeCreationReferenceRole;
  capabilities: FreeCreationCapabilities | null;
  outputType: FreeCreationOutputType;
  mode: FreeCreationReferenceMode;
}): ReferenceAdmissionIssue {
  if (mode === "frames" && mediaType !== "image") return "unsupported_type";
  const slot = capabilities?.input_slots?.find(
    (candidate) => candidate.role === role && candidate.accepted_types.includes(mediaType),
  );
  const limit = slot?.max_count ?? roleLimit(capabilities, role, outputType);
  if (!slot && !(outputType === "image" && role === "reference_image")) return "unsupported_type";
  if (limit !== null && items.filter((item) => item.role === role).length >= limit) return "slot_limit";

  const totalLimit = referenceUploadLimit(capabilities, mode, outputType);
  if (totalLimit !== null && items.length >= totalLimit) return "total_limit";
  return null;
}

export function referenceAccept(
  capabilities: FreeCreationCapabilities | null,
  mode: FreeCreationReferenceMode,
  outputType: FreeCreationOutputType,
): string {
  if (mode === "frames") return "image/png,image/jpeg,image/webp";
  const accepted = new Set(
    (capabilities?.input_slots ?? [])
      .filter((slot) => OMNI_ROLES.has(slot.role))
      .flatMap((slot) => slot.accepted_types),
  );
  if (outputType === "image") {
    accepted.add("image");
    accepted.add("text");
  }
  const values: string[] = [];
  if (accepted.has("image")) values.push("image/png", "image/jpeg", "image/webp");
  if (accepted.has("video")) values.push("video/mp4", "video/quicktime");
  if (accepted.has("audio")) values.push("audio/wav", "audio/mpeg");
  if (accepted.has("text")) {
    values.push(
      "text/plain",
      "text/markdown",
      "application/pdf",
      "application/rtf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/epub+zip",
      ".txt",
      ".md",
      ".markdown",
      ".rtf",
      ".doc",
      ".docx",
      ".pdf",
      ".epub",
    );
  }
  return values.join(",");
}

export function supportsFrameReferences(capabilities: FreeCreationCapabilities | null): boolean {
  return Boolean(
    capabilities?.input_slots?.some((slot) => slot.role === "first_frame")
    && capabilities.input_slots.some((slot) => slot.role === "last_frame"),
  );
}

function ReferenceIcon({ mediaType, className }: { mediaType: FreeCreationUploadMediaType; className: string }) {
  const Icon = mediaType === "video"
    ? Video
    : mediaType === "audio"
      ? AudioLines
      : mediaType === "text"
        ? FileText
        : ImageIcon;
  return <Icon className={className} aria-hidden />;
}

function FrameSlot({
  label,
  item,
  compact,
  disabled,
  busy,
  onPick,
  onRemove,
}: {
  label: string;
  item?: FreeCreationReferenceItem;
  compact: boolean;
  disabled: boolean;
  busy: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <div className={`relative shrink-0 ${compact ? "h-[96px] w-[72px]" : "h-[112px] w-[84px]"}`}>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled || busy}
        className="focus-ring group relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-md border border-dashed border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-45"
        aria-label={item ? t("free_creation_replace_frame", { frame: label }) : t("free_creation_add_frame", { frame: label })}
        title={item?.name ?? label}
      >
        {item?.previewUrl && item.mediaType === "image" ? (
          <img src={item.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : item ? (
          <ReferenceIcon mediaType={item.mediaType} className="h-6 w-6 text-[var(--color-accent-2)]" />
        ) : (
          <Plus className="h-5 w-5" aria-hidden />
        )}
        <span className={`absolute inset-x-0 bottom-0 truncate bg-[oklch(0.08_0.006_265_/_0.88)] px-1.5 py-1 text-center text-[10px] font-medium text-[var(--color-text-2)] ${item?.previewUrl ? "" : "border-t border-[var(--color-hairline)]"}`}>
          {item?.name ?? label}
        </span>
      </button>
      {item ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="focus-ring absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[oklch(0.08_0.006_265_/_0.9)] text-[var(--color-text-2)] hover:text-[var(--color-text)]"
          aria-label={`${t("free_creation_remove_reference")}: ${item.name}`}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export interface FreeCreationReferenceInputProps {
  children: ReactNode;
  mode: FreeCreationReferenceMode;
  outputType: FreeCreationOutputType;
  capabilities: FreeCreationCapabilities | null;
  items: FreeCreationReferenceItem[];
  compact?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onUploadRequest: (frameRole?: "first_frame" | "last_frame") => void;
  onFilesDropped?: (files: File[]) => void;
  onRemove: (id: string) => void;
  onSwapFrames: () => void;
}

export function FreeCreationReferenceInput({
  children,
  mode,
  outputType,
  capabilities,
  items,
  compact = false,
  busy = false,
  disabled = false,
  onUploadRequest,
  onFilesDropped,
  onRemove,
  onSwapFrames,
}: FreeCreationReferenceInputProps) {
  const { t } = useTranslation("dashboard");
  const [dragActive, setDragActive] = useState(false);
  const firstFrame = items.find((item) => item.role === "first_frame");
  const lastFrame = items.find((item) => item.role === "last_frame");
  const limit = referenceUploadLimit(capabilities, mode, outputType);
  const framesSupported = outputType === "video" && supportsFrameReferences(capabilities);
  const reachedLimit = limit !== null && items.length >= limit;
  const noAcceptedTypes = !referenceAccept(capabilities, mode, outputType);
  const uploadDisabled = disabled || busy || noAcceptedTypes || (mode === "omni" && reachedLimit);
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (disabled || busy || !onFilesDropped) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) onFilesDropped(files);
  };

  return (
    <div
      className={`free-reference-input overflow-hidden rounded-md border bg-[var(--color-background)] transition-colors focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-dim)] ${dragActive ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-dim)]" : "border-[var(--color-hairline)]"}`}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={handleDrop}
    >
      <div className="flex min-w-0 items-center gap-3 p-2">
        {mode === "omni" ? (
          <button
            type="button"
            onClick={() => onUploadRequest()}
            disabled={uploadDisabled}
            className={`focus-ring group relative flex shrink-0 flex-col items-center justify-center rounded-md border border-dashed border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-45 ${compact ? "h-[96px] w-[72px]" : "h-[112px] w-[84px]"}`}
            aria-label={t("free_creation_upload_reference")}
            title={reachedLimit ? t("free_creation_reference_limit_reached", { count: limit }) : t("free_creation_upload_reference")}
          >
            <Plus className="h-5 w-5" aria-hidden />
            <span className="absolute inset-x-0 bottom-0 border-t border-[var(--color-hairline)] px-1 py-1 text-center text-[10px] font-medium">
              {t("free_creation_reference_content")}
            </span>
          </button>
        ) : null}
        {mode === "frames" ? (
          <div className="flex shrink-0 items-center gap-2" aria-label={t("free_creation_reference_mode_frames")}>
            <FrameSlot
              label={t("free_creation_first_frame")}
              item={firstFrame}
              compact={compact}
              disabled={disabled || !framesSupported}
              busy={busy}
              onPick={() => onUploadRequest("first_frame")}
              onRemove={() => firstFrame && onRemove(firstFrame.id)}
            />
            <button
              type="button"
              onClick={onSwapFrames}
              disabled={disabled || busy || (!firstFrame && !lastFrame)}
              className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--color-hairline-strong)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-35"
              aria-label={t("free_creation_swap_frames")}
              title={t("free_creation_swap_frames")}
            >
              <ArrowLeftRight className="h-4 w-4" aria-hidden />
            </button>
            <FrameSlot
              label={t("free_creation_last_frame")}
              item={lastFrame}
              compact={compact}
              disabled={disabled || !framesSupported}
              busy={busy}
              onPick={() => onUploadRequest("last_frame")}
              onRemove={() => lastFrame && onRemove(lastFrame.id)}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1 self-stretch">
          {mode === "omni" && items.length ? (
            <div className="flex max-h-[72px] flex-wrap gap-1.5 overflow-y-auto border-t border-[var(--color-hairline)] px-2.5 py-2" aria-label={t("free_creation_reference_content")}>
              {items.map((item) => (
                <span key={item.id} className="free-reference-chip inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] pl-2 pr-1 text-[11px] text-[var(--color-text-2)]" title={item.name}>
                  <ReferenceIcon mediaType={item.mediaType} className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-2)]" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className="focus-ring grid h-5 w-5 shrink-0 place-items-center rounded-full text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.06)] hover:text-[var(--color-text)]"
                    aria-label={`${t("free_creation_remove_reference")}: ${item.name}`}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {children}
        </div>
      </div>
      <div className="flex min-h-7 items-center justify-between border-t border-[var(--color-hairline)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]">
        <span>{dragActive ? t("free_creation_drop_reference") : t("free_creation_drag_reference_hint")}</span>
        <span className="tabular-nums" aria-label={t("free_creation_reference_capacity")}>
          {limit === null ? items.length : t("free_creation_reference_count", { count: items.length, limit })}
        </span>
      </div>
    </div>
  );
}
