import { create } from "zustand";

/** The WhatsApp group open in Atendimento, if any — its own new messages don't pop a notice (see useSocketEvents). */
interface ActiveGroupState {
  activeGroupId: string | null;
  setActiveGroupId: (id: string | null) => void;
}

export const useActiveGroupStore = create<ActiveGroupState>((set) => ({
  activeGroupId: null,
  setActiveGroupId: (id) => set({ activeGroupId: id }),
}));
