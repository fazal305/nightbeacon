import { create } from 'zustand';

// UI-only state — active filters and selection. Server data itself lives in
// TanStack Query, never duplicated here.
export const useUiStore = create((set) => ({
  filters: { source: '', status: '', category: '', priority: '', from: '', to: '' },
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  clearFilters: () =>
    set({ filters: { source: '', status: '', category: '', priority: '', from: '', to: '' } }),
}));
