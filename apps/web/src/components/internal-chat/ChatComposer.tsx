import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { BarChart3, Check, Eye, FileText, Link2, Mic, Paperclip, Pencil, Reply, Send, Smile, Timer, Trash2, X } from "lucide-react";
import {
  CHAT_MAX_AUDIO_SECONDS,
  CHAT_TEMPORARY_PRESETS,
  chatDurationLabel,
  type ChatMessageDTO,
  type ChatRoomDTO,
  type ConversationListItemDTO,
} from "@whatsatendende/types";
import { EmojiPicker } from "../common/EmojiPicker";
import { api, getApiErrorMessage } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";
import { formatAudioTime } from "./ChatAudioPlayer";
import { PersonAvatar } from "./ChatAvatar";
import { ChatDialog } from "./ChatDialogs";

const TYPING_THROTTLE_MS = 3_000;
const MAX_TEXTAREA_LINES = 10;
const WAVEFORM_BARS = 40;

export interface ChatComposerHandle {
  addFiles: (files: File[]) => void;
  focus: () => void;
}

interface Props {
  room: ChatRoomDTO;
  meId: string | null;
  replyTo: ChatMessageDTO | null;
  onCancelReply: () => void;
  editing: ChatMessageDTO | null;
  onCancelEdit: () => void;
  onSent: () => void;
}

/** First name as it's typed after @ ("@Ana"). */
const handleOf = (name: string) => name.trim().split(/\s+/)[0];

