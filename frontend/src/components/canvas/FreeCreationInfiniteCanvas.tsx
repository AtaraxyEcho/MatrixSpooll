/* eslint-disable jsx-a11y/media-has-caption */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Download,
  Eye,
  EyeOff,
  FileText,
  Link2,
  Loader2,
  LocateFixed,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { VersionTimeMachine } from "@/components/canvas/timeline/VersionTimeMachine";
import type { FreeCreationPreviewTarget } from "@/components/canvas/FreeCreationPreviewDialog";
import { useAppStore } from "@/stores/app-store";
import { useFreeCreationStore } from "@/stores/free-creation-store";
import type {
  FreeCreation,
  FreeCreationReferenceClaim,
  FreeCreationUpload,
} from "@/types";
import { freeCreationUploadRole } from "@/types";
import { errMsg } from "@/utils/async";

interface Point {
  x: number;
  y: number;
}

interface FreeCreationInfiniteCanvasProps {
  projectName: string;
  creations: FreeCreation[];
  uploads: FreeCreationUpload[];
  readOnly: boolean;
  actingId: string | null;
  onCancel: (creationId: string) => void;
  onRetry: (creationId: string) => void;
  onEdit: (creationId: string) => void;
  onReference: (reference: FreeCreationReferenceClaim, label: string) => void;
  onPreview?: (target: FreeCreationPreviewTarget) => void;
  onDetachUpload?: (referenceId: string) => void;
  onDeleteUpload?: (referenceId: string) => void;
}

type PointerOperation =
  | { kind: "pan"; pointerId: number; start: Point; origin: Point }
  | { kind: "marquee"; pointerId: number; start: Point; current: Point; additive: boolean }
  | { kind: "nodes"; pointerId: number; start: Point; origins: Record<string, Point> };

interface ContextMenuState {
  nodeId: string;
  kind: "creation" | "upload";
  x: number;
  y: number;
}

const NODE_WIDTH = 272;
const NODE_HEIGHT = 322;
const NODE_GAP_X = 72;
const NODE_GAP_Y = 56;
const MIN_SCALE = 0.4;
const MAX_SCALE = 1.8;

function initialPosition(index: number): Point {
  const column = index % 4;
  const row = Math.floor(index / 4);
  return { x: 96 + column * (NODE_WIDTH + NODE_GAP_X), y: 88 + row * (NODE_HEIGHT + NODE_GAP_Y) };
}

function intersects(left: DOMRect, right: DOMRect): boolean {
  return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
}

function canvasSnapshot(
  viewport: { x: number; y: number; scale: number },
  positions: Record<string, Point>,
  hiddenCreationIds: string[],
  hiddenReferenceIds: string[],
): string {
  return JSON.stringify({ viewport, positions, hidden_creation_ids: [...hiddenCreationIds].sort(), hidden_reference_ids: [...hiddenReferenceIds].sort() });
}

