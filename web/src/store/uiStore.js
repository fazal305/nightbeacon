import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// UI-only state — active filters, selection, and display preferences. Server
// data itself lives in TanStack Query, never duplicated here. Persisted to
// localStorage since these are per-viewer conveniences (remembered filters,
// language, refresh cadence), not data that needs to be shared or read back
// by the server.
export const useUiStore = create(
  persist(
    (set) => ({
      filters: { source: '', status: '', category: '', priority: '', from: '', to: '' },
      setFilter: (key, value) =>
        set((state) => ({ filters: { ...state.filters, [key]: value } })),
      clearFilters: () =>
        set({ filters: { source: '', status: '', category: '', priority: '', from: '', to: '' } }),

      refreshIntervalMs: 30_000,
      setRefreshIntervalMs: (ms) => set({ refreshIntervalMs: ms }),
    }),
    { name: 'nightbeacon-ui-prefs' }
  )
);
