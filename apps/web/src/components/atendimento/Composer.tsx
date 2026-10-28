import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import clsx from "clsx";
import { CalendarClock, Mic, Paperclip, Pause, Play, Plus, Send, Trash2, X, MapPin, Bold, Italic, Strikethrough, Code, Wand2, FileText, Image as ImageIcon, Video } from "lucide-react";
import type { MessageDTO, ReplyMediaDTO } from "@whatsatendende/types";
import { toast } from "sonner";
import { DataTagPreview, useDataTagAssist } from "./DataTagAssist";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { draftKey, useDraftStore } from "../../store/draft-store";
import { useComposerActivityStore } from "../../store/composer-activity-store";
import { WhenPicker } from "./WhenPicker";

// How long to wait after the agent stops typing before asking for a writing
// suggestion — same debounce shape as EmailTemplatesPanel's preview call.
const WRITING_SUGGESTION_DEBOUNCE_MS = 600;

interface WritingSuggestion {
  offset: number;
  length: number;
  message: string;
  replacement: string;
}

// How many bars the live/frozen waveform keeps — older samples scroll off
// the left, matching WhatsApp Web's own recording indicator.
const MAX_WAVEFORM_BARS = 42;

// A compact but representative slice of the WhatsApp Web emoji panel —
// grouped so the picker reads as categories, not one undifferentiated wall.
const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Sorrisos",
    emojis: ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😉", "😊", "😇", "🥰", "😍", "😘", "😋", "😜", "🤪", "🤔", "🤨"],
  },
  {
    label: "Gestos",
    emojis: ["👍", "👎", "👏", "🙌", "🙏", "👋", "🤝", "💪", "✌️", "🤞", "👌", "✋", "🖐️", "🤙", "👆", "👉"],
  },
  {
    label: "Corações",
    emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💕", "💖", "💗"],
  },
  {
    label: "Outros",
    emojis: ["🎉", "🔥", "✨", "⭐", "😢", "😭", "😮", "😱", "😴", "🤗", "😎", "🥳", "✅", "❌", "⚠️", "❓"],
  },
];

const MAX_TEXTAREA_LINES = 10;
// The customer's "digitando…" is told again this often while it lasts, and ends after this long without typing.
const PRESENCE_REPEAT_MS = 8_000;
const PRESENCE_IDLE_MS = 5_000;

// Mirrors the textarea's own text box in an invisible off-screen div so we
// can measure where a given character offset actually lands on screen —
// textareas don't expose caret/selection pixel coordinates natively, only
// character offsets. Used to position the floating formatting bubble right
// above the selected text, the way Notion/Google Docs do it.
const MIRRORED_STYLE_PROPS = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "letterSpacing",
  "wordSpacing",
  "whiteSpace",
] as const;

function getCaretRect(textarea: HTMLTextAreaElement, position: number): { top: number; left: number } {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  for (const prop of MIRRORED_STYLE_PROPS) mirror.style[prop] = style[prop];

  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  // Viewport-relative (not document-relative) — paired with the bubble
  // being rendered with `position: fixed` below, so page scroll doesn't
  // need accounting for separately.
  const rect = textarea.getBoundingClientRect();
  const top = rect.top + marker.offsetTop - textarea.scrollTop;
  const left = rect.left + marker.offsetLeft - textarea.scrollLeft;
  document.body.removeChild(mirror);
  return { top, left };
}

export interface QuickReplyOption {
  id: string;
  name: string;
  shortcut: string;
  text: string;
  /** An image, video or PDF registered with the reply — staged in the preview with the text as its caption. */
  media?: ReplyMediaDTO | null;
  /** The text with {{dados.*}} already filled for this client. */
  filledText?: string;
  /** Uses {{dados.*}} but no data source is usable — shown to managers only, can't be used. */
  dataUnavailable?: boolean;
}

/** One file staged for sending, alongside the caption typed for it specifically — see the pendingFiles filmstrip below. */
interface PendingAttachment {
  file: File;
  caption: string;
}

export interface MentionCandidate {
  jid: string;
  name: string;
  phone: string | null;
}

/** Group "@": who was marked in the text being sent, and whether "@todos" was used. */
export interface ComposerMentions {
  mentions: { jid: string; label: string }[];
  mentionAll: boolean;
}

const ALL_LABEL = "todos";
const TYPING_MENTION = /@([^\s@]*)$/;
const fold = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export interface ComposerHandle {
  /** Stages one or more files for sending, exactly like picking them via the paperclip button — used by ChatPanel's drag-and-drop-from-folder handler so a drop anywhere over the conversation feeds the same preview/caption flow. */
  addFiles: (files: File[]) => void;
  /** Fills the box with a quick reply's text (the chips under the composer), ready to edit or send. */
  applyQuickReply: (reply: QuickReplyOption) => void;
  /** Puts the cursor in the box, optionally typing something first (the "/" shortcut opens the quick replies this way). */
  focus: (insert?: string) => void;
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSendText: (text: string, replyToMessageId?: string, mentions?: ComposerMentions) => Promise<void>;
    /** WhatsApp groups: who can be marked with "@" (plus "@todos"), asked for the first time "@" is typed. */
    loadMentionCandidates?: () => Promise<MentionCandidate[]>;
    onSendFile: (file: File, caption?: string) => Promise<void>;
    /** A recorded voice note (mic button) — sent as WhatsApp's native PTT bubble, distinct from an attached audio file via onSendFile. */
    onSendAudio: (file: File) => Promise<void>;
    onSendLocation: (lat: number, lng: number) => Promise<void>;
    /** Cadastradas em Respostas Rápidas, já filtradas pela conexão desta conversa. */
    quickReplies?: QuickReplyOption[];
    replyTo: MessageDTO | null;
    onCancelReply: () => void;
    disabled?: boolean;
    /** The conversation this box writes in — what's typed and not sent stays as its draft. */
    conversationId?: string;
    /** "Agendar envio": the text goes out at that time, as this attendant. */
    onScheduleText?: (text: string, sendAt: Date) => Promise<void>;
    /** What the customer's WhatsApp shows of the attendant: "digitando…" while writing, "gravando áudio…" while recording. */
    onPresence?: (presence: "composing" | "recording" | "paused") => void;
  }
