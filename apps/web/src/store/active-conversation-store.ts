import { create } from "zustand";

interface ActiveConversationState {
  // The conversation currently open in ChatPanel, if any — set by
  // AtendimentoPage whenever the agent selects/deselects one. Read by
  // useSocketEvents (mounted globally in AppLayout, not per-page) so it can
  // skip the redundant toast/desktop notification for a message that's
  // already visible live in the open chat, without needing useSocketEvents
  // itself to be scoped to the Atendimento page — see PROMPT: notifications
  // must keep working while the agent is on another screen (Dashboard,
  // Gestão, etc.), not just while Atendimento happens to be open.
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
}

export const useActiveConversationStore = create<ActiveConversationState>((set) => ({
  activeConversationId: null,
  setActiveConversationId: (id) => set({ activeConversationId: id }),
}));
