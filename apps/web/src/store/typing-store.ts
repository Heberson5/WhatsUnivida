import { create } from "zustand";

// WhatsApp repeats "composing" while the customer keeps typing; without a new one this long, it's considered stopped.
const TYPING_TIMEOUT_MS = 10_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export type CustomerTypingKind = "typing" | "recording";
type Entry = { kind: CustomerTypingKind; name: string | null };

/**
 * Conversations whose customer is typing or recording audio right now (QR Code connections only) — "digitando…" /
 * "gravando áudio…" in the card and the chat. A WhatsApp group keeps one entry per participant ("Marta está digitando…").
 */
interface TypingState {
  typing: Record<string, Record<string, Entry>>;
  setTyping: (conversationId: string, typing: boolean, kind?: CustomerTypingKind, participant?: string, name?: string | null) => void;
}

export const useTypingStore = create<TypingState>((set) => ({
  typing: {},
  setTyping: (conversationId, typing, kind = "typing", participant = "", name = null) => {
    const key = `${conversationId}|${participant}`;
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (typing) timers.set(key, setTimeout(() => useTypingStore.getState().setTyping(conversationId, false, kind, participant), TYPING_TIMEOUT_MS));
    set((s) => {
      const current = s.typing[conversationId] ?? {};
      if (!typing && !current[participant]) return s;
      const people = { ...current };
      if (typing) people[participant] = { kind, name };
      else delete people[participant];
      const next = { ...s.typing };
      if (Object.keys(people).length) next[conversationId] = people;
      else delete next[conversationId];
      return { typing: next };
    });
  },
}));

/** What the card and the chat say: "digitando…", "gravando áudio…", "Marta está digitando…", "Marta e Carlos estão digitando…". */
export function customerTypingLabel(entries: Record<string, Entry> | undefined): { text: string; kind: CustomerTypingKind } | null {
  const list = Object.values(entries ?? {});
  if (!list.length) return null;
  const kind: CustomerTypingKind = list.some((e) => e.kind === "recording") ? "recording" : "typing";
  const action = kind === "recording" ? "gravando áudio…" : "digitando…";
  const names = list.map((e) => e.name?.split(" ")[0]).filter((n): n is string => Boolean(n));
  if (!names.length) return { text: action, kind };
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} e ${names[1]}` : `${names.length} pessoas`;
  return { text: `${who} ${names.length === 1 ? "está" : "estão"} ${action}`, kind };
}

/** Selector: the label for one conversation (null when nobody is typing). */
export function useCustomerTyping(conversationId: string) {
  return customerTypingLabel(useTypingStore((s) => s.typing[conversationId]));
}
