import { create } from "zustand";

interface FreeCreationSelectionState {
  selectedIds: string[];
  selectedVideoIds: string[];
  selectedRequestId: string | null;
  setSelection: (ids: string[], requestId?: string | null, videoIds?: string[]) => void;
  clearSelection: () => void;
  refreshToken: number;
  invalidateCreations: () => void;
}

export const useFreeCreationStore = create<FreeCreationSelectionState>((set) => ({
  selectedIds: [],
  selectedVideoIds: [],
  selectedRequestId: null,
  setSelection: (selectedIds, selectedRequestId = null, selectedVideoIds = []) => set({ selectedIds, selectedVideoIds, selectedRequestId }),
  clearSelection: () => set({ selectedIds: [], selectedVideoIds: [], selectedRequestId: null }),
  refreshToken: 0,
  invalidateCreations: () => set((state) => ({ refreshToken: state.refreshToken + 1 })),
}));
