import {
  AudioLines,
  Captions,
  FileText,
  Image as ImageIcon,
  Video,
} from "lucide-react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";

export type CanvasNodeLabelType = "image" | "video" | "audio" | "text" | "subtitle";

interface CanvasNodeLabelProps {
  label: string;
  mediaType: CanvasNodeLabelType;
  scale: number;
  selected?: boolean;
  title?: string;
  onSelect: (additive: boolean) => void;
}

const LABEL_ICONS = {
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  text: FileText,
  subtitle: Captions,
} as const;

export function CanvasNodeLabel({
  label,
  mediaType,
  scale,
  selected = false,
  title,
  onSelect,
}: CanvasNodeLabelProps) {
  const Icon = LABEL_ICONS[mediaType];
  const labelStyle = {
    "--canvas-label-inverse-scale": String(1 / Math.max(scale, Number.EPSILON)),
  } as CSSProperties;

  const stopPointer = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const select = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onSelect(event.shiftKey);
  };

  return (
    <button
      type="button"
      className="canvas-node-label focus-ring absolute bottom-[calc(100%+8px)] left-0 z-20 flex max-w-[240px] origin-bottom-left items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-left text-[11px] leading-4 text-[var(--color-text)] shadow-sm backdrop-blur-sm transition-colors hover:bg-black/70"
      style={labelStyle}
      title={title ?? label}
      aria-label={label}
      aria-pressed={selected}
      onPointerDown={stopPointer}
      onClick={select}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

interface CanvasNodeStatusDotProps {
  status: string;
  label: string;
}

export function CanvasNodeStatusDot({ status, label }: CanvasNodeStatusDotProps) {
  if (status !== "failed" && status !== "running") return null;
  return (
    <span
      className={`pointer-events-none absolute right-2.5 top-2.5 z-20 h-2.5 w-2.5 rounded-full ring-2 ring-black/55 ${status === "failed" ? "bg-[var(--color-danger)]" : "animate-pulse bg-[var(--color-accent)] motion-reduce:animate-none"}`}
      data-canvas-status={status}
      title={label}
      aria-hidden
    />
  );
}
