import { create } from "zustand";

/**
 * Message boxes with something not sent yet (text, an audio being recorded or
 * reviewed, files waiting) — the "Nova versão" popup waits until they are sent.
 */
interface ComposerActivityState {
  busy: Record<string, true>;
  setBusy: (composerId: string, busy: boolean) => void;
}

export const useComposerActivityStore = create<ComposerActivityState>((set) => ({
  busy: {},
  setBusy: (composerId, busy) =>
    set((s) => {
      if (Boolean(s.busy[composerId]) === busy) return s;
      const next = { ...s.busy };
      if (busy) next[composerId] = true;
      else delete next[composerId];
      return { busy: next };
    }),
}));

export const useAnyComposerBusy = () => useComposerActivityStore((s) => Object.keys(s.busy).length > 0);