export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer({ room, meId, replyTo, onCancelReply, editing, onCancelEdit, onSent }, ref) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [viewOnce, setViewOnce] = useState(false);
  const [ttl, setTtl] = useState<number | null>(null);
  const [linked, setLinked] = useState<ConversationListItemDTO | null>(null);
  const [panel, setPanel] = useState<"emoji" | "link" | "ttl" | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentioned, setMentioned] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  function insertEmoji(emoji: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);

  // Recording
  const [recording, setRecording] = useState(false);
  const [recordMs, setRecordMs] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const samplerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const allLevels = useRef<number[]>([]);

  const others = room.members.filter((m) => m.userId !== meId);

  useImperativeHandle(ref, () => ({
    addFiles: (incoming) => setFiles((current) => [...current, ...incoming].slice(0, 10)),
    focus: () => textareaRef.current?.focus(),
  }));

  useEffect(() => {
    if (editing) {
      setText(editing.body ?? "");
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [editing]);
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = parseFloat(getComputedStyle(el).lineHeight || "20") * MAX_TEXTAREA_LINES;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [text]);

  useEffect(() => () => stopRecording(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: myConversations } = useQuery({
    queryKey: ["mine"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/mine")).data,
    enabled: panel === "link",
  });

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const people = others.filter((m) => m.name.toLowerCase().includes(q)).map((m) => ({ id: m.userId, name: m.name, photoUrl: m.photoUrl }));
    const all = room.kind !== "DIRECT" && "todos".startsWith(q) ? [{ id: "ALL", name: "todos", photoUrl: null }] : [];
    return [...people, ...all].slice(0, 8);
  }, [mentionQuery, others, room.kind]);

  function sendTyping(kind: "typing" | "recording") {
    if (Date.now() - lastTypingSent.current < TYPING_THROTTLE_MS) return;
    lastTypingSent.current = Date.now();
    api.post(`/internal-chat/rooms/${room.id}/typing`, { kind }).catch(() => undefined);
  }

  function onChange(value: string) {
    setText(value);
    if (value) sendTyping("typing");
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/(?:^|\s)@([\p{L}\d]*)$/u);
    setMentionQuery(match ? match[1] : null);
    setMentionIndex(0);
  }

  function pickMention(option: { id: string; name: string }) {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\p{L}\d]*)$/u, `@${option.id === "ALL" ? "todos" : handleOf(option.name)} `);
    const next = before + text.slice(caret);
    setText(next);
    setMentioned((m) => ({ ...m, [option.id]: option.id === "ALL" ? "todos" : handleOf(option.name) }));
    setMentionQuery(null);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    }, 0);
  }

  const mentionsInText = () => Object.entries(mentioned).filter(([, handle]) => new RegExp(`@${handle}(?![\\p{L}\\d])`, "u").test(text)).map(([id]) => id);

  function reset() {
    setText("");
    setFiles([]);
    setLinked(null);
    setTtl(null);
    setViewOnce(false);
    setMentioned({});
    setPanel(null);
    onCancelReply();
    onSent();
  }

  const editMutation = useMutation({
    mutationFn: () => api.patch(`/internal-chat/messages/${editing!.id}`, { body: text }),
    onSuccess: () => {
      setText("");
      onCancelEdit();
      onSent();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  async function send() {
    if (sending) return;
    if (editing) return editMutation.mutate();
    if (!text.trim() && !files.length && !linked) return;
    setSending(true);
    try {
      const mentions = mentionsInText();
      if (files.length) {
        for (const [i, file] of files.entries()) {
          const form = new FormData();
          form.append("file", file);
          if (i === 0 && text.trim()) form.append("body", text.trim());
          if (i === 0 && replyTo) form.append("replyToId", replyTo.id);
          if (i === 0 && mentions.length) form.append("mentions", JSON.stringify(mentions));
          if (ttl) form.append("ttlSeconds", String(ttl));
          if (viewOnce) form.append("viewOnce", "true");
          await api.post(`/internal-chat/rooms/${room.id}/files`, form);
        }
        if (linked) await api.post(`/internal-chat/rooms/${room.id}/messages`, { conversationId: linked.id, ttlSeconds: ttl ?? undefined });
      } else {
        await api.post(`/internal-chat/rooms/${room.id}/messages`, {
          body: text || undefined,
          conversationId: linked?.id,
          replyToId: replyTo?.id,
          mentions,
          ttlSeconds: ttl ?? undefined,
        });
      }
      reset();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  // --- Audio --------------------------------------------------------------------
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = MediaRecorder.isTypeSupported("audio/webm") ? new MediaRecorder(stream, { mimeType: "audio/webm" }) : new MediaRecorder(stream);
      chunksRef.current = [];
      allLevels.current = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      recorder.start();
      recorderRef.current = recorder;
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      startedAt.current = Date.now();
      setRecording(true);
      setRecordMs(0);
      setLevels([]);
      samplerRef.current = setInterval(() => {
        analyser.getByteFrequencyData(buffer);
        const level = Math.min(100, Math.round((buffer.reduce((a, b) => a + b, 0) / buffer.length / 128) * 100));
        allLevels.current.push(level);
        setLevels((l) => [...l.slice(-31), level]);
        const elapsed = Date.now() - startedAt.current;
        setRecordMs(elapsed);
        sendTyping("recording");
        if (elapsed >= CHAT_MAX_AUDIO_SECONDS * 1000) void finishRecording();
      }, 100);
    } catch {
      toast.error("Não foi possível usar o microfone. Confira a permissão do navegador (o sistema precisa estar em https).");
    }
  }

  function stopRecording(discard: boolean) {
    if (samplerRef.current) clearInterval(samplerRef.current);
    samplerRef.current = null;
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    const recorder = recorderRef.current;
    if (recorder) {
      if (discard) recorder.onstop = null;
      recorder.stream.getTracks().forEach((t) => t.stop());
      if (recorder.state !== "inactive") recorder.stop();
    }
    if (discard) recorderRef.current = null;
    setRecording(false);
  }

  async function finishRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const durationMs = Date.now() - startedAt.current;
    const levelsSnapshot = allLevels.current;
    recorder.onstop = async () => {
      const mime = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mime });
      recorderRef.current = null;
      if (durationMs < 800) return;
      const step = Math.max(1, levelsSnapshot.length / WAVEFORM_BARS);
      const waveform = Array.from({ length: Math.min(WAVEFORM_BARS, levelsSnapshot.length) }, (_, i) => {
        const slice = levelsSnapshot.slice(Math.floor(i * step), Math.floor((i + 1) * step));
        return Math.round(Math.max(...slice, 5));
      });
      const form = new FormData();
      form.append("file", new File([blob], `audio-${Date.now()}.${mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm"}`, { type: mime.split(";")[0] }));
      form.append("audioDurationMs", String(Math.min(durationMs, CHAT_MAX_AUDIO_SECONDS * 1000)));
      form.append("audioWaveform", JSON.stringify(waveform));
      if (replyTo) form.append("replyToId", replyTo.id);
      if (ttl) form.append("ttlSeconds", String(ttl));
      try {
        await api.post(`/internal-chat/rooms/${room.id}/files`, form);
        reset();
      } catch (err) {
        toast.error(getApiErrorMessage(err));
      }
    };
    stopRecording(false);
  }

  const empty = !text.trim() && !files.length && !linked;

  return (
    <div className="relative border-t border-border bg-surface px-3 pb-3 pt-2">
      {mentionOptions.length > 0 && (
        <div className="absolute bottom-full left-14 z-20 mb-1 w-60 rounded-xl border border-border bg-surface p-1 shadow-elevated" role="listbox" aria-label="Mencionar">
          <p className="px-2 py-1 text-[10.5px] font-bold uppercase tracking-wider text-muted">Mencionar</p>
          {mentionOptions.map((o, i) => (
            <button
              key={o.id}
              type="button"
              onMouseDown={(e) => (e.preventDefault(), pickMention(o))}
              className={clsx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", i === mentionIndex ? "bg-primary/10" : "hover:bg-surface-alt")}
            >
              {o.id === "ALL" ? <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-fg">@</span> : <PersonAvatar name={o.name} photoUrl={o.photoUrl} id={o.id} size="xs" />}
              {o.id === "ALL" ? "todos do grupo" : o.name}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {editing && (
          <Bar tone="info" icon={<Pencil className="h-4 w-4" />} title="Editando mensagem" subtitle={editing.body ?? ""} onClose={() => (onCancelEdit(), setText(""))} />
        )}
        {replyTo && !editing && (
          <Bar tone="primary" icon={<Reply className="h-4 w-4" />} title={`Respondendo a ${replyTo.authorName ?? "mensagem"}`} subtitle={replyTo.body ?? (replyTo.kind === "AUDIO" ? "🎤 Áudio" : replyTo.attachment?.name ?? "")} onClose={onCancelReply} />
        )}
        {linked && (
          <Bar tone="primary" icon={<Link2 className="h-4 w-4" />} title={contactDisplayName(linked.contact)} subtitle="Conversa de cliente citada" onClose={() => setLinked(null)} closeLabel="Tirar a citação" />
        )}
        {(ttl || viewOnce) && (
          <div className="flex flex-wrap gap-1.5">
            {ttl && (
              <Chip onClose={() => setTtl(null)}>
                <Timer className="h-3.5 w-3.5" /> Temporária: some em {chatDurationLabel(ttl)}
              </Chip>
            )}
            {viewOnce && (
              <Chip onClose={() => setViewOnce(false)}>
                <Eye className="h-3.5 w-3.5" /> Visualização única
              </Chip>
            )}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-border bg-surface-alt px-2 py-1 text-xs">
                <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate">{f.name}</span>
                <button type="button" onClick={() => setFiles(files.filter((_, x) => x !== i))} className="rounded-full p-0.5 text-muted hover:bg-surface" aria-label={`Tirar ${f.name}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {panel === "emoji" && (
          <EmojiPicker className="h-72" onPick={insertEmoji} />
        )}
        {panel === "link" && (
          <div className="max-h-44 overflow-y-auto rounded-xl border border-border bg-surface p-1">
            <p className="px-2 py-1 text-[10.5px] font-bold uppercase tracking-wider text-muted">Citar conversa de cliente</p>
            {(myConversations ?? []).length === 0 && <p className="px-2 py-1.5 text-xs text-muted">Você não tem conversas em atendimento.</p>}
            {myConversations?.map((c) => (
              <button key={c.id} type="button" onClick={() => (setLinked(c), setPanel(null))} className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-alt">
                {contactDisplayName(c.contact)}
              </button>
            ))}
          </div>
        )}
        {panel === "ttl" && (
          <div className="rounded-xl border border-border bg-surface p-1 text-sm">
            <p className="px-2 py-1 text-[10.5px] font-bold uppercase tracking-wider text-muted">Enviar como temporária</p>
            {CHAT_TEMPORARY_PRESETS.map((s) => (
              <button key={s} type="button" onClick={() => (setTtl(s), setPanel(null))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-alt">
                <Timer className="h-4 w-4 text-warning" /> Some em {chatDurationLabel(s)}
                {ttl === s && <Check className="ml-auto h-4 w-4 text-primary" />}
              </button>
            ))}
            <button type="button" onClick={() => (setViewOnce((v) => !v), setPanel(null))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-alt">
              <Eye className="h-4 w-4 text-primary" /> Arquivo de visualização única
              {viewOnce && <Check className="ml-auto h-4 w-4 text-primary" />}
            </button>
          </div>
        )}

        {recording ? (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => stopRecording(true)} className="focus-ring rounded-full p-2 text-danger hover:bg-danger-soft" aria-label="Descartar áudio">
              <Trash2 className="h-5 w-5" />
            </button>
            <div className="flex h-10 flex-1 items-center gap-2 rounded-full bg-danger-soft px-3 font-bold text-danger">
              <span className="chat-pulse h-2.5 w-2.5 rounded-full bg-danger" />
              <span className="tabular-nums">{formatAudioTime(recordMs)}</span>
              <span className="flex h-6 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden>
                {levels.map((l, i) => (
                  <span key={i} className="w-[3px] rounded-full bg-danger" style={{ height: `${Math.max(12, l)}%` }} />
                ))}
              </span>
              <span className="text-[11px] font-semibold opacity-80">até {CHAT_MAX_AUDIO_SECONDS / 60} min</span>
            </div>
            <button type="button" onClick={() => void finishRecording()} className="focus-ring flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-fg shadow-md" aria-label="Enviar áudio">
              <Send className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-1">
            <ToolButton label="Emojis" active={panel === "emoji"} onClick={() => setPanel(panel === "emoji" ? null : "emoji")}>
              <Smile className="h-5 w-5" />
            </ToolButton>
            {!editing && (
              <>
                <ToolButton label="Anexar arquivos" onClick={() => fileRef.current?.click()}>
                  <Paperclip className="h-5 w-5" />
                </ToolButton>
                <ToolButton label="Citar conversa de cliente" active={panel === "link"} onClick={() => setPanel(panel === "link" ? null : "link")}>
                  <Link2 className="h-5 w-5" />
                </ToolButton>
                <ToolButton label="Enquete" onClick={() => setPollOpen(true)}>
                  <BarChart3 className="h-5 w-5" />
                </ToolButton>
                <ToolButton label="Enviar como temporária" active={panel === "ttl" || Boolean(ttl) || viewOnce} onClick={() => setPanel(panel === "ttl" ? null : "ttl")} tone="warning">
                  <Timer className="h-5 w-5" />
                </ToolButton>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                if (picked.length) setFiles((current) => [...current, ...picked].slice(0, 10));
                e.target.value = "";
              }}
            />
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files);
                if (pasted.length) {
                  e.preventDefault();
                  setFiles((current) => [...current, ...pasted].slice(0, 10));
                }
              }}
              onKeyDown={(e) => {
                if (mentionOptions.length) {
                  if (e.key === "ArrowDown") return e.preventDefault(), setMentionIndex((i) => (i + 1) % mentionOptions.length);
                  if (e.key === "ArrowUp") return e.preventDefault(), setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
                  if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pickMention(mentionOptions[mentionIndex]);
                  if (e.key === "Escape") return setMentionQuery(null);
                }
                if (e.key === "Escape" && editing) return onCancelEdit(), setText("");
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={room.kind === "DIRECT" ? `Mensagem para ${room.name}` : `Mensagem para ${room.name} — use @ para mencionar`}
              className="focus-ring min-h-[2.5rem] flex-1 resize-none rounded-[20px] border border-border bg-surface-alt px-4 py-2 text-sm"
            />
            {empty && !editing ? (
              <button type="button" onClick={startRecording} className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg shadow-md" aria-label="Gravar áudio" title="Gravar áudio">
                <Mic className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || editMutation.isPending}
                className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg shadow-md disabled:opacity-60"
                aria-label={editing ? "Salvar edição" : "Enviar"}
              >
                {editing ? <Check className="h-5 w-5" /> : <Send className="h-4 w-4" />}
              </button>
            )}
          </div>
        )}
      </div>
      {pollOpen && <PollDialog roomId={room.id} onClose={() => setPollOpen(false)} onSent={onSent} />}
    </div>
  );
});

function ToolButton({ label, onClick, active, tone, children }: { label: string; onClick: () => void; active?: boolean; tone?: "warning"; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={clsx("focus-ring shrink-0 rounded-full p-2 hover:bg-surface-alt", active ? (tone === "warning" ? "bg-warning-soft text-warning" : "bg-primary/10 text-primary") : "text-muted")}
    >
      {children}
    </button>
  );
}

function Bar({ tone, icon, title, subtitle, onClose, closeLabel = "Cancelar" }: { tone: "info" | "primary"; icon: React.ReactNode; title: string; subtitle: string; onClose: () => void; closeLabel?: string }) {
  return (
    <div className={clsx("flex items-center gap-2.5 rounded-xl border-l-[3px] px-3 py-1.5 text-xs", tone === "info" ? "border-info bg-info-soft" : "border-primary bg-primary/10")}>
      <span className={tone === "info" ? "text-info" : "text-primary"}>{icon}</span>
      <span className="min-w-0 flex-1">
        <b className="block">{title}</b>
        <span className="block truncate text-muted">{subtitle}</span>
      </span>
      <button type="button" onClick={onClose} className="rounded-full bg-surface p-1 text-muted hover:text-[var(--color-text)]" aria-label={closeLabel} title={closeLabel}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Chip({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning">
      {children}
      <button type="button" onClick={onClose} className="rounded-full p-0.5 hover:bg-white/40" aria-label="Tirar">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function PollDialog({ roomId, onClose, onSent }: { roomId: string; onClose: () => void; onSent: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const mutation = useMutation({
    mutationFn: () => api.post(`/internal-chat/rooms/${roomId}/polls`, { question, options: options.filter((o) => o.trim()), multiple }),
    onSuccess: () => (onSent(), onClose()),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const filled = options.filter((o) => o.trim()).length;
  return (
    <ChatDialog title="Criar enquete" icon={<BarChart3 className="h-4 w-4 text-primary" />} onClose={onClose}>
      <div className="space-y-2.5">
        <input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Pergunta" maxLength={300} className="focus-ring w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm font-semibold" />
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={o}
              onChange={(e) => {
                const next = [...options];
                next[i] = e.target.value;
                if (i === options.length - 1 && e.target.value && options.length < 12) next.push("");
                setOptions(next);
              }}
              placeholder={`Opção ${i + 1}`}
              maxLength={100}
              className="focus-ring w-full rounded-card border border-border bg-surface-alt px-3 py-1.5 text-sm"
            />
            {options.length > 2 && (
              <button type="button" onClick={() => setOptions(options.filter((_, x) => x !== i))} className="rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Tirar opção">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
          Permitir mais de uma resposta
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="focus-ring rounded-card border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-alt">
            Cancelar
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!question.trim() || filled < 2 || mutation.isPending}
            className="focus-ring inline-flex items-center gap-1.5 rounded-card bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg disabled:opacity-50"
          >
            Enviar enquete
          </button>
        </div>
      </div>
    </ChatDialog>
  );
}
