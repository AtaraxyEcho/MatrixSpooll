import { useEffect, useMemo, useRef, useState } from "react";
import { Download, LocateFixed, Loader2, Pencil, RotateCcw, ZoomIn, ZoomOut, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import { AspectFrame } from "@/components/ui/AspectFrame";
import type { FreeCreation } from "@/types";

interface Point {
  x: number;
  y: number;
}

interface FreeCreationInfiniteCanvasProps {
  projectName: string;
  creations: FreeCreation[];
  readOnly: boolean;
  actingId: string | null;
  onCancel: (creationId: string) => void;
  onRetry: (creationId: string) => void;
  onEdit: (creationId: string) => void;
}

const NODE_WIDTH = 264;
const NODE_HEIGHT = 286;
const CANVAS_WIDTH = 1900;
const CANVAS_HEIGHT = 1400;

function initialPosition(index: number): Point {
  const column = index % 5;
  const row = Math.floor(index / 5);
  return { x: 100 + column * 350, y: 100 + row * 340 };
}

export function FreeCreationInfiniteCanvas({
  projectName,
  creations,
  readOnly,
  actingId,
  onCancel,
  onRetry,
  onEdit,
}: FreeCreationInfiniteCanvasProps) {
  const { t } = useTranslation("dashboard");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const pointerRef = useRef<
    | { kind: "pan"; pointerId: number; startX: number; startY: number; origin: Point }
    | { kind: "node"; pointerId: number; id: string; startX: number; startY: number; origin: Point }
    | null
  >(null);

  useEffect(() => {
    // Server polling can append nodes while the user is working; retain dragged positions.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPositions((current) => {
      const next = { ...current };
      let changed = false;
      creations.forEach((creation, index) => {
        if (!next[creation.creation_id]) {
          next[creation.creation_id] = initialPosition(index);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [creations]);

  const orderedCreations = useMemo(
    () => [...creations].sort((left, right) => (left.updated_at ?? "").localeCompare(right.updated_at ?? "")),
    [creations],
  );

  const updatePointer = (event: React.PointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    if (pointer.kind === "pan") {
      setPan({
        x: pointer.origin.x + event.clientX - pointer.startX,
        y: pointer.origin.y + event.clientY - pointer.startY,
      });
      return;
    }
    setPositions((current) => ({
      ...current,
      [pointer.id]: {
        x: pointer.origin.x + (event.clientX - pointer.startX) / scale,
        y: pointer.origin.y + (event.clientY - pointer.startY) / scale,
      },
    }));
  };

  const finishPointer = (event: React.PointerEvent<HTMLElement>) => {
    if (pointerRef.current?.pointerId === event.pointerId) {
      pointerRef.current = null;
      setIsPanning(false);
    }
  };

  const handleSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, video, [data-canvas-node='true']")) return;
    pointerRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: pan,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleNodePointerDown = (event: React.PointerEvent<HTMLDivElement>, id: string) => {
    event.stopPropagation();
    const origin = positions[id] ?? { x: 0, y: 0 };
    pointerRef.current = {
      kind: "node",
      pointerId: event.pointerId,
      id,
      startX: event.clientX,
      startY: event.clientY,
      origin,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(id);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setScale((current) => Math.min(1.35, Math.max(0.55, current - event.deltaY * 0.001)));
  };

  const resetView = () => {
    setPan({ x: 0, y: 0 });
    setScale(1);
  };

  return (
    <div
      ref={surfaceRef}
      className="absolute inset-0 overflow-hidden bg-[var(--color-background)]"
      onPointerDown={handleSurfacePointerDown}
      onPointerMove={updatePointer}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onWheel={handleWheel}
      style={{ cursor: isPanning ? "grabbing" : "grab", touchAction: "none" }}
      data-testid="free-creation-canvas"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "linear-gradient(oklch(1 0 0 / 0.045) 1px, transparent 1px), linear-gradient(90deg, oklch(1 0 0 / 0.045) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="absolute right-4 top-4 z-20 flex items-center gap-1 border border-[var(--color-hairline)] bg-[var(--color-surface)]/90 p-1 shadow-lg backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setScale((current) => Math.min(1.35, current + 0.1))}
          className="grid h-8 w-8 place-items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          title={t("free_creation_zoom_in")}
          aria-label={t("free_creation_zoom_in")}
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="min-w-12 text-center text-[11px] text-[var(--color-text-muted)]">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          onClick={() => setScale((current) => Math.max(0.55, current - 0.1))}
          className="grid h-8 w-8 place-items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          title={t("free_creation_zoom_out")}
          aria-label={t("free_creation_zoom_out")}
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={resetView}
          className="grid h-8 w-8 place-items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          title={t("free_creation_reset_canvas")}
          aria-label={t("free_creation_reset_canvas")}
        >
          <LocateFixed className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div
        className="absolute left-0 top-0"
        style={{
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          {orderedCreations.map((creation) => {
            if (!creation.parent_creation_id) return null;
            const from = positions[creation.parent_creation_id];
            const to = positions[creation.creation_id];
            if (!from || !to) return null;
            return (
              <line
                key={`${creation.parent_creation_id}-${creation.creation_id}`}
                x1={from.x + NODE_WIDTH}
                y1={from.y + NODE_HEIGHT / 2}
                x2={to.x}
                y2={to.y + NODE_HEIGHT / 2}
                stroke="var(--color-accent)"
                strokeOpacity="0.45"
                strokeWidth="2"
              />
            );
          })}
        </svg>

        {orderedCreations.map((creation) => {
          const position = positions[creation.creation_id];
          if (!position) return null;
          const selected = selectedId === creation.creation_id;
          const isVideo = creation.media_type === "video" || creation.output_type === "video";
          const statusLabel = creation.status === "failed"
            ? t("free_creation_failed")
            : t(`free_creation_status_${creation.status}`);
          return (
            <article
              key={creation.creation_id}
              className={`absolute overflow-hidden border bg-[var(--color-surface)] shadow-xl transition-shadow ${
                selected
                  ? "border-[var(--color-accent)] shadow-[0_0_0_2px_var(--color-accent-dim),0_18px_40px_-20px_var(--color-accent-glow)]"
                  : "border-[var(--color-hairline)]"
              }`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH }}
              data-canvas-node="true"
            >
              <div
                className="flex cursor-grab items-center justify-between gap-2 border-b border-[var(--color-hairline)] px-3 py-2 active:cursor-grabbing"
                onPointerDown={(event) => handleNodePointerDown(event, creation.creation_id)}
              >
                <span className="truncate text-[11px] font-semibold text-[var(--color-text)]">
                  {t(`free_creation_${creation.output_type}`)}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{statusLabel}</span>
              </div>

              {creation.status === "succeeded" && creation.media_path ? (
                <AspectFrame ratio={creation.aspect_ratio ?? "9:16"} className="bg-black">
                  {isVideo ? (
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
                  <div className="flex h-full items-center justify-center px-3 text-center text-xs text-[var(--color-text-muted)]">
                    {creation.status === "failed" ? t("free_creation_failed") : statusLabel}
                  </div>
                </AspectFrame>
              )}

              <div className="p-3">
                <p className="line-clamp-3 min-h-12 text-xs leading-5 text-[var(--color-text-2)]">
                  {creation.prompt || t("free_creation_prompt")}
                </p>
                {!readOnly ? (
                  <div className="mt-2 flex min-h-8 items-center justify-end gap-1 border-t border-[var(--color-hairline)] pt-2">
                    {creation.status === "queued" || creation.status === "running" ? (
                      <button
                        type="button"
                        onClick={() => onCancel(creation.creation_id)}
                        disabled={actingId === creation.creation_id}
                        className="inline-flex h-8 w-8 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
                        aria-label={t("free_creation_cancel")}
                        title={t("free_creation_cancel")}
                      >
                        {actingId === creation.creation_id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <XCircle className="h-4 w-4" aria-hidden="true" />}
                      </button>
                    ) : null}
                    {creation.status === "failed" || creation.status === "cancelled" ? (
                      <button
                        type="button"
                        onClick={() => onRetry(creation.creation_id)}
                        disabled={actingId === creation.creation_id}
                        className="inline-flex h-8 w-8 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
                        aria-label={t("free_creation_retry")}
                        title={t("free_creation_retry")}
                      >
                        {actingId === creation.creation_id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-4 w-4" aria-hidden="true" />}
                      </button>
                    ) : null}
                    {creation.status === "succeeded" && creation.output_type !== "video" ? (
                      <button
                        type="button"
                        onClick={() => onEdit(creation.creation_id)}
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
                        resourceType={isVideo ? "free_videos" : "free_images"}
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
          );
        })}
      </div>

      {creations.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 pb-44 text-center">
          <div className="max-w-sm">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-[var(--color-accent-soft)] bg-[var(--color-accent-dim)] text-[var(--color-accent-2)]">
              <LocateFixed className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">{t("free_creation_empty")}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
