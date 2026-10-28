import { create } from "zustand";

export type ChatTypingKind = "typing" | "recording";

/** Chat interno: whether the side panel is open, which room is on screen, and who is typing (or recording) where. */
interface InternalChatState {
  open: boolean;
  activeRoomId: string | null;
  /** A message to scroll to once the room opens (a search result, a pinned message). */
  focusMessageId: string | null;
  typing: Record<string, Record<string, { name: string; kind: ChatTypingKind; until: number }>>;
  setOpen: (open: boolean) => void;
  setActiveRoom: (roomId: string | null, focusMessageId?: string | null) => void;
  clearFocus: () => void;
  setTyping: (roomId: string, userId: string, name: string, kind: ChatTypingKind) => void;
  clearTyping: (roomId: string, userId: string) => void;
}

const TYPING_SHOWN_MS = 4_000;

export const useInternalChatStore = create<InternalChatState>((set) => ({
  open: false,
  activeRoomId: null,
  focusMessageId: null,
  typing: {},
  setOpen: (open) => set({ open }),
  setActiveRoom: (activeRoomId, focusMessageId = null) => set({ activeRoomId, focusMessageId }),
  clearFocus: () => set({ focusMessageId: null }),
  setTyping: (roomId, userId, name, kind) =>
    set((s) => ({ typing: { ...s.typing, [roomId]: { ...s.typing[roomId], [userId]: { name, kind, until: Date.now() + TYPING_SHOWN_MS } } } })),
  clearTyping: (roomId, userId) =>
    set((s) => {
      if (!s.typing[roomId]?.[userId]) return s;
      const room = { ...s.typing[roomId] };
      delete room[userId];
      return { typing: { ...s.typing, [roomId]: room } };
    }),
}));

/** "Ana está digitando…", "Ana está gravando áudio…", "Ana e Bia estão digitando…" — or null. */
export function typingLabel(entries: { name: string; kind: ChatTypingKind; until: number }[] | undefined, now = Date.now()): { text: string; kind: ChatTypingKind } | null {
  const live = (entries ?? []).filter((e) => e.until > now);
  if (!live.length) return null;
  const kind: ChatTypingKind = live.some((e) => e.kind === "recording") ? "recording" : "typing";
  const names = live.map((e) => e.name.split(" ")[0]);
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} e ${names[1]}` : `${names.length} pessoas`;
  const verb = names.length === 1 ? "está" : "estão";
  return { text: `${who} ${verb} ${kind === "recording" ? "gravando áudio" : "digitando"}…`, kind };
}