>(function Composer(
  { onSendText, onSendFile, onSendAudio, onSendLocation, quickReplies = [], replyTo, onCancelReply, disabled, conversationId, onScheduleText, loadMentionCandidates, onPresence },
  ref
) {
  const userId = useAuthStore((s) => s.user?.id);
  const currentDraftKey = userId && conversationId ? draftKey(userId, conversationId) : null;
  const [text, setText] = useState(() => (currentDraftKey ? (useDraftStore.getState().drafts[currentDraftKey] ?? "") : ""));
  // Which conversation the text in the box belongs to — saved under that key, even in the render right after switching.
  const textDraftKeyRef = useRef(currentDraftKey);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [sending, setSending] = useState(false);
  // "recording": actively capturing, mic live, waveform animating.
  // "paused": MediaRecorder.pause() — mic stream stays open (instant resume,
  // no new permission prompt) but nothing is being captured; a preview
  // player lets the agent listen to what's recorded so far before deciding
  // to resume, discard, or send.
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "paused">("idle");
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [waveformLevels, setWaveformLevels] = useState<number[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0); // 0..1
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [sendingFileProgress, setSendingFileProgress] = useState<{ done: number; total: number } | null>(null);
  const [pendingLocation, setPendingLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationRequesting, setLocationRequesting] = useState(false);
  // Location's caption is unrelated to a file's — kept as its own piece of
  // state rather than folded into pendingFiles, which only ever holds files.
  const [caption, setCaption] = useState("");
  const [selectionBubble, setSelectionBubble] = useState<{ top: number; left: number } | null>(null);
  const [quickReplyActiveIndex, setQuickReplyActiveIndex] = useState(0);
  const [writingSuggestions, setWritingSuggestions] = useState<WritingSuggestion[]>([]);
  // Something not sent yet: the "Nova versão" popup waits until it goes.
  const composerId = useId();
  const setComposerBusy = useComposerActivityStore((s) => s.setBusy);
  const unsent = Boolean(text.trim()) || recordingState !== "idle" || Boolean(previewUrl) || pendingFiles.length > 0 || Boolean(pendingLocation) || sending;
  useEffect(() => setComposerBusy(composerId, unsent), [composerId, unsent, setComposerBusy]);
  useEffect(() => () => setComposerBusy(composerId, false), [composerId, setComposerBusy]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const dataTags = useDataTagAssist(conversationId, text, caret);
  const [pickedMentions, setPickedMentions] = useState<{ jid: string; label: string }[]>([]);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[] | null>(null);
  const typingMention = loadMentionCandidates ? TYPING_MENTION.exec(text.slice(0, caret)) : null;
  const isTypingMention = Boolean(typingMention);
  useEffect(() => {
    if (!isTypingMention || mentionCandidates || !loadMentionCandidates) return;
    loadMentionCandidates()
      .then(setMentionCandidates)
      .catch(() => setMentionCandidates([]));
  }, [isTypingMention, mentionCandidates, loadMentionCandidates]);
  const mentionQuery = typingMention ? fold(typingMention[1]) : null;
  const mentionOptions =
    mentionQuery === null
      ? []
      : [
          ...(ALL_LABEL.startsWith(mentionQuery) ? [{ jid: "", name: ALL_LABEL, phone: null }] : []),
          ...(mentionCandidates ?? []).filter((p) => fold(p.name).includes(mentionQuery) || (p.phone ?? "").includes(mentionQuery)),
        ].slice(0, 8);

  function chooseMention(option: { jid: string; name: string }) {
    const before = text.slice(0, caret).replace(TYPING_MENTION, `@${option.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    if (option.jid) setPickedMentions((prev) => [...prev.filter((m) => m.jid !== option.jid), { jid: option.jid, label: option.name }]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(before.length, before.length);
    });
  }

  /** The mentions still present in the text being sent. */
  function currentMentions(value: string): ComposerMentions | undefined {
    if (!loadMentionCandidates) return undefined;
    return { mentions: pickedMentions.filter((m) => value.includes(`@${m.label}`)), mentionAll: value.includes(`@${ALL_LABEL}`) };
  }
  const emojiPanelRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveformTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  // Object URLs for staged image/video previews, keyed by File identity (not
  // regenerated on every render/caption keystroke) — the filmstrip can hold
  // many thumbnails at once, and pendingFiles gets a new array reference on
  // every caption edit, so recreating these inline on each render would leak
  // a fresh blob URL per keystroke instead of one per file.
  const previewUrlCacheRef = useRef(new Map<File, string>());

  function getPreviewUrl(file: File): string | null {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) return null;
    const cache = previewUrlCacheRef.current;
    let url = cache.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      cache.set(file, url);
    }
    return url;
  }

  // WhatsApp Business App-style slash command: the picker only ever opens
  // when "/" is the very first character and nothing after it is a space
  // yet — the moment a space (or anything else) breaks that, it's just
  // regular text again, same as Slack/Notion's own "/" triggers.
  const quickReplyMatch = /^\/(\S*)$/.exec(text);
  const quickReplyFilter = quickReplyMatch ? quickReplyMatch[1].toLowerCase() : null;
  const filteredQuickReplies =
    quickReplyFilter === null
      ? []
      : quickReplies.filter((qr) => qr.shortcut.startsWith(quickReplyFilter) || qr.name.toLowerCase().includes(quickReplyFilter));
  const quickReplyMenuOpen = quickReplyFilter !== null && filteredQuickReplies.length > 0;

  // Keeps the keyboard-highlighted row in range as the filter narrows/widens
  // the list on every keystroke, instead of pointing at a row that scrolled
  // out of the filtered results.
  useEffect(() => {
    setQuickReplyActiveIndex(0);
  }, [quickReplyFilter]);

  // Asks for writing-correction suggestions a short while after the agent
  // stops typing — debounced the same way EmailTemplatesPanel debounces its
  // preview call, so it doesn't fire on every keystroke. Best-effort: the
  // backend already swallows a down/slow LanguageTool instance into an empty
  // list, so a failed request here just means no suggestions, never an error
  // the agent has to deal with.
  useEffect(() => {
    if (!text.trim() || quickReplyMatch) {
      setWritingSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .post<WritingSuggestion[]>("/writing-assist/check", { text })
        .then((res) => setWritingSuggestions(res.data))
        .catch(() => setWritingSuggestions([]));
    }, WRITING_SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Applying any suggestion (one or all) just clears the list rather than
  // trying to shift the remaining offsets by hand — the effect above
  // re-checks the edited text a moment later and whatever's left reappears
  // with fresh, correct offsets.
  function applyWritingSuggestion(suggestion: WritingSuggestion) {
    const { offset, length, replacement } = suggestion;
    setText((prev) => prev.slice(0, offset) + replacement + prev.slice(offset + length));
    setWritingSuggestions([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function applyAllWritingSuggestions() {
    const sorted = [...writingSuggestions].sort((a, b) => b.offset - a.offset);
    setText((prev) => sorted.reduce((acc, s) => acc.slice(0, s.offset) + s.replacement + acc.slice(s.offset + s.length), prev));
    setWritingSuggestions([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectQuickReply(reply: QuickReplyOption) {
    if (reply.dataUnavailable) {
      toast.error("Indisponível: nenhuma fonte de dados ativa");
      return;
    }
    const replyText = reply.filledText ?? reply.text;
    if (reply.media) {
      void stageQuickReplyMedia({ ...reply, text: replyText }, reply.media);
      return;
    }
    setText(replyText);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  // A reply with an attachment goes to the preview — file plus its text as the caption — for the agent to review and send,
  // same as a file picked by hand; nothing goes out by itself. The "/atalho" typed so far is cleared.
  async function stageQuickReplyMedia(reply: QuickReplyOption, media: ReplyMediaDTO) {
    setText("");
    try {
      const { data } = await api.get<Blob>(`/quick-replies/${reply.id}/media`, { responseType: "blob" });
      const file = new File([data], media.fileName, { type: media.mimeType });
      setActiveFileIndex(pendingFiles.length);
      setPendingFiles((prev) => [...prev, { file, caption: reply.text }]);
    } catch {
      // The attachment couldn't be loaded — at least the text is there to send.
      setText(reply.text);
    }
  }

  // Closes the emoji panel on any click outside it — it was staying open and
  // getting in the way until the user clicked the toggle button again.
  useEffect(() => {
    if (!showEmoji) return;
    function handleClickOutside(e: MouseEvent) {
      if (emojiPanelRef.current && !emojiPanelRef.current.contains(e.target as Node)) setShowEmoji(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showEmoji]);

  // Releases the mic (and stops the browser's own "recording" tab indicator)
  // if the agent navigates away or closes this conversation mid-recording —
  // switching to a different conversation unmounts this Composer instance
  // entirely, so nothing else would ever call cancelRecording() otherwise.
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stream.getTracks().forEach((t) => t.stop());
        recorder.stop();
      }
      if (waveformTimerRef.current) clearInterval(waveformTimerRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      audioContextRef.current?.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grows the textarea with its content, capped at MAX_TEXTAREA_LINES so a
  // very long message doesn't push the rest of the chat off screen.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || "20");
    const maxHeight = lineHeight * MAX_TEXTAREA_LINES;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    if (textDraftKeyRef.current) useDraftStore.getState().setDraft(textDraftKeyRef.current, text);
  }, [text]);
  useEffect(() => {
    if (textDraftKeyRef.current === currentDraftKey) return;
    textDraftKeyRef.current = currentDraftKey;
    setText(currentDraftKey ? (useDraftStore.getState().drafts[currentDraftKey] ?? "") : "");
    setScheduleOpen(false);
  }, [currentDraftKey]);

  async function handleSchedule(sendAt: Date) {
    if (!onScheduleText || !text.trim()) return;
    setScheduling(true);
    try {
      await onScheduleText(text.trim(), sendAt);
      setText("");
      setScheduleOpen(false);
    } finally {
      setScheduling(false);
    }
  }

  async function handleSend() {
    if (!text.trim() || sending) return;
    const ready = dataTags.finalize(text.trim());
    if (ready === null) return;
    setSending(true);
    try {
      await onSendText(ready, replyTo?.id, currentMentions(ready));
      setText("");
      setPickedMentions([]);
      dataTags.reset();
      onCancelReply();
      // Otherwise focus lands nowhere after a send and the agent has to
      // click back into the field before typing the next message.
      requestAnimationFrame(() => textareaRef.current?.focus());
    } finally {
      setSending(false);
    }
  }

  // Appended after whatever's already staged (not replaced) — both the
  // paperclip picker's "add more" affordance and a drop onto an
  // already-open preview extend the same batch, matching WhatsApp Web.
  // Jumps to the first newly-added file so it's immediately visible.
  function addFiles(files: File[]) {
    if (files.length === 0) return;
    setActiveFileIndex(pendingFiles.length);
    setPendingFiles((prev) => [...prev, ...files.map((file) => ({ file, caption: "" }))]);
  }

  // Ctrl+V of an image (a screenshot, "Copiar imagem" in a browser) or of files copied in the file explorer:
  // staged in the preview like the paperclip, the text typed so far becoming the caption — WhatsApp Web parity.
  // A copy that also carries text (Word, Excel — they add a picture of the selection) is pasted as text, as always.
  function handlePaste(e: React.ClipboardEvent) {
    const data = e.clipboardData;
    const files = Array.from(data.files ?? []);
    if (files.length === 0 || data.getData("text/plain").trim()) return;
    e.preventDefault();
    // A pasted screenshot has no name of its own ("image.png") — it gets one with the moment it was pasted.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const named = files.map((f, i) =>
      f.name && f.name !== "image.png" ? f : new File([f], `imagem-colada-${stamp}${files.length > 1 ? `-${i + 1}` : ""}.${f.type.split("/")[1] || "png"}`, { type: f.type })
    );
    const caption = pendingFiles.length === 0 ? text.trim() : "";
    setActiveFileIndex(pendingFiles.length);
    setPendingFiles((prev) => [...prev, ...named.map((file, i) => ({ file, caption: i === 0 ? caption : "" }))]);
    if (caption) setText("");
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  }

  function removePendingFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    setActiveFileIndex((prev) => Math.max(0, Math.min(prev, pendingFiles.length - 2)));
  }

  function updateActiveCaption(text: string) {
    setPendingFiles((prev) => prev.map((entry, i) => (i === activeFileIndex ? { ...entry, caption: text } : entry)));
  }

  async function confirmSendFiles() {
    if (pendingFiles.length === 0) return;
    setSending(true);
    setSendingFileProgress({ done: 0, total: pendingFiles.length });
    try {
      // Sent one at a time (not Promise.all) so they land in the chat — and
      // on WhatsApp itself — in the same order they were staged, same as
      // WhatsApp Web's own batch-send behavior.
      for (let i = 0; i < pendingFiles.length; i++) {
        const { file, caption: fileCaption } = pendingFiles[i];
        await onSendFile(file, fileCaption.trim() || undefined);
        setSendingFileProgress({ done: i + 1, total: pendingFiles.length });
      }
      setPendingFiles([]);
      setActiveFileIndex(0);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } finally {
      setSending(false);
      setSendingFileProgress(null);
    }
  }

  // "digitando…" / "gravando áudio…" on the customer's phone: repeated while it lasts (WhatsApp drops it after a few
  // seconds), "paused" when the attendant stops, clears the box, sends, or leaves the conversation.
  const presenceRef = useRef<{ state: "composing" | "recording" | "paused"; at: number }>({ state: "paused", at: 0 });
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPresenceRef = useRef(onPresence);
  onPresenceRef.current = onPresence;
  function announce(state: "composing" | "recording" | "paused") {
    const last = presenceRef.current;
    if (last.state === state && (state === "paused" || Date.now() - last.at < PRESENCE_REPEAT_MS)) return;
    presenceRef.current = { state, at: Date.now() };
    onPresenceRef.current?.(state);
  }
  useEffect(() => {
    if (recordingState === "recording") {
      announce("recording");
      const repeat = setInterval(() => announce("recording"), PRESENCE_REPEAT_MS);
      return () => clearInterval(repeat);
    }
    if (presenceRef.current.state === "recording") announce("paused");
  }, [recordingState]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (recordingState === "recording") return;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!text.trim()) return announce("paused");
    announce("composing");
    idleTimerRef.current = setTimeout(() => announce("paused"), PRESENCE_IDLE_MS);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (presenceRef.current.state !== "paused") onPresenceRef.current?.("paused");
      presenceRef.current = { state: "paused", at: 0 };
    },
    [conversationId]
  );

  useImperativeHandle(ref, () => ({
    addFiles,
    applyQuickReply: selectQuickReply,
    focus: (insert) => {
      if (insert) setText((t) => (t ? t : insert));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  }));

  // Revokes the object URL for any file removed from (or sent out of)
  // pendingFiles — the cache would otherwise hold every staged file for the
  // lifetime of the whole conversation.
  useEffect(() => {
    const cache = previewUrlCacheRef.current;
    const stillPending = new Set(pendingFiles.map((p) => p.file));
    for (const [file, url] of cache) {
      if (!stillPending.has(file)) {
        URL.revokeObjectURL(url);
        cache.delete(file);
      }
    }
  }, [pendingFiles]);

  useEffect(() => {
    const cache = previewUrlCacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  function handleShareLocation() {
    // Both the API itself and the permission prompt require a secure
    // context (HTTPS, or localhost) in every modern browser — on a plain
    // HTTP origin `navigator.geolocation` either doesn't exist at all or
    // every call fails immediately, with no prompt ever shown. Surfacing
    // that distinctly (instead of a generic "failed" alert) is the only way
    // to tell that apart from the agent simply denying the permission.
    if (!window.isSecureContext) {
      alert(
        "Não foi possível obter sua localização: o navegador só permite isso em sites com HTTPS. Este site está em HTTP — é preciso configurar um certificado antes de usar este recurso."
      );
      return;
    }
    if (!navigator.geolocation) {
      alert("Este navegador não suporta compartilhar localização.");
      return;
    }
    setLocationRequesting(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationRequesting(false);
        // Same "preview before sending" pattern as an attached file below —
        // WhatsApp Web always shows the pin on a map and waits for an
        // explicit "Enviar" before a location actually goes out; clicking
        // the pin icon here used to send it immediately with zero preview
        // or way to back out.
        setPendingLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        setLocationRequesting(false);
        if (err.code === err.PERMISSION_DENIED) {
          alert("Permissão de localização negada. Permita o acesso à localização nas configurações do navegador para este site.");
        } else if (err.code === err.TIMEOUT) {
          alert("Tempo esgotado ao tentar obter sua localização. Tente novamente.");
        } else {
          alert("Não foi possível obter sua localização no momento.");
        }
      },
      { timeout: 10_000 }
    );
  }

  async function confirmSendLocation() {
    if (!pendingLocation) return;
    setSending(true);
    try {
      await onSendLocation(pendingLocation.lat, pendingLocation.lng);
      // WhatsApp's location message carries no caption field of its own —
      // an optional comment here goes out as a normal follow-up text right
      // after it, same as an agent typing one after sharing on real
      // WhatsApp Web.
      const comment = caption.trim();
      if (comment) await onSendText(comment);
      setPendingLocation(null);
      setCaption("");
      requestAnimationFrame(() => textareaRef.current?.focus());
    } finally {
      setSending(false);
    }
  }

  // Samples the live mic level ~10x/second (not on every animation frame —
  // a bar-style waveform doesn't need 60fps, and this keeps re-renders
  // cheap) and appends one bar, dropping the oldest once the strip is full —
  // a left-scrolling waveform, the same feel as WhatsApp Web's own recorder.
  function startWaveformSampling() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    waveformTimerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const deviation = Math.abs(data[i] - 128) / 128;
        if (deviation > peak) peak = deviation;
      }
      // Raw mic deviation reads quiet for normal speech — amplified so the
      // bars actually move visibly instead of sitting near-flat.
      const level = Math.min(1, peak * 4);
      setWaveformLevels((prev) => {
        const next = [...prev, level];
        return next.length > MAX_WAVEFORM_BARS ? next.slice(next.length - MAX_WAVEFORM_BARS) : next;
      });
    }, 100);
  }

  function stopWaveformSampling() {
    if (waveformTimerRef.current) {
      clearInterval(waveformTimerRef.current);
      waveformTimerRef.current = null;
    }
  }

  function releaseRecordingResources() {
    stopWaveformSampling();
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
    mediaRecorderRef.current = null;
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setPreviewPlaying(false);
    setPreviewProgress(0);
    setWaveformLevels([]);
    setRecordingState("idle");
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Safari has no MediaRecorder support for webm at all — let the
      // browser pick its own default (recorder.mimeType below reflects
      // whatever that ends up being) rather than forcing a container it
      // can't produce, which used to make recording silently fail there.
      const recorder = MediaRecorder.isTypeSupported("audio/webm")
        ? new MediaRecorder(stream, { mimeType: "audio/webm" })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;

      // Web Audio's AnalyserNode reads live mic levels for the waveform —
      // entirely separate from the MediaRecorder above, both fed by the
      // same stream.
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioCtx();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      setRecordingState("recording");
      setRecordSeconds(0);
      setWaveformLevels([]);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
      startWaveformSampling();
    } catch {
      alert("Permissão de microfone negada ou indisponível.");
    }
  }

  function pauseRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    if (timerRef.current) clearInterval(timerRef.current);
    stopWaveformSampling();
    const mimeType = recorder.mimeType || "audio/webm";
    // requestData() queues a `dataavailable` task carrying everything
    // buffered so far — queued (and so resolved) before the setTimeout
    // task below, which is what lets the preview include audio captured
    // right up to this exact pause click instead of stopping one chunk short.
    recorder.requestData();
    setTimeout(() => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
    }, 0);
    recorder.pause();
    setRecordingState("paused");
  }

  function resumeRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setPreviewPlaying(false);
    setPreviewProgress(0);
    recorder.resume();
    timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    startWaveformSampling();
    setRecordingState("recording");
  }

  function cancelRecording() {
    const recorder = mediaRecorderRef.current;
    recorder?.stream.getTracks().forEach((t) => t.stop());
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseRecordingResources();
  }

  function togglePreviewPlayback() {
    const audio = previewAudioRef.current;
    if (!audio) return;
    if (previewPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => undefined);
    }
  }

  function finishAndSend() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    const mimeType = recorder.mimeType || "audio/webm";
    recorder.onstop = async () => {
      // recorder.mimeType is whatever the browser actually recorded with
      // (see startRecording) — labeling the Blob with anything else would
      // just be wrong, even though the backend also re-encodes it before
      // it reaches WhatsApp regardless of what's claimed here.
      const extension = mimeType.includes("mp4") ? "m4a" : "webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const file = new File([blob], `audio-${Date.now()}.${extension}`, { type: mimeType });
      setSending(true);
      try {
        await onSendAudio(file);
      } finally {
        setSending(false);
      }
    };
    recorder.stream.getTracks().forEach((t) => t.stop());
    // .stop() works from both "recording" and "paused" — either way it
    // flushes one final dataavailable with whatever hasn't been pushed yet
    // before the "stop" event (and the onstop handler above) fires.
    if (recorder.state !== "inactive") recorder.stop();
    releaseRecordingResources();
  }

  // WhatsApp Web's own formatting shortcuts/toolbar: wrap the current
  // selection (or insert empty markers at the caret) with the matching
  // marker characters.
  function wrapSelection(marker: string) {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart, selectionEnd, value } = el;
    const selected = value.slice(selectionStart, selectionEnd);
    const next = `${value.slice(0, selectionStart)}${marker}${selected}${marker}${value.slice(selectionEnd)}`;
    setText(next);
    setSelectionBubble(null);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = selected ? selectionEnd + marker.length * 2 : selectionStart + marker.length;
      el.setSelectionRange(cursor, cursor);
    });
  }

  // Shows a small floating "B I S" bubble right above the selected text —
  // mirrors the selection toolbar in Notion/Google Docs — whenever the
  // textarea's selection is non-empty; hides it otherwise.
  function updateSelectionBubble() {
    const el = textareaRef.current;
    if (!el || el.selectionStart === el.selectionEnd) {
      setSelectionBubble(null);
      return;
    }
    const { top, left } = getCaretRect(el, el.selectionStart);
    setSelectionBubble({ top: top - 44, left });
  }

  function chooseDataTag(column: string) {
    const next = dataTags.insertTag(text, column);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOptions.length > 0 && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      e.preventDefault();
      chooseMention(mentionOptions[0]);
      return;
    }
    if (dataTags.suggestions.length > 0 && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      e.preventDefault();
      chooseDataTag(dataTags.suggestions[0]);
      return;
    }
    if (quickReplyMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setQuickReplyActiveIndex((i) => Math.min(i + 1, filteredQuickReplies.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setQuickReplyActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectQuickReply(filteredQuickReplies[quickReplyActiveIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      wrapSelection("*");
    } else if (mod && e.key.toLowerCase() === "i") {
      e.preventDefault();
      wrapSelection("_");
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      wrapSelection("~");
    }
  }

  if (recordingState !== "idle") {
    const elapsed = `${String(Math.floor(recordSeconds / 60)).padStart(2, "0")}:${String(recordSeconds % 60).padStart(2, "0")}`;
    return (
      <div className="flex items-center gap-3 border-t border-border bg-surface px-4 py-3">
        <button onClick={cancelRecording} className="focus-ring shrink-0 rounded-full p-2 text-muted hover:bg-surface-alt" aria-label="Descartar gravação">
          <Trash2 className="h-5 w-5" />
        </button>

        {recordingState === "recording" ? (
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
        ) : (
          <button
            onClick={togglePreviewPlayback}
            className="focus-ring shrink-0 rounded-full bg-primary p-1.5 text-primary-fg"
            aria-label={previewPlaying ? "Pausar prévia" : "Ouvir prévia"}
          >
            {previewPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
        )}

        <span className="shrink-0 text-sm font-medium tabular-nums">{elapsed}</span>

        {/* Live (recording) or frozen (paused) waveform — same bar strip
            either way, just animating only while actual audio is being
            captured. During preview playback the bars ahead of
            previewProgress dim to show what's already been heard. */}
        <div className="flex h-8 flex-1 items-center gap-[2px] overflow-hidden">
          {waveformLevels.length === 0 ? (
            <span className="text-xs text-muted">{recordingState === "recording" ? "Gravando..." : "Gravação pausada"}</span>
          ) : (
            waveformLevels.map((level, i) => (
              <span
                key={i}
                className={clsx(
                  "w-[3px] shrink-0 rounded-full bg-primary transition-opacity",
                  recordingState === "paused" && i / waveformLevels.length > previewProgress && "opacity-30"
                )}
                style={{ height: `${8 + level * 24}px` }}
              />
            ))
          )}
        </div>

        {recordingState === "paused" && previewUrl && (
          <audio
            ref={previewAudioRef}
            src={previewUrl}
            onPlay={() => setPreviewPlaying(true)}
            onPause={() => setPreviewPlaying(false)}
            onEnded={() => {
              setPreviewPlaying(false);
              setPreviewProgress(0);
            }}
            onTimeUpdate={(e) => {
              const audio = e.currentTarget;
              if (audio.duration) setPreviewProgress(audio.currentTime / audio.duration);
            }}
            className="hidden"
          />
        )}

        <div className="ml-auto flex shrink-0 gap-2">
          {recordingState === "recording" ? (
            <button onClick={pauseRecording} className="focus-ring rounded-full p-2 text-muted hover:bg-surface-alt" aria-label="Pausar gravação">
              <Pause className="h-5 w-5" />
            </button>
          ) : (
            <button onClick={resumeRecording} className="focus-ring rounded-full p-2 text-muted hover:bg-surface-alt" aria-label="Retomar gravação">
              <Mic className="h-5 w-5" />
            </button>
          )}
          <button onClick={finishAndSend} className="focus-ring rounded-full bg-primary p-2 text-primary-fg" aria-label="Enviar áudio">
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>
    );
  }

  if (pendingLocation) {
    // OpenStreetMap's own embeddable iframe (openstreetmap.org/export) —
    // no API key, no third-party static-image proxy (that broke rendering
    // for received locations before, see MessageBubble) — just OSM's site
    // itself, centered on a small box around the pin.
    const delta = 0.01;
    const bbox = `${pendingLocation.lng - delta},${pendingLocation.lat - delta},${pendingLocation.lng + delta},${pendingLocation.lat + delta}`;
    const mapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${pendingLocation.lat},${pendingLocation.lng}`;
    return (
      <div className="border-t border-border bg-surface p-4">
        <div className="mb-3 overflow-hidden rounded-card border border-border">
          <iframe title="Prévia da localização" src={mapSrc} className="h-56 w-full" />
          <div className="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              {pendingLocation.lat.toFixed(5)}, {pendingLocation.lng.toFixed(5)}
            </p>
            <button onClick={() => setPendingLocation(null)} className="focus-ring shrink-0 rounded-full p-1.5 text-muted hover:bg-surface" aria-label="Cancelar envio">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmSendLocation()}
            placeholder="Adicionar comentário (opcional)"
            autoFocus
            className="focus-ring flex-1 rounded-full border border-border bg-transparent px-4 py-2 text-sm"
          />
          <button
            onClick={confirmSendLocation}
            disabled={sending}
            className="focus-ring flex shrink-0 items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            <Send className="h-4 w-4" /> Enviar localização
          </button>
        </div>
      </div>
    );
  }

  if (pendingFiles.length > 0) {
    const active = pendingFiles[activeFileIndex];
    const activeUrl = active ? getPreviewUrl(active.file) : null;
    const activeIsImage = active?.file.type.startsWith("image/");
    const activeIsVideo = active?.file.type.startsWith("video/");
    return (
      <div className="border-t border-border bg-surface p-4">
        {/* Filmstrip — only worth showing once there's more than one file to
            switch between, same as WhatsApp Web's own multi-attachment picker. */}
        {pendingFiles.length > 1 && (
          <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1">
            {pendingFiles.map((entry, i) => {
              const thumbUrl = getPreviewUrl(entry.file);
              const isImage = entry.file.type.startsWith("image/");
              const isVideo = entry.file.type.startsWith("video/");
              return (
                <div key={i} className="group relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setActiveFileIndex(i)}
                    className={`h-14 w-14 overflow-hidden rounded-card border-2 ${i === activeFileIndex ? "border-primary" : "border-transparent"}`}
                  >
                    {isImage && thumbUrl ? (
                      <img src={thumbUrl} alt={entry.file.name} className="h-full w-full object-cover" />
                    ) : isVideo && thumbUrl ? (
                      <video src={thumbUrl} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-surface-alt text-[10px] text-muted">Arquivo</div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => removePendingFile(i)}
                    className="focus-ring absolute -right-1 -top-1 rounded-full bg-surface p-0.5 text-muted shadow-soft hover:text-red-600"
                    aria-label={`Remover ${entry.file.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="focus-ring flex h-14 w-14 shrink-0 items-center justify-center rounded-card border border-dashed border-border text-muted hover:bg-surface-alt"
              aria-label="Adicionar mais arquivos"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
        )}

        {active && (
          <div className="mb-3 flex items-center gap-3 rounded-card border border-border bg-surface-alt p-3">
            {activeIsImage && activeUrl ? (
              <img src={activeUrl} alt={active.file.name} className="h-16 w-16 rounded object-cover" />
            ) : activeIsVideo && activeUrl ? (
              <video src={activeUrl} className="h-16 w-16 rounded object-cover" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded bg-surface text-xs text-muted">Arquivo</div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{active.file.name}</p>
              <p className="text-xs text-muted">{(active.file.size / 1024).toFixed(0)} KB</p>
            </div>
            {pendingFiles.length === 1 && (
              <button onClick={() => removePendingFile(activeFileIndex)} className="focus-ring shrink-0 rounded-full p-1.5 text-muted hover:bg-surface" aria-label="Cancelar envio">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            key={activeFileIndex}
            value={active?.caption ?? ""}
            onChange={(e) => updateActiveCaption(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmSendFiles()}
            onPaste={handlePaste}
            placeholder={pendingFiles.length > 1 ? "Adicionar legenda a este anexo (opcional)" : "Adicionar legenda (opcional)"}
            autoFocus
            className="focus-ring flex-1 rounded-full border border-border bg-transparent px-4 py-2 text-sm"
          />
          <button
            onClick={confirmSendFiles}
            disabled={sending}
            className="focus-ring flex shrink-0 items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            <Send className="h-4 w-4" />
            {sendingFileProgress ? `Enviando ${sendingFileProgress.done}/${sendingFileProgress.total}...` : pendingFiles.length > 1 ? `Enviar (${pendingFiles.length})` : "Enviar"}
          </button>
        </div>
      </div>
    );
  }

  const FORMAT_BUTTONS: { marker: string; label: string; Icon: typeof Bold; className?: string }[] = [
    { marker: "*", label: "Negrito", Icon: Bold },
    { marker: "_", label: "Itálico", Icon: Italic },
    { marker: "~", label: "Riscado", Icon: Strikethrough },
    { marker: "```", label: "Monoespaçado", Icon: Code, className: "text-[13px] font-mono" },
  ];

  return (
    <>
      {selectionBubble && (
        <div
          className="shadow-elevated fixed z-50 flex items-center gap-0.5 rounded-full border border-border bg-surface p-1"
          style={{ top: selectionBubble.top, left: selectionBubble.left }}
          // Keeps the textarea's selection alive — clicking the bubble
          // would otherwise blur the textarea (collapsing the selection)
          // before the button's onClick ever runs.
          onMouseDown={(e) => e.preventDefault()}
        >
          {FORMAT_BUTTONS.map(({ marker, label, Icon, className }) => (
            <button
              key={marker}
              type="button"
              onClick={() => wrapSelection(marker)}
              className={`focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-[var(--color-text)] ${className ?? ""}`}
              aria-label={label}
              title={label}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}

      <div className="relative border-t border-border bg-surface">
        {writingSuggestions.length > 0 && (
          // Normal document flow (not absolute/fixed like the quick-reply
          // menu above) — this grows the composer and pushes the chat up
          // instead of floating on top of it. See PROMPT: "ficou em cima do
          // texto" — the earlier caret-anchored floating chip covered the
          // message being typed.
          <div className="border-b border-border bg-surface-alt px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-medium text-muted">
                <Wand2 className="h-3.5 w-3.5 text-secondary" />
                {writingSuggestions.length === 1 ? "1 sugestão de escrita" : `${writingSuggestions.length} sugestões de escrita`}
              </span>
              <div className="flex items-center gap-3">
                {writingSuggestions.length > 1 && (
                  <button type="button" onClick={applyAllWritingSuggestions} className="focus-ring font-medium text-primary hover:underline">
                    Aplicar todas
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setWritingSuggestions([])}
                  className="focus-ring rounded-full p-0.5 text-muted hover:bg-surface"
                  aria-label="Dispensar sugestões"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
            <div className="mt-1.5 space-y-1">
              {writingSuggestions.map((s, i) => (
                <div key={`${s.offset}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="text-muted line-through">{text.slice(s.offset, s.offset + s.length)}</span>
                    <span className="mx-1 text-muted">→</span>
                    <span className="font-medium text-secondary">{s.replacement}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => applyWritingSuggestion(s)}
                    className="focus-ring shrink-0 rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-fg hover:opacity-90"
                  >
                    Aplicar
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {mentionOptions.length > 0 && (
          <div className="shadow-elevated absolute bottom-full left-3 z-20 mb-1 w-72 overflow-hidden rounded-card border border-border bg-surface" onMouseDown={(e) => e.preventDefault()}>
            <p className="border-b border-border px-3 py-1.5 text-[11px] font-semibold text-muted">Marcar no grupo</p>
            {mentionOptions.map((option) => (
              <button key={option.jid || ALL_LABEL} type="button" onClick={() => chooseMention(option)} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-alt">
                <span className="truncate">{option.jid ? option.name : "Todos do grupo"}</span>
                <span className="shrink-0 text-xs text-muted">{option.jid ? (option.phone ? `+${option.phone}` : "") : `@${ALL_LABEL}`}</span>
              </button>
            ))}
          </div>
        )}
        {dataTags.suggestions.length > 0 && (
          <div className="shadow-elevated absolute bottom-full left-3 z-20 mb-1 w-64 overflow-hidden rounded-card border border-border bg-surface" onMouseDown={(e) => e.preventDefault()}>
            <p className="border-b border-border px-3 py-1.5 text-[11px] font-semibold text-muted">Dados do cliente</p>
            {dataTags.suggestions.map((column) => (
              <button key={column} type="button" onClick={() => chooseDataTag(column)} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-alt">
                <code className="text-xs">{`{{dados.${column}}}`}</code>
              </button>
            ))}
          </div>
        )}
        <DataTagPreview render={dataTags.render} freeFields={dataTags.freeFields} freeValues={dataTags.freeValues} onFreeValue={dataTags.setFreeValue} />
        {quickReplyMenuOpen && (
          <div
            className="shadow-elevated absolute bottom-full left-3 right-3 z-20 mb-1 max-h-64 overflow-y-auto rounded-card border border-border bg-surface"
            // Same trick as the formatting toolbar above: without this,
            // clicking a row blurs the textarea before the click's onClick
            // ever runs.
            onMouseDown={(e) => e.preventDefault()}
          >
            {filteredQuickReplies.map((qr, i) => (
              <button
                key={qr.id}
                type="button"
                onClick={() => selectQuickReply(qr)}
                className={clsx(
                  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm",
                  i === quickReplyActiveIndex ? "bg-surface-alt" : "hover:bg-surface-alt"
                )}
              >
                <span className="flex items-center gap-2">
                  {qr.media && <MediaKindIcon kind={qr.media.kind} />}
                  <span className="font-medium">{qr.name}</span>
                  <code className="rounded bg-surface px-1 text-xs text-muted">/{qr.shortcut}</code>
                </span>
                {qr.dataUnavailable && <span className="text-[11px] font-semibold text-danger">Indisponível: nenhuma fonte de dados ativa</span>}
                <span className="line-clamp-1 w-full text-xs text-muted">{qr.filledText ?? qr.text}</span>
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className="flex items-center justify-between border-b border-border bg-surface-alt px-4 py-2 text-xs">
            <div className="min-w-0">
              <p className="font-semibold">{replyTo.senderAgentDisplayName ?? "Cliente"}</p>
              <p className="truncate text-muted">{replyTo.body ?? "Anexo"}</p>
            </div>
            <button onClick={onCancelReply} className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface" aria-label="Cancelar resposta">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Always-visible formatting row, in addition to the bubble that
            appears over an active selection — some agents never notice a
            floating bubble, so the same controls stay reachable here too. */}
        <div className="flex items-center gap-0.5 border-b border-border px-3 py-1" onMouseDown={(e) => e.preventDefault()}>
          {FORMAT_BUTTONS.map(({ marker, label, Icon, className }) => (
            <button
              key={marker}
              type="button"
              onClick={() => wrapSelection(marker)}
              className={`focus-ring rounded p-1.5 text-muted hover:bg-surface-alt hover:text-[var(--color-text)] ${className ?? ""}`}
              aria-label={label}
              title={label}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>

        <div className="flex items-end gap-1 px-3 py-2">
        <div className="relative" ref={emojiPanelRef}>
          <button
            onClick={() => setShowEmoji((s) => !s)}
            className="focus-ring rounded-full p-2 text-muted hover:bg-surface-alt"
            aria-label="Inserir emoji"
            type="button"
          >
            🙂
          </button>
          {showEmoji && (
            <div className="shadow-elevated absolute bottom-12 left-0 z-10 w-72 rounded-card border border-border bg-surface p-2">
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {EMOJI_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{group.label}</p>
                    <div className="grid grid-cols-8 gap-0.5">
                      {group.emojis.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => {
                            setText((t) => t + emoji);
                            textareaRef.current?.focus();
                          }}
                          className="focus-ring rounded p-1 text-lg transition-transform hover:scale-125 hover:bg-surface-alt"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <button onClick={() => fileInputRef.current?.click()} className="focus-ring rounded-full p-2 text-muted hover:bg-surface-alt" aria-label="Anexar arquivo" type="button">
          <Paperclip className="h-5 w-5" />
        </button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileChange} />

        <button
          onClick={handleShareLocation}
          disabled={locationRequesting}
          className="focus-ring rounded-full p-2 text-muted hover:bg-surface-alt disabled:opacity-60"
          aria-label="Enviar localização"
          title={locationRequesting ? "Obtendo sua localização..." : "Enviar localização"}
          type="button"
        >
          <MapPin className={clsx("h-5 w-5", locationRequesting && "animate-pulse")} />
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            updateSelectionBubble();
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onSelect={updateSelectionBubble}
          onMouseUp={updateSelectionBubble}
          onBlur={() => setSelectionBubble(null)}
          disabled={disabled}
          rows={1}
          spellCheck
          lang="pt-BR"
          placeholder="Digite uma mensagem"
          className="focus-ring mx-1 flex-1 resize-none rounded-2xl border border-border bg-transparent px-4 py-2 text-sm leading-5 disabled:opacity-60"
        />

        {text.trim() && onScheduleText && (
          <div className="relative shrink-0">
            <button
              onClick={() => setScheduleOpen((o) => !o)}
              disabled={sending || disabled}
              className="focus-ring rounded-full p-2.5 text-muted hover:bg-surface-alt disabled:opacity-60"
              aria-label="Agendar envio"
              title="Agendar envio"
              type="button"
            >
              <CalendarClock className="h-5 w-5" />
            </button>
            {scheduleOpen && (
              <WhenPicker
                title="Agendar envio"
                confirmLabel="Agendar"
                busy={scheduling}
                className="bottom-12 right-0"
                onConfirm={(at) => handleSchedule(at)}
                onClose={() => setScheduleOpen(false)}
              />
            )}
          </div>
        )}
        {text.trim() ? (
          <button
            onClick={handleSend}
            disabled={sending || disabled}
            className="focus-ring shrink-0 rounded-full bg-primary p-2.5 text-primary-fg disabled:opacity-60"
            aria-label="Enviar mensagem"
            type="button"
          >
            <Send className="h-5 w-5" />
          </button>
        ) : (
          <button onClick={startRecording} disabled={disabled} className="focus-ring shrink-0 rounded-full p-2.5 text-muted hover:bg-surface-alt" aria-label="Gravar áudio" type="button">
            <Mic className="h-5 w-5" />
          </button>
        )}
        </div>
      </div>
    </>
  );
});

function MediaKindIcon({ kind }: { kind: ReplyMediaDTO["kind"] }) {
  const label = kind === "IMAGE" ? "Com imagem" : kind === "VIDEO" ? "Com vídeo" : "Com PDF";
  const Icon = kind === "IMAGE" ? ImageIcon : kind === "VIDEO" ? Video : FileText;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-label={label} />;
}
