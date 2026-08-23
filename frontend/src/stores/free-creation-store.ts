import { create } from "zustand";
import type { FreeCreationCanvasAppliedPatch } from "@/types";

export interface FreeCreationCanvasEvent {
  sequence: number;
  projectName: string;
  patch: FreeCreationCanvasAppliedPatch;
}

interface FreeCreationSelectionState {
  selectedIds: string[];
  selectedVideoIds: string[];
  selectedRequestId: string | null;
  setSelection: (ids: string[], requestId?: string | null, videoIds?: string[]) => void;
  clearSelection: () => void;
  refreshToken: number;
  invalidateCreations: () => void;
  canvasEvents: FreeCreationCanvasEvent[];
  publishCanvasPatches: (projectName: string, patches: FreeCreationCanvasAppliedPatch[]) => void;
}

export const useFreeCreationStore = create<FreeCreationSelectionState>((set) => ({
  selectedIds: [],
  selectedVideoIds: [],
  selectedRequestId: null,
  setSelection: (selectedIds, selectedRequestId = null, selectedVideoIds = []) => set({ selectedIds, selectedVideoIds, selectedRequestId }),
  clearSelection: () => set({ selectedIds: [], selectedVideoIds: [], selectedRequestId: null }),
  refreshToken: 0,
  invalidateCreations: () => set((state) => ({ refreshToken: state.refreshToken + 1 })),
  canvasEvents: [],
  publishCanvasPatches: (projectName, patches) => set((state) => {
    if (!patches.length) return state;
    let sequence = state.canvasEvents.at(-1)?.sequence ?? 0;
    const events = patches.map((patch) => ({
      sequence: ++sequence,
      projectName,
      patch,
    }));
    return { canvasEvents: [...state.canvasEvents, ...events].slice(-200) };
  }),
}));
