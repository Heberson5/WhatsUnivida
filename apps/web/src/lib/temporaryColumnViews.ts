import { create } from "zustand";
import type { ColumnScreen, ColumnViewColumn } from "@whatsatendende/types";

// "Usar só agora" in the ⋮ column menu — lasts until the user signs out
// (clearSession wipes it). Kept in localStorage so a reload keeps it, and in
// a shared store so every table/export of the same screen sees the change.
const PREFIX = "column-view-temp:";

function storageKey(userId: string, screen: ColumnScreen) {
  return `${PREFIX}${userId}:${screen}`;
}

function readStored(key: string): ColumnViewColumn[] | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ColumnViewColumn[]) : null;
  } catch {
    return null;
  }
}

interface TemporaryColumnViewsState {
  byKey: Record<string, ColumnViewColumn[] | null>;
  set: (key: string, columns: ColumnViewColumn[] | null) => void;
  reset: () => void;
}

const useTemporaryColumnViewsStore = create<TemporaryColumnViewsState>((set) => ({
  byKey: {},
  set: (key, columns) => set((state) => ({ byKey: { ...state.byKey, [key]: columns } })),
  reset: () => set({ byKey: {} }),
}));

export function useTemporaryColumnView(userId: string, screen: ColumnScreen): ColumnViewColumn[] | null {
  const key = storageKey(userId, screen);
  const stored = useTemporaryColumnViewsStore((s) => s.byKey[key]);
  return stored === undefined ? readStored(key) : stored;
}

export function writeTemporaryColumnView(userId: string, screen: ColumnScreen, columns: ColumnViewColumn[] | null) {
  const key = storageKey(userId, screen);
  useTemporaryColumnViewsStore.getState().set(key, columns);
  try {
    if (columns) localStorage.setItem(key, JSON.stringify(columns));
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked (private window) — the choice just won't survive a reload.
  }
}

export function clearTemporaryColumnViews() {
  useTemporaryColumnViewsStore.getState().reset();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch {
    // Nothing stored.
  }
}
