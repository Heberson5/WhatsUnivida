import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * What was typed and not sent, per person and conversation — switching conversations or reloading the page keeps it,
 * and the conversation's card shows a "Rascunho" chip. Kept in this browser only (localStorage).
 */
interface DraftState {
  drafts: Record<string, string>;
  setDraft: (key: string, text: string) => void;
  /** Drops this person's drafts for conversations no longer in their list (closed, transferred away). */
  prune: (userId: string, keepConversationIds: string[]) => void;
}

export const draftKey = (userId: string, conversationId: string) => `${userId}:${conversationId}`;

export const useDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (key, text) =>
        set((s) => {
          if ((s.drafts[key] ?? "") === text) return s;
          const drafts = { ...s.drafts };
          if (text.trim()) drafts[key] = text;
          else delete drafts[key];
          return { drafts };
        }),
      prune: (userId, keepConversationIds) =>
        set((s) => {
          const keep = new Set(keepConversationIds.map((id) => draftKey(userId, id)));
          const entries = Object.entries(s.drafts).filter(([key]) => !key.startsWith(`${userId}:`) || keep.has(key));
          return entries.length === Object.keys(s.drafts).length ? s : { drafts: Object.fromEntries(entries) };
        }),
    }),
    { name: "wa-drafts" }
  )
);