export function FreeCreationInfiniteCanvas({
  projectName,
  creations,
  uploads,
  readOnly,
  actingId,
  onCancel,
  onRetry,
  onEdit,
  onReference,
  onPreview,
  onDetachUpload,
  onDeleteUpload,
}: FreeCreationInfiniteCanvasProps) {
  const { t } = useTranslation("dashboard");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const pointerRef = useRef<PointerOperation | null>(null);
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const lastSavedSnapshotRef = useRef("");
  const disposedRef = useRef(false);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [hiddenUploadIds, setHiddenUploadIds] = useState<string[]>([]);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [spacePressed, setSpacePressed] = useState(false);
  const [marquee, setMarquee] = useState<{ start: Point; current: Point } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const orderedCreations = useMemo(
    () => [...creations].sort((left, right) => (left.updated_at ?? "").localeCompare(right.updated_at ?? "")),
    [creations],
  );
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const visibleCreations = useMemo(
    () => orderedCreations.filter((creation) => showHidden || !hiddenSet.has(creation.creation_id)),
    [hiddenSet, orderedCreations, showHidden],
  );
  const hiddenUploadSet = useMemo(() => new Set(hiddenUploadIds), [hiddenUploadIds]);
  const visibleUploads = useMemo(
    () => uploads.filter((upload) => showHidden || !hiddenUploadSet.has(upload.reference_id)),
    [hiddenUploadSet, showHidden, uploads],
  );
  const allNodes = useMemo(
    () => [
      ...uploads.map((upload) => ({ id: upload.reference_id, kind: "upload" as const })),
      ...orderedCreations.map((creation) => ({ id: creation.creation_id, kind: "creation" as const })),
    ],
    [orderedCreations, uploads],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const publishSelection = useCallback((ids: string[]) => {
    setSelectedIds(ids);
    const selectedCreations = creations.filter(
      (item) => ids.includes(item.creation_id) && item.status === "succeeded" && Boolean(item.media_path),
    );
    const requestIds = new Set(selectedCreations.map((item) => item.request_id).filter(Boolean));
    useFreeCreationStore.getState().setSelection(
      selectedCreations.map((item) => item.creation_id),
      requestIds.size === 1 ? [...requestIds][0] ?? null : null,
    );
  }, [creations]);

  useEffect(() => {
    disposedRef.current = false;
    hydratedRef.current = false;
    revisionRef.current = 0;
    lastSavedSnapshotRef.current = "";
    const controller = new AbortController();
    void API.getFreeCreationCanvas(projectName)
      .then(({ canvas }) => {
        if (controller.signal.aborted) return;
        lastSavedSnapshotRef.current = canvasSnapshot(canvas.viewport, canvas.positions, canvas.hidden_creation_ids, canvas.hidden_reference_ids ?? []);
        setPositions((current) => ({ ...current, ...canvas.positions }));
        setPan({ x: canvas.viewport.x, y: canvas.viewport.y });
        setScale(canvas.viewport.scale);
        setHiddenIds(canvas.hidden_creation_ids);
        setHiddenUploadIds(canvas.hidden_reference_ids ?? []);
        revisionRef.current = canvas.revision;
        hydratedRef.current = true;
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => controller.abort();
  }, [projectName]);

  useEffect(() => () => {
    disposedRef.current = true;
  }, []);

  useEffect(() => {
    // Nodes can arrive through SSE while the creator is arranging the canvas; keep existing coordinates intact.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPositions((current) => {
      const next = { ...current };
      let changed = false;
      allNodes.forEach((node, index) => {
        if (!next[node.id]) {
          next[node.id] = initialPosition(index);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [allNodes]);

  useEffect(() => {
    if (!hydratedRef.current || readOnly) return;
    const viewport = { x: pan.x, y: pan.y, scale };
    const snapshot = canvasSnapshot(viewport, positions, hiddenIds, hiddenUploadIds);
    if (snapshot === lastSavedSnapshotRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const { canvas } = await API.saveFreeCreationCanvas(projectName, {
            viewport,
            positions,
            hidden_creation_ids: hiddenIds,
            hidden_reference_ids: hiddenUploadIds,
            expected_revision: revisionRef.current,
          });
          revisionRef.current = canvas.revision;
          lastSavedSnapshotRef.current = snapshot;
        } catch (error) {
          if (disposedRef.current) return;
          useAppStore.getState().pushToast(errMsg(error), "error");
          try {
            const { canvas } = await API.getFreeCreationCanvas(projectName);
            if (disposedRef.current) return;
            revisionRef.current = canvas.revision;
            lastSavedSnapshotRef.current = canvasSnapshot(canvas.viewport, canvas.positions, canvas.hidden_creation_ids, canvas.hidden_reference_ids ?? []);
            setPositions(canvas.positions);
            setPan({ x: canvas.viewport.x, y: canvas.viewport.y });
            setScale(canvas.viewport.scale);
            setHiddenIds(canvas.hidden_creation_ids);
            setHiddenUploadIds(canvas.hidden_reference_ids ?? []);
          } catch {
            // The next local change retries synchronization.
          }
        }
      })();
    }, 650);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, [hiddenIds, hiddenUploadIds, pan.x, pan.y, positions, projectName, readOnly, scale]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        setSpacePressed(true);
      }
      if (event.key === "Escape") {
        setContextMenu(null);
        publishSelection([]);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePressed(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [publishSelection]);

  useEffect(() => () => useFreeCreationStore.getState().clearSelection(), []);

  const beginNodeDrag = (event: React.PointerEvent<HTMLElement>, creationId: string) => {
    if (event.button !== 0 || readOnly) return;
    event.stopPropagation();
    const nextSelection = selectedSet.has(creationId) ? selectedIds : [creationId];
    publishSelection(nextSelection);
    const origins = Object.fromEntries(nextSelection.map((id) => [id, positions[id] ?? { x: 0, y: 0 }]));
    pointerRef.current = {
      kind: "nodes",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origins,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginUploadDrag = (event: React.PointerEvent<HTMLElement>, referenceId: string) => {
    if (event.button !== 0 || readOnly) return;
    event.stopPropagation();
    const nextSelection = selectedSet.has(referenceId) ? selectedIds : [referenceId];
    publishSelection(nextSelection);
    pointerRef.current = {
      kind: "nodes",
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origins: Object.fromEntries(nextSelection.map((id) => [id, positions[id] ?? { x: 0, y: 0 }])),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-canvas-node='true'], button, a, input, video")) return;
    setContextMenu(null);
    if (event.button === 1 || (event.button === 0 && spacePressed)) {
      event.preventDefault();
      pointerRef.current = {
        kind: "pan",
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        origin: pan,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    pointerRef.current = { kind: "marquee", pointerId: event.pointerId, start: point, current: point, additive: event.shiftKey };
    setMarquee({ start: point, current: point });
    if (!event.shiftKey) publishSelection([]);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updatePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    if (operation.kind === "pan") {
      setPan({
        x: operation.origin.x + event.clientX - operation.start.x,
        y: operation.origin.y + event.clientY - operation.start.y,
      });
      return;
    }
    if (operation.kind === "nodes") {
      const dx = (event.clientX - operation.start.x) / scale;
      const dy = (event.clientY - operation.start.y) / scale;
      setPositions((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(operation.origins).map(([id, origin]) => [id, { x: origin.x + dx, y: origin.y + dy }])),
      }));
      return;
    }
    const current = { x: event.clientX, y: event.clientY };
    pointerRef.current = { ...operation, current };
    setMarquee({ start: operation.start, current });
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const operation = pointerRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    if (operation.kind === "marquee") {
      const left = Math.min(operation.start.x, operation.current.x);
      const top = Math.min(operation.start.y, operation.current.y);
      const selectionRect = new DOMRect(left, top, Math.abs(operation.current.x - operation.start.x), Math.abs(operation.current.y - operation.start.y));
      const hitIds = [...visibleUploads.map((item) => item.reference_id), ...visibleCreations.map((item) => item.creation_id)]
        .filter((id) => {
          const node = nodeRefs.current.get(id);
          return node ? intersects(selectionRect, node.getBoundingClientRect()) : false;
        });
      publishSelection(operation.additive ? [...new Set([...selectedIds, ...hitIds])] : hitIds);
    }
    pointerRef.current = null;
    setMarquee(null);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current - event.deltaY * 0.002)));
      return;
    }
    setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
  };

  const hideCreation = (creationId: string) => {
    setHiddenIds((current) => [...new Set([...current, creationId])]);
    publishSelection(selectedIds.filter((id) => id !== creationId));
    setContextMenu(null);
  };

  const hideUpload = (referenceId: string) => {
    setHiddenUploadIds((current) => [...new Set([...current, referenceId])]);
    publishSelection(selectedIds.filter((id) => id !== referenceId));
    setContextMenu(null);
  };

  const restoreUpload = (referenceId: string) => {
    setHiddenUploadIds((current) => current.filter((id) => id !== referenceId));
    setContextMenu(null);
  };

  const restoreCreation = (creationId: string) => {
    setHiddenIds((current) => current.filter((id) => id !== creationId));
    setContextMenu(null);
  };

  const activeContextCreation = contextMenu
    ? contextMenu.kind === "creation" ? creations.find((creation) => creation.creation_id === contextMenu.nodeId) ?? null : null
    : null;
  const activeContextUpload = contextMenu?.kind === "upload"
    ? uploads.find((upload) => upload.reference_id === contextMenu.nodeId) ?? null
    : null;

  const renderActions = (creation: FreeCreation) => {
    const isVideo = creation.media_type === "video" || creation.output_type === "video";
    return (
      <>
        {creation.status === "queued" || creation.status === "running" ? (
          <button type="button" onClick={() => onCancel(creation.creation_id)} disabled={actingId === creation.creation_id} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)] disabled:opacity-50" aria-label={t("free_creation_cancel")} title={t("free_creation_cancel")}>
            {actingId === creation.creation_id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
          </button>
        ) : null}
        {creation.status === "failed" || creation.status === "cancelled" ? (
          <button type="button" onClick={() => onRetry(creation.creation_id)} disabled={actingId === creation.creation_id} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)] disabled:opacity-50" aria-label={t("free_creation_retry")} title={t("free_creation_retry")}>
            {actingId === creation.creation_id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
          </button>
        ) : null}
        {creation.status === "succeeded" ? (
          <button type="button" onClick={() => onReference({ type: "creation", creation_id: creation.creation_id, version: creation.version, role: isVideo ? "reference_video" : "reference_image" }, creation.prompt || t("free_creation"))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]" aria-label={t("free_creation_add_reference")} title={t("free_creation_add_reference")}>
            <Link2 className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {creation.status === "succeeded" ? (
          <button type="button" onClick={() => onEdit(creation.creation_id)} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]" aria-label={t("free_creation_use_as_parent")} title={t("free_creation_use_as_parent")}>
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {creation.status === "succeeded" && creation.media_path ? <VersionTimeMachine projectName={projectName} resourceType={isVideo ? "free_videos" : "free_images"} resourceId={creation.creation_id} iconOnly readOnly /> : null}
        {creation.status === "succeeded" && creation.media_path ? (
          <a href={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} download className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]" aria-label={t("free_creation_download")} title={t("free_creation_download")}>
            <Download className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
      </>
    );
  };

  const handleReferenceShortcut = (
    event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
    claim: FreeCreationReferenceClaim,
    label: string,
  ) => {
    if (readOnly || (!event.ctrlKey && !event.metaKey)) return;
    if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onReference(claim, label);
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
      onContextMenu={(event) => {
        event.preventDefault();
        if (!(event.target as HTMLElement).closest("[data-canvas-node='true']")) setContextMenu(null);
      }}
      style={{ cursor: "default", touchAction: "none" }}
      data-testid="free-creation-canvas"
    >
      <div className="pointer-events-none absolute inset-0 opacity-75" style={{ backgroundImage: "radial-gradient(oklch(0.86 0.03 250 / 0.28) 1.25px, transparent 1.25px)", backgroundSize: `${24 * scale}px ${24 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }} />

      <div className="absolute right-4 top-4 z-20 flex items-center gap-1 rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)]/94 p-1 shadow-md backdrop-blur-sm">
        <button type="button" onClick={() => setScale((value) => Math.min(MAX_SCALE, value + 0.1))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={t("free_creation_zoom_in")} aria-label={t("free_creation_zoom_in")}><ZoomIn className="h-4 w-4" aria-hidden /></button>
        <span className="min-w-12 text-center text-[11px] text-[var(--color-text-muted)]">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((value) => Math.max(MIN_SCALE, value - 0.1))} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={t("free_creation_zoom_out")} aria-label={t("free_creation_zoom_out")}><ZoomOut className="h-4 w-4" aria-hidden /></button>
        <button type="button" onClick={() => { setPan({ x: 0, y: 0 }); setScale(1); }} className="focus-ring grid h-8 w-8 place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={t("free_creation_reset_canvas")} aria-label={t("free_creation_reset_canvas")}><LocateFixed className="h-4 w-4" aria-hidden /></button>
        {hiddenIds.length ? <button type="button" onClick={() => setShowHidden((value) => !value)} className={`focus-ring grid h-8 min-w-8 place-items-center rounded px-1.5 ${showHidden ? "bg-[var(--color-accent-dim)] text-[var(--color-accent-2)]" : "text-[var(--color-text-muted)]"}`} title={t("free_creation_show_hidden", { count: hiddenIds.length })} aria-label={t("free_creation_show_hidden", { count: hiddenIds.length })}>{showHidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}</button> : null}
      </div>

      <div className="absolute left-0 top-0" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`, transformOrigin: "0 0" }}>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden>
          {visibleCreations.flatMap((creation) => {
            const targets = [
              ...(creation.parent_creation_id ? [creation.parent_creation_id] : []),
              ...(creation.reference_claims ?? []).flatMap((claim) => claim.type === "creation" ? [claim.creation_id] : []),
            ];
            const to = positions[creation.creation_id];
            if (!to) return [];
            return [...new Set(targets)].flatMap((sourceId) => {
              const from = positions[sourceId];
              if (!from || hiddenSet.has(sourceId)) return [];
              return <path key={`${sourceId}-${creation.creation_id}`} d={`M ${from.x + NODE_WIDTH} ${from.y + NODE_HEIGHT / 2} C ${from.x + NODE_WIDTH + 48} ${from.y + NODE_HEIGHT / 2}, ${to.x - 48} ${to.y + NODE_HEIGHT / 2}, ${to.x} ${to.y + NODE_HEIGHT / 2}`} fill="none" stroke="var(--color-accent)" strokeOpacity="0.42" strokeWidth="2" />;
            });
          })}
        </svg>

        {visibleUploads.map((upload) => {
          const position = positions[upload.reference_id];
          if (!position) return null;
          const selected = selectedSet.has(upload.reference_id);
          const hidden = hiddenUploadSet.has(upload.reference_id);
          const claim: FreeCreationReferenceClaim = {
            type: "upload",
            reference_id: upload.reference_id,
            role: freeCreationUploadRole(upload.media_type),
          };
          return (
              <article key={upload.reference_id} ref={(node) => { if (node) nodeRefs.current.set(upload.reference_id, node); else nodeRefs.current.delete(upload.reference_id); }} data-canvas-node="true" data-canvas-id={upload.reference_id} className={`absolute overflow-hidden rounded-md border-2 bg-[var(--color-surface-2)] shadow-[0_16px_30px_-18px_oklch(0_0_0_/_0.95)] ${selected ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-dim)]" : "border-[var(--color-hairline-strong)]"} ${hidden ? "opacity-55" : ""}`} style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: 238 }} onPointerDown={(event) => { if (event.button === 0 && (event.ctrlKey || event.metaKey)) { event.preventDefault(); return; } if (event.button === 0 && !event.shiftKey) publishSelection([upload.reference_id]); else if (event.button === 0 && event.shiftKey) publishSelection(selected ? selectedIds.filter((id) => id !== upload.reference_id) : [...selectedIds, upload.reference_id]); }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onPreview?.({ kind: "upload", upload }); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (readOnly) return; publishSelection([upload.reference_id]); const rect = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "upload", nodeId: upload.reference_id, x: Math.min(event.clientX - (rect?.left ?? 0), (rect?.width ?? 260) - 190), y: Math.min(event.clientY - (rect?.top ?? 0), (rect?.height ?? 200) - 150) }); }}>
              <div className="flex h-10 items-center justify-between border-b border-[var(--color-hairline)] px-3 text-xs font-medium text-[var(--color-text-2)]" onPointerDown={(event) => beginUploadDrag(event, upload.reference_id)}><span className="truncate">{upload.original_filename}</span><span className="text-[10px] text-[var(--color-text-muted)]">{t("free_creation_reference")}</span></div>
              <div role={upload.media_type === "audio" ? undefined : "button"} tabIndex={upload.media_type === "audio" ? undefined : 0} className="block h-[154px] w-full bg-black" onClick={(event) => handleReferenceShortcut(event, claim, upload.original_filename)} onKeyDown={upload.media_type === "audio" ? undefined : (event) => handleReferenceShortcut(event, claim, upload.original_filename)} title={t("free_creation_reference_shortcut")}>
                {upload.media_type === "image" ? <img src={API.getFileUrl(projectName, upload.path)} alt={upload.original_filename} className="h-full w-full object-contain" /> : upload.media_type === "video" ? (
                  <video src={API.getFileUrl(projectName, upload.path)} className="h-full w-full object-contain" aria-label={upload.original_filename} />
                ) : upload.media_type === "audio" ? <div className="flex h-full flex-col items-center justify-center gap-3 px-4"><AudioLines className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><audio src={API.getFileUrl(projectName, upload.path)} controls className="w-full" aria-label={upload.original_filename} /></div> : upload.media_type === "text" ? <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-muted)]"><FileText className="h-8 w-8 text-[var(--color-accent-2)]" aria-hidden /><span className="max-w-[90%] truncate text-xs">{t("media_type_text")}</span></div> : <Link2 className="mx-auto mt-16 h-5 w-5 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden />}
              </div>
              <div className="flex h-11 items-center justify-end px-2"><button type="button" onClick={(event) => { event.stopPropagation(); onReference(claim, upload.original_filename); }} className="focus-ring inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)] hover:text-[var(--color-text)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button></div>
            </article>
          );
        })}

        {visibleCreations.map((creation) => {
          const position = positions[creation.creation_id];
          if (!position) return null;
          const selected = selectedSet.has(creation.creation_id);
          const hidden = hiddenSet.has(creation.creation_id);
          const isVideo = creation.media_type === "video" || creation.output_type === "video";
          const statusLabel = t(`free_creation_status_${creation.status}`);
          return (
            <article
              key={creation.creation_id}
              ref={(node) => { if (node) nodeRefs.current.set(creation.creation_id, node); else nodeRefs.current.delete(creation.creation_id); }}
              data-canvas-node="true"
              data-canvas-id={creation.creation_id}
              className={`absolute overflow-hidden rounded-md border-2 bg-[var(--color-surface-2)] shadow-[0_16px_30px_-18px_oklch(0_0_0_/_0.95)] ${selected ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-dim)]" : "border-[var(--color-hairline-strong)]"} ${hidden ? "opacity-55" : ""}`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              onPointerDown={(event) => {
                if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  return;
                }
                if (event.button === 0 && !event.shiftKey) publishSelection([creation.creation_id]);
                else if (event.button === 0 && event.shiftKey) publishSelection(selected ? selectedIds.filter((id) => id !== creation.creation_id) : [...selectedIds, creation.creation_id]);
              }}
              onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); if (creation.status === "succeeded" && creation.media_path) onPreview?.({ kind: "creation", creation }); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (readOnly) return; publishSelection([creation.creation_id]); const rect = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "creation", nodeId: creation.creation_id, x: Math.min(event.clientX - (rect?.left ?? 0), (rect?.width ?? 260) - 190), y: Math.min(event.clientY - (rect?.top ?? 0), (rect?.height ?? 200) - 150) }); }}
            >
              <div className="flex h-10 items-center justify-between gap-2 border-b border-[var(--color-hairline)] px-3" onPointerDown={(event) => beginNodeDrag(event, creation.creation_id)}>
                <span className="truncate text-[11px] font-semibold text-[var(--color-text)]">{t(`free_creation_${creation.output_type}`)}</span>
                <div className="flex items-center gap-1"><span className="text-[10px] text-[var(--color-text-muted)]">{statusLabel}</span>{!readOnly ? <button type="button" className="focus-ring grid h-7 w-7 place-items-center rounded text-[var(--color-text-muted)] hover:bg-[oklch(1_0_0_/_0.05)]" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); const surface = surfaceRef.current?.getBoundingClientRect(); setContextMenu({ kind: "creation", nodeId: creation.creation_id, x: rect.right - (surface?.left ?? 0), y: rect.bottom - (surface?.top ?? 0) }); }} aria-label={t("free_creation_more_actions")} title={t("free_creation_more_actions")}><MoreHorizontal className="h-4 w-4" aria-hidden /></button> : null}</div>
              </div>
              <div role="button" tabIndex={creation.status === "succeeded" && creation.media_path ? 0 : -1} className="h-[174px] bg-black" onClick={(event) => { if (creation.status === "succeeded" && creation.media_path) handleReferenceShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: isVideo ? "reference_video" : "reference_image" }, creation.prompt || t("free_creation")); }} onKeyDown={(event) => { if (creation.status === "succeeded" && creation.media_path) handleReferenceShortcut(event, { type: "creation", creation_id: creation.creation_id, version: creation.version, role: isVideo ? "reference_video" : "reference_image" }, creation.prompt || t("free_creation")); }} title={creation.status === "succeeded" && creation.media_path ? t("free_creation_reference_shortcut") : undefined}>
                {creation.status === "succeeded" && creation.media_path ? isVideo ? (
                  <video className="h-full w-full object-contain" src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} aria-label={creation.prompt ?? creation.creation_id} controls />
                ) : <img className="h-full w-full object-contain" src={API.getFreeCreationMediaUrl(projectName, creation.creation_id)} alt={creation.prompt ?? creation.creation_id} /> : <div className="flex h-full items-center justify-center px-3 text-center text-xs text-[var(--color-text-muted)]">{creation.status === "failed" ? t("free_creation_failed") : statusLabel}</div>}
              </div>
              <div className="h-[66px] px-3 py-2"><p className="line-clamp-2 text-xs leading-5 text-[var(--color-text-2)]">{creation.prompt || t("free_creation_prompt")}</p></div>
              {!readOnly ? <div className="flex h-10 items-center justify-end gap-0.5 border-t border-[var(--color-hairline)] px-2">{renderActions(creation)}</div> : null}
            </article>
          );
        })}
      </div>

      {marquee ? <div className="pointer-events-none fixed z-30 border border-[var(--color-accent)] bg-[var(--color-accent-dim)]" style={{ left: Math.min(marquee.start.x, marquee.current.x), top: Math.min(marquee.start.y, marquee.current.y), width: Math.abs(marquee.current.x - marquee.start.x), height: Math.abs(marquee.current.y - marquee.start.y) }} /> : null}

      {(activeContextCreation || activeContextUpload) && contextMenu ? (
        <div className="absolute z-[200] min-w-44 rounded-md border border-[var(--color-hairline)] p-1 shadow-2xl" style={{ left: Math.max(4, contextMenu.x), top: Math.max(4, contextMenu.y), background: "var(--color-surface-2)", opacity: 1 }} role="menu">
          {activeContextCreation ? <>
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path ? <button type="button" role="menuitem" onClick={() => { onEdit(activeContextCreation.creation_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Pencil className="h-3.5 w-3.5" aria-hidden />{t("free_creation_use_as_parent")}</button> : null}
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path ? <button type="button" role="menuitem" onClick={() => { onPreview?.({ kind: "creation", creation: activeContextCreation }); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_preview")}</button> : null}
            {activeContextCreation.status === "succeeded" && activeContextCreation.media_path ? <button type="button" role="menuitem" onClick={() => { onReference({ type: "creation", creation_id: activeContextCreation.creation_id, version: activeContextCreation.version, role: activeContextCreation.media_type === "video" || activeContextCreation.output_type === "video" ? "reference_video" : "reference_image" }, activeContextCreation.prompt || t("free_creation")); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button> : null}
            {hiddenSet.has(activeContextCreation.creation_id) ? <button type="button" role="menuitem" onClick={() => restoreCreation(activeContextCreation.creation_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_restore_to_canvas")}</button> : <button type="button" role="menuitem" onClick={() => hideCreation(activeContextCreation.creation_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><EyeOff className="h-3.5 w-3.5" aria-hidden />{t("free_creation_hide_from_canvas")}</button>}
          </> : null}
          {activeContextUpload ? <>
            <button type="button" role="menuitem" onClick={() => { onPreview?.({ kind: "upload", upload: activeContextUpload }); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_preview")}</button>
            <button type="button" role="menuitem" onClick={() => { onReference({ type: "upload", reference_id: activeContextUpload.reference_id, role: freeCreationUploadRole(activeContextUpload.media_type) }, activeContextUpload.original_filename); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_add_reference")}</button>
            {hiddenUploadSet.has(activeContextUpload.reference_id) ? <button type="button" role="menuitem" onClick={() => restoreUpload(activeContextUpload.reference_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Eye className="h-3.5 w-3.5" aria-hidden />{t("free_creation_restore_to_canvas")}</button> : <button type="button" role="menuitem" onClick={() => hideUpload(activeContextUpload.reference_id)} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><EyeOff className="h-3.5 w-3.5" aria-hidden />{t("free_creation_hide_from_canvas")}</button>}
            {onDetachUpload ? <button type="button" role="menuitem" onClick={() => { onDetachUpload(activeContextUpload.reference_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text-2)] hover:bg-[oklch(1_0_0_/_0.05)]"><Link2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_detach_reference")}</button> : null}
            {onDeleteUpload ? <button type="button" role="menuitem" onClick={() => { onDeleteUpload(activeContextUpload.reference_id); setContextMenu(null); }} className="focus-ring flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-danger)] hover:bg-[oklch(1_0_0_/_0.05)]"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t("free_creation_remove_reference")}</button> : null}
          </> : null}
        </div>
      ) : null}

      {creations.length === 0 && uploads.length === 0 ? <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 pb-44 text-center"><div className="max-w-sm"><LocateFixed className="mx-auto mb-3 h-5 w-5 text-[var(--color-text-muted)]" aria-hidden /><p className="text-sm text-[var(--color-text-muted)]">{t("free_creation_empty")}</p></div></div> : null}
    </div>
  );
}
