import { create } from "zustand";

interface FreeCreationSelectionState {
  selectedIds: string[];
  selectedRequestId: string | null;
  setSelection: (ids: string[], requestId?: string | null) => void;
  clearSelection: () => void;
  refreshToken: number;
  invalidateCreations: () => void;
}

export const useFreeCreationStore = create<FreeCreationSelectionState>((set) => ({
  selectedIds: [],
  selectedRequestId: null,
  setSelection: (selectedIds, selectedRequestId = null) => set({ selectedIds, selectedRequestId }),
  clearSelection: () => set({ selectedIds: [], selectedRequestId: null }),
  refreshToken: 0,
  invalidateCreations: () => set((state) => ({ refreshToken: state.refreshToken + 1 })),
}));
