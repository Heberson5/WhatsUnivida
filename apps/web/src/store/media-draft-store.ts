import { create } from "zustand";

/**
 * What was being prepared in a conversation and not sent yet, besides text: a voice recording (paused and kept, the
 * way WhatsApp keeps a voice draft when you leave the chat mid-recording), files waiting in the preview, a location
 * waiting to be confirmed. Leaving the conversation — Esc, clicking its card, opening another one — stores it here;
 * coming back puts it back in the message box.
 *
 * Kept in memory only (a recording is audio data, not something for localStorage): it survives switching
 * conversations and screens, not a page reload. Keys are the same as the text drafts' (draftKey).
 */
export interface AudioDraft {
  /** The recording so far, as the pieces it was recorded in (one per "continue recording"). */
  pieces: Blob[];
  mimeType: string;
  seconds: number;
  waveform: number[];
}

export interface MediaDraft {
  audio?: AudioDraft;
  files?: { file: File; caption: string }[];
  activeFileIndex?: number;
  location?: { lat: number; lng: number; caption: string };
}

interface MediaDraftState {
  drafts: Record<string, MediaDraft>;
  /** Stores (or, with an empty draft, removes) what's pending in one conversation. */
  put: (key: string, draft: MediaDraft) => void;
  /** Patches the audio of a stored draft — the last piece of a recording arrives a moment after leaving. */
  putAudio: (key: string, audio: AudioDraft) => void;
  /** Takes the draft out to put it back in the message box (from then on the box holds it). */
  take: (key: string) => MediaDraft | null;
  drop: (key: string) => void;
  prune: (userId: string, keepIds: string[]) => void;
}

const isEmpty = (d: MediaDraft) => !d.audio && !d.files?.length && !d.location;

export const useMediaDraftStore = create<MediaDraftState>((set, get) => ({
  drafts: {},
  put: (key, draft) =>
    set((s) => {
      const drafts = { ...s.drafts };
      if (isEmpty(draft)) delete drafts[key];
      else drafts[key] = draft;
      return { drafts };
    }),
  putAudio: (key, audio) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...s.drafts[key], audio } } })),
  take: (key) => {
    const draft = get().drafts[key] ?? null;
    if (draft) get().drop(key);
    return draft;
  },
  drop: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[key];
      return { drafts };
    }),
  prune: (userId, keepIds) =>
    set((s) => {
      const keep = new Set(keepIds.map((id) => `${userId}:${id}`));
      const entries = Object.entries(s.drafts).filter(([key]) => !key.startsWith(`${userId}:`) || key.startsWith(`${userId}:group:`) || keep.has(key));
      return entries.length === Object.keys(s.drafts).length ? s : { drafts: Object.fromEntries(entries) };
    }),
}));

/** What the conversation's card says is waiting: "audio" wins over the rest. */
export function mediaDraftKind(draft: MediaDraft | undefined): "audio" | "files" | "location" | null {
  if (!draft) return null;
  if (draft.audio) return "audio";
  if (draft.files?.length) return "files";
  if (draft.location) return "location";
  return null;
}
