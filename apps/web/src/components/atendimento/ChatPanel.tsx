import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlarmClock, ArrowLeft, ArrowRightLeft, CalendarClock, CheckCircle2, FileText, Lock, MessageSquareOff, Mic, PanelRight, Paperclip, Phone, Pin, PinOff, Smartphone, StickyNote } from "lucide-react";
import { format } from "date-fns";
import clsx from "clsx";
import { PERMISSION, type ConversationListItemDTO, type ConversationNoteDTO, type MessageDTO, type PaginatedResult, type QuickReplyDTO, type TemplateContextDTO } from "@whatsatendende/types";
import { toastWithUndo } from "../../lib/undoToast";
import { api, getApiErrorMessage } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";
import { formatPhone } from "../../lib/format-phone";
import { useJumpToMessage } from "../../hooks/useJumpToMessage";
import { getSocket } from "../../lib/socket";
import { useAuthStore } from "../../store/auth-store";
import { MessageBubble } from "./MessageBubble";
import { Composer, type ComposerHandle } from "./Composer";
import { TransferModal } from "./TransferModal";
import { ForwardModal } from "./ForwardModal";
import { PinnedContactNote } from "./PinnedContactNote";
import { SuspensionWarningModal } from "./SuspensionWarningModal";
import { BirthdayModal } from "./BirthdayModal";
import { SendTemplateModal } from "./SendTemplateModal";
import { TransferNoteCard } from "./TransferNoteCard";
import { TimelineByDay, type TimelineEntry } from "./TimelineByDay";
import { ContactPhoto } from "../common/ContactPhoto";
import { useAgentExtras } from "../../hooks/useAgentExtras";
import { useCustomerTyping } from "../../store/typing-store";
import { WhenPicker } from "./WhenPicker";
import { NoReturnStatus, useNoReturnHold, useNoReturnSettings } from "./NoReturn";
import { ConversationSearchBar, ConversationSearchButton, useConversationSearch } from "./ConversationSearch";

async function fetchMessages(conversationId: string, cursor?: string) {
  // 100 (the API's own max) rather than a smaller page, since every page
  // beyond the first is now fetched automatically back-to-back until the
  // whole history is loaded — fewer round trips to get there.
  const res = await api.get<PaginatedResult<MessageDTO>>(`/messages/conversations/${conversationId}`, {
    params: { cursor, limit: 100 },
  });
  return res.data;
}

export function ChatPanel({
  conversation,
  onClosed,
  onBack,
  onConversationStarted,
  clientPanelOpen,
  onToggleClientPanel,
  headerActions,
}: {
  conversation: ConversationListItemDTO;
  /** Replaces Transferir/Encerrar in the header — Gestão's intervention panel puts Devolver/Transferir/Encerrar there. */
  headerActions?: ReactNode;
  onClosed: () => void;
  onBack?: () => void;
  /** Whether the client panel beside the chat is expanded — drives the header toggle's pressed state. */
  clientPanelOpen?: boolean;
  onToggleClientPanel?: () => void;
  /** A new conversation was started from a vCard received in this chat (see MessageBubble's "Iniciar conversa") — the caller decides what to do with it (open it, refresh lists...). */
  onConversationStarted?: (conversation: ConversationListItemDTO) => void;
}) {
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");
  const userId = useAuthStore((s) => s.user?.id);
  // Gestão › Intervir: someone else took over replying — this agent follows along and can only leave notes.
  const lockedByIntervention = Boolean(conversation.intervention && conversation.intervention.userId !== userId);
  const canTransfer = permissions?.[PERMISSION.ATENDIMENTO_TRANSFERIR] && !lockedByIntervention && !headerActions;
  const canClose = permissions?.[PERMISSION.ATENDIMENTO_ENCERRAR] && !lockedByIntervention && !headerActions;
  // A disconnected connection can't actually deliver anything — see PROMPT:
  // "não permitindo enviar mensagens... de conexões desconectadas".
  const connectionDisconnected = conversation.whatsappConnectionStatus !== "CONNECTED";
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  // "Responder" sends to the customer; "Nota interna" only saves a note the team sees.
  const [composerModeChoice, setComposerMode] = useState<"reply" | "note">("reply");
  const composerMode = lockedByIntervention ? "note" : composerModeChoice;
  const [noteText, setNoteText] = useState("");
  const composerRef = useRef<ComposerHandle>(null);
  // Whether a file is currently being dragged over this conversation, to
  // show the "solte para anexar" overlay — see PROMPT: "podendo também
  // arrastar de uma pasta para dentro da conversa, igual ao WhatsApp Web".
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  // dragenter/dragleave fire on every child element the pointer crosses, not
  // just on entering/leaving the outer container — a plain boolean flips on
  // and off as the drag moves over child elements, making the overlay
  // flicker. A depth counter (incremented on enter, decremented on leave,
  // "dragging" only while > 0) is the standard fix.
  const dragDepthRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Wraps just the message bubbles (not the scroll container itself, whose
  // own box size is fixed by the flex layout and wouldn't report content
  // growth) — observed below so ANY change to its height re-triggers the
  // stick-to-bottom check, not just a new message arriving.
  const contentRef = useRef<HTMLDivElement>(null);
  const { jumpToMessage, flashedId } = useJumpToMessage(contentRef);
  // Updated live on scroll, not recomputed after each render — checking
  // scroll position only after new (taller) content has already painted
  // would misjudge "was near the bottom" by however tall the new message
  // happens to be.
  const nearBottomRef = useRef(true);
  // Tracks which conversation is current so a loadOlder() fetch that's
  // still in flight when the agent switches to a different conversation
  // (now much more likely, since history now loads continuously right
  // after opening one) can recognize it's stale and discard its result
  // instead of injecting the wrong conversation's messages.
  const activeConversationId = useRef(conversation.id);
  useEffect(() => {
    activeConversationId.current = conversation.id;
  }, [conversation.id]);

  // In-conversation search — see PROMPT: lupa para pesquisar dentro da
  // conversa. Purely client-side, over whatever history is already loaded
  // (the effect below auto-loads all of it right after opening a
  // conversation, so by the time an agent deliberately opens search it's
  // realistically already there).
  const [forwarding, setForwarding] = useState<MessageDTO | null>(null);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());

  const notesQuery = useQuery({
    queryKey: ["notes", conversation.id],
    queryFn: async () => (await api.get<ConversationNoteDTO[]>(`/conversations/${conversation.id}/notes`)).data,
  });
  const createNoteMutation = useMutation({
    mutationFn: (body: string) => api.post<ConversationNoteDTO>(`/conversations/${conversation.id}/notes`, { body }),
    onSuccess: () => {
      setNoteText("");
      queryClient.invalidateQueries({ queryKey: ["notes", conversation.id] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const messagesQuery = useQuery({
    queryKey: ["messages", conversation.id],
    queryFn: () => fetchMessages(conversation.id),
  });

  const markReadMutation = useMutation({
    // Only the assigned agent's own "read" marker — a manager intervening must not clear it for them.
    mutationFn: async () => {
      if (conversation.assignedAgentId === userId) await api.post(`/conversations/${conversation.id}/read`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mine"] }),
  });

  // On-demand backfill of messages older than whatever this app already has
  // for this contact — see PROMPT: "mensagens de antes de conectar o
  // WhatsApp". Fire-and-forget from the UI's point of view: any messages
  // WhatsApp actually has land later through the normal live-update path
  // (message:new -> this same ["messages", conversation.id] query
  // invalidates), same as a message arriving from anywhere else.
  const syncOlderHistoryMutation = useMutation({
    mutationFn: () => api.post(`/conversations/${conversation.id}/sync-older-history`),
    onSuccess: () => toast.info("Buscando mensagens anteriores no WhatsApp..."),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  // Powers the "/" quick-reply picker in the Composer — scoped server-side
  // to this conversation's WhatsApp connection (see quick-replies.routes.ts),
  // so the same list an admin can also see doesn't leak across connections.
  const quickRepliesQuery = useQuery({
    queryKey: ["quick-replies", "conversation", conversation.id],
    queryFn: async () => (await api.get<QuickReplyDTO[]>(`/quick-replies/conversation/${conversation.id}`)).data,
    staleTime: 60_000,
  });

  // WhatsApp Oficial only: after 24h without a customer message, Meta accepts
  // nothing but an approved template — the composer swaps for that button.
  const templateContextQuery = useQuery({
    queryKey: ["template-context", conversation.id],
    queryFn: async () => (await api.get<TemplateContextDTO>(`/messages/conversations/${conversation.id}/template-context`)).data,
    enabled: conversation.channel === "WHATSAPP",
    refetchInterval: 60_000,
  });
  const templateContext = templateContextQuery.data;
  const windowClosed = Boolean(templateContext?.official && !templateContext.windowOpen);
  const [templateOpen, setTemplateOpen] = useState(false);

  useEffect(() => {
    nearBottomRef.current = true;
    setMessages([]);
    setCursor(undefined);
    // A search stays scoped to the conversation it was opened on — switching
    // away leaves it open otherwise, quietly searching the wrong messages.
    search.close();
    // Opening a conversation clears its unread badge.
    markReadMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // Tracked continuously (not just checked when a message arrives) so the
  // stick-to-bottom check below reflects where the agent actually left the
  // scroll position, not a snapshot taken after new content already
  // changed it.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      nearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    };
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // The single source of truth for "stay pinned to the bottom": fires on
  // ANY change to the message list's actual rendered height — a message
  // arriving or being sent, or (this is what previously broke it) an
  // image/video finishing an async load and growing taller than it was the
  // instant it was inserted. A one-shot scroll-to-bottom right after the
  // fetch landed always missed that last case, since attachments hadn't
  // finished loading yet — which is exactly what used to leave a
  // just-opened conversation stranded mid-history until the agent dragged
  // the scrollbar down themselves. Older-history prepends (loadOlder,
  // below) are deliberately not left to this: it only ever snaps to the
  // bottom, which would yank the agent back down while they're mid-history
  // — that case restores the agent's exact reading position instead.
  useEffect(() => {
    const content = contentRef.current;
    const container = scrollContainerRef.current;
    if (!content || !container) return;
    const observer = new ResizeObserver(() => {
      if (!nearBottomRef.current) return;
      container.scrollTop = container.scrollHeight - container.clientHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const search = useConversationSearch(messages, (id) => messageElementsRef.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" }));

  // While the conversation stays open, any further inbound message is
  // immediately marked read too — the agent is already looking at it live.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (payload: { conversationId: string }) => {
      if (payload.conversationId === conversation.id) markReadMutation.mutate();
    };
    socket.on("message:new", handler);
    return () => {
      socket.off("message:new", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // An admin deleted a message (from this device or another) — the
  // invalidate-and-refetch-page-1 pattern used for message:new/status would
  // never remove it here, since the merge above only upserts newer pages
  // into what's already loaded, so it's pruned directly from local state.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (payload: { conversationId: string; messageId: string }) => {
      if (payload.conversationId !== conversation.id) return;
      setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
    };
    socket.on("message:deleted", handler);
    return () => {
      socket.off("message:deleted", handler);
    };
  }, [conversation.id]);

  useEffect(() => {
    if (!messagesQuery.data) return;
    // A realtime event (new message, status change) invalidates this query
    // and it silently refetches page 1 (the most recent messages) in the
    // background. Replacing `messages` wholesale on every such refetch would
    // discard any older history the agent had already loaded by scrolling up
    // via loadOlder — so only replace outright on the very first load for
    // this conversation; afterwards, upsert page 1 into what's already there.
    setMessages((prev) => {
      if (prev.length === 0) return messagesQuery.data.items;
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of messagesQuery.data.items) byId.set(m.id, m);
      return Array.from(byId.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
    setCursor((prev) => prev ?? messagesQuery.data.nextCursor ?? undefined);
    // No manual scroll handling here — the ResizeObserver above reacts to
    // the resulting height change (new message, first load, or attachments
    // rendering in) and snaps to the bottom itself whenever the agent was
    // already there.
  }, [messagesQuery.data]);

  async function loadOlder() {
    if (!cursor) return;
    const requestedFor = conversation.id;
    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const prevScrollTop = container?.scrollTop ?? 0;
    const page = await fetchMessages(conversation.id, cursor);
    if (activeConversationId.current !== requestedFor) return; // switched conversations mid-fetch
    setMessages((prev) => [...page.items, ...prev]);
    setCursor(page.nextCursor ?? undefined);
    // Prepending older messages above what's already rendered must not
    // visibly move whatever the agent is currently looking at — restore
    // their exact scroll position relative to the content once the new
    // (taller) content has painted.
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
    });
  }

  // Automatically keeps paging through history until it's all loaded —
  // see PROMPT: "trazer todo o histórico das conversas quando é aberta".
  // Each loadOlder() call advances `cursor`, which re-triggers this same
  // effect, chaining through every page; it stops on its own the moment
  // cursor comes back undefined (no more history). Paced with a short
  // delay between pages, rather than firing every request back-to-back —
  // a very long conversation could otherwise mean dozens of requests
  // bursting in the same instant against the single API process that is
  // also running the live WhatsApp connection.
  // While the agent is searching, older pages load without the pacing delay
  // so the search reaches messages that weren't on screen yet as fast as possible.
  const searching = search.searching;
  useEffect(() => {
    if (!cursor) return;
    const timer = setTimeout(() => loadOlder(), searching ? 0 : 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, searching]);

  const sendTextMutation = useMutation({
    mutationFn: (input: { body: string; replyToMessageId?: string }) =>
      api.post(`/messages/conversations/${conversation.id}/text`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const sendFileMutation = useMutation({
    mutationFn: async ({ file, caption }: { file: File; caption?: string }) => {
      const form = new FormData();
      form.append("file", file);
      if (caption) form.append("caption", caption);
      return api.post(`/messages/conversations/${conversation.id}/file`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const sendAudioMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post(`/messages/conversations/${conversation.id}/audio`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const sendLocationMutation = useMutation({
    mutationFn: (input: { latitude: number; longitude: number }) =>
      api.post(`/messages/conversations/${conversation.id}/location`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const reactMutation = useMutation({
    mutationFn: (input: { messageId: string; emoji: string | null }) =>
      api.post(`/messages/${input.messageId}/reaction`, { emoji: input.emoji }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] }),
  });

  const deleteMessageMutation = useMutation({
    mutationFn: (messageId: string) => api.delete(`/messages/${messageId}`),
    onSuccess: (_res, messageId) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      toast.success("Mensagem excluída desta conversa.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const startConversationMutation = useMutation({
    mutationFn: (input: { phone: string; name: string }) =>
      api.post<ConversationListItemDTO>("/conversations/start", {
        connectionId: conversation.whatsappConnectionId,
        phone: input.phone,
        name: input.name,
      }),
    onSuccess: (res) => {
      toast.success("Conversa iniciada.");
      onConversationStarted?.(res.data);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const transferMutation = useMutation({
    mutationFn: (input: { toAgentId: string; note: string }) =>
      api.post(`/conversations/${conversation.id}/transfer`, input),
    onSuccess: () => {
      toast.success("Conversa transferida com sucesso.");
      onClosed();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const closeMutation = useMutation({
    mutationFn: () => api.post(`/conversations/${conversation.id}/close`),
    onSuccess: () => {
      toastWithUndo("Atendimento encerrado.", conversation.id, queryClient);
      queryClient.invalidateQueries({ queryKey: ["my-day"] });
      onClosed();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const closeNoReturnMutation = useMutation({
    mutationFn: () => api.post(`/conversations/${conversation.id}/close-no-return`),
    onSuccess: () => {
      toast.success("Encerrado por falta de retorno. O cliente recebeu a mensagem, sem pesquisa.");
      queryClient.invalidateQueries({ queryKey: ["my-day"] });
      onClosed();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const noReturnSettings = useNoReturnSettings();
  const holdMutation = useNoReturnHold(conversation.id);

  const displayName = contactDisplayName(conversation.contact, conversation.channel);

  // Atendimento's own helpers (not in Gestão's intervention panel): pin, "lembrar de retornar", "agendar envio".
  const agentTools = !headerActions;
  // With the client panel open the chat column is narrow — the header's buttons go icon-only until there's room.
  const actionLabelClass = clientPanelOpen ? "hidden 2xl:inline" : "hidden sm:inline";
  const customerTyping = useCustomerTyping(conversation.id);
  const extras = useAgentExtras().data;
  const pinned = Boolean(extras?.pinnedConversationIds.includes(conversation.id));
  const reminder = extras?.reminders.find((r) => r.conversationId === conversation.id) ?? null;
  const scheduled = extras?.scheduledMessages.filter((m) => m.conversationId === conversation.id) ?? [];
  const [reminderOpen, setReminderOpen] = useState(false);
  const invalidateExtras = () => queryClient.invalidateQueries({ queryKey: ["agent-extras"] });
  // Scheduling or canceling pauses/restarts the "falta de retorno" close shown on the conversation itself.
  const invalidateScheduled = () => {
    invalidateExtras();
    queryClient.invalidateQueries({ queryKey: ["mine"] });
  };
  const pinMutation = useMutation({
    mutationFn: (next: boolean) => api.put(`/agent-tools/pins/${conversation.id}`, { pinned: next }),
    onSuccess: (_res, next) => {
      invalidateExtras();
      toast.success(next ? "Conversa fixada no topo." : "Conversa desafixada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const reminderMutation = useMutation({
    mutationFn: (input: { remindAt: Date; note: string }) =>
      api.post("/agent-tools/reminders", { conversationId: conversation.id, remindAt: input.remindAt.toISOString(), note: input.note || null }),
    onSuccess: (_res, input) => {
      invalidateExtras();
      setReminderOpen(false);
      toast.success(`Vamos te lembrar às ${format(input.remindAt, "HH:mm")}.`);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const deleteReminderMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/agent-tools/reminders/${id}`),
    onSuccess: invalidateExtras,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const cancelScheduledMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/agent-tools/scheduled-messages/${id}`),
    onSuccess: () => {
      invalidateScheduled();
      toast.success("Envio agendado cancelado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  // Keyboard shortcuts for the open chat (the list's own — Alt+↓/↑, Alt+A, ? — live in AtendimentoPage).
  useEffect(() => {
    if (!agentTools) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (e.key === "/" && !typing && !e.altKey && !e.ctrlKey && !e.metaKey && !lockedByIntervention) {
        e.preventDefault();
        setComposerMode("reply");
        composerRef.current?.focus("/");
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "KeyN") {
        e.preventDefault();
        setComposerMode((m) => (m === "note" ? "reply" : "note"));
      } else if (e.code === "KeyT" && canTransfer) {
        e.preventDefault();
        setTransferOpen(true);
      } else if (e.code === "KeyE" && canClose) {
        e.preventDefault();
        setCloseConfirmOpen(true);
      } else if (e.code === "KeyL") {
        e.preventDefault();
        setReminderOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [agentTools, canTransfer, canClose, lockedByIntervention]);

  const messageById = new Map(messages.map((m) => [m.id, m]));

  // A dragged file (or several) can be dropped anywhere over the
  // conversation — the whole message list too, not just the composer bar —
  // same as WhatsApp Web. Text/link drags (e.g. dragging a URL from the
  // address bar) carry no File objects, so those are silently ignored
  // rather than opening an empty attach preview.
  function handleDragEnter(e: React.DragEvent) {
    if (connectionDisconnected) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) setIsDraggingFile(true);
  }

  function handleDragOver(e: React.DragEvent) {
    // Required for onDrop to ever fire at all — browsers reject a drop by
    // default unless dragover explicitly opts in.
    if (connectionDisconnected) return;
    e.preventDefault();
  }

  function handleDragLeave(e: React.DragEvent) {
    if (connectionDisconnected) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    if (connectionDisconnected) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) composerRef.current?.addFiles(files);
  }

  // The thread as one chronological list — messages, internal notes and the
  // transfer note — which TimelineByDay then splits by day.
  // The transfer note renders once, right between the last message sent
  // before the transfer and the first one after it — not as a static banner
  // above the whole thread. See TransferNoteCard.
  const transferAt = conversation.transfer?.note ? new Date(conversation.transfer.at).getTime() : null;
  let noteInserted = false;
  // Internal notes sit in the timeline right where they were written.
  const pendingNotes = [...(notesQuery.data ?? [])];
  const takeNotesUpTo = (at: number) => {
    const due: ConversationNoteDTO[] = [];
    while (pendingNotes.length && new Date(pendingNotes[0].createdAt).getTime() <= at) due.push(pendingNotes.shift()!);
    return due;
  };
  const timeline: TimelineEntry[] = [];
  const addNote = (note: ConversationNoteDTO) =>
    timeline.push({ key: `note-${note.id}`, at: new Date(note.createdAt).getTime(), node: <InternalNoteCard note={note} /> });
  const addTransferNote = () =>
    timeline.push({ key: "transfer-note", at: new Date(conversation.transfer!.at).getTime(), node: <TransferNoteCard transfer={conversation.transfer!} /> });
  for (const message of messages) {
    const at = new Date(message.createdAt).getTime();
    const insertNoteHere = transferAt !== null && !noteInserted && at >= transferAt;
    if (insertNoteHere) noteInserted = true;
    takeNotesUpTo(at).forEach(addNote);
    if (insertNoteHere) addTransferNote();
    timeline.push({
      key: message.id,
      at,
      node: (
        <div
          data-message-id={message.id}
          ref={(el) => {
            if (el) messageElementsRef.current.set(message.id, el);
            else messageElementsRef.current.delete(message.id);
          }}
        >
          <MessageBubble
            message={message}
            repliedMessage={message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined}
            onJumpToMessage={jumpToMessage}
            onReply={setReplyTo}
            onReact={(m, emoji) => reactMutation.mutate({ messageId: m.id, emoji })}
            canDelete={isAdmin}
            onDelete={(m) => deleteMessageMutation.mutate(m.id)}
            onForward={setForwarding}
            onStartConversation={onConversationStarted ? (phone, name) => startConversationMutation.mutate({ phone, name }) : undefined}
            highlighted={flashedId === message.id || search.currentId === message.id}
          />
        </div>
      ),
    });
  }
  // No message on/after the transfer yet (nobody's replied since) — the note still belongs at the end, not nowhere.
  if (transferAt !== null && !noteInserted) addTransferNote();
  pendingNotes.forEach(addNote);

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingFile && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-2 rounded-card border-2 border-dashed border-primary bg-surface px-8 py-6 shadow-elevated">
            <Paperclip className="h-8 w-8 text-primary" />
            <p className="text-sm font-medium text-primary">Solte os arquivos aqui para anexar</p>
          </div>
        </div>
      )}
      {/* On a phone the actions go to a second row, right-aligned, so the name and phone get the whole first row. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-2 py-3 sm:flex-nowrap sm:px-4">
        <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto sm:gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="focus-ring shrink-0 rounded-full p-1.5 text-muted hover:bg-surface-alt md:hidden"
              aria-label="Voltar para a lista de atendimentos"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <ContactPhoto photoUrl={conversation.contact.photoUrl} name={displayName} phone={conversation.contact.phone}>
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-surface-alt text-sm font-semibold text-muted">
              {conversation.contact.photoUrl ? (
                <img src={conversation.contact.photoUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">{displayName.slice(0, 2).toUpperCase()}</div>
              )}
            </div>
          </ContactPhoto>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <span className="truncate">{displayName}</span>
              {pinned && <Pin className="h-3 w-3 shrink-0 text-primary" aria-label="Fixada" />}
            </p>
            {customerTyping ? (
              <p className={clsx("flex items-center gap-1 text-xs font-semibold italic", customerTyping.kind === "recording" ? "text-danger" : "text-success")}>
                {customerTyping.kind === "recording" && <Mic className="chat-pulse h-3 w-3 shrink-0" />}
                {customerTyping.text}
              </p>
            ) : conversation.contact.phone && (
              <p className="flex items-center gap-1 text-xs text-muted">
                <Phone className="h-3 w-3 shrink-0" /> <span className="truncate">{formatPhone(conversation.contact.phone)}</span>
              </p>
            )}
          </div>
          {conversation.transfer && (
            <span className="rounded-full bg-secondary/40 px-2 py-0.5 text-[11px] font-medium text-text">
              TRANSFERIDO por {conversation.transfer.fromAgentName}
            </span>
          )}
        </div>
        <div className="relative ms-auto flex shrink-0 gap-1.5 sm:gap-2">
          <ConversationSearchButton search={search} />
          {agentTools && (
            <button
              onClick={() => pinMutation.mutate(!pinned)}
              disabled={pinMutation.isPending}
              className={clsx(
                "focus-ring flex items-center rounded-card border p-1.5",
                pinned ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted hover:bg-surface-alt"
              )}
              aria-pressed={pinned}
              aria-label={pinned ? "Desafixar conversa" : "Fixar conversa no topo"}
              title={pinned ? "Desafixar conversa" : "Fixar conversa no topo"}
            >
              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </button>
          )}
          {agentTools && (
            <>
              <button
                onClick={() => setReminderOpen((o) => !o)}
                className={clsx(
                  "focus-ring flex items-center gap-1 rounded-card border p-1.5 text-xs font-medium",
                  reminder ? "border-warning/40 bg-warning-soft px-2 text-warning" : "border-border text-muted hover:bg-surface-alt"
                )}
                aria-label="Lembrar de retornar (Alt+L)"
                title="Lembrar de retornar (Alt+L)"
              >
                <AlarmClock className="h-3.5 w-3.5" />
                {reminder && <span className="hidden tabular-nums sm:inline">{reminder.firedAt ? "Agora" : format(new Date(reminder.remindAt), "HH:mm")}</span>}
              </button>
              {reminderOpen &&
                (reminder ? (
                  <div className="shadow-elevated absolute right-0 top-10 z-30 w-60 rounded-card border border-border bg-surface p-3 text-xs">
                    <p className="font-semibold">Lembrete de retorno</p>
                    <p className="mt-1 text-muted">
                      {reminder.firedAt ? "Já passou da hora de retornar." : `Para ${format(new Date(reminder.remindAt), "dd/MM 'às' HH:mm")}.`}
                    </p>
                    {reminder.note && <p className="mt-1 rounded bg-surface-alt px-2 py-1">{reminder.note}</p>}
                    <div className="mt-3 flex justify-end gap-2">
                      <button onClick={() => setReminderOpen(false)} className="focus-ring rounded-lg border border-border px-3 py-1.5 hover:bg-surface-alt">
                        Fechar
                      </button>
                      <button
                        onClick={() => {
                          deleteReminderMutation.mutate(reminder.id);
                          setReminderOpen(false);
                        }}
                        className="focus-ring rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-fg"
                      >
                        {reminder.firedAt ? "Concluir" : "Remover"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <WhenPicker
                    title="Lembrar de retornar"
                    confirmLabel="Lembrar"
                    withNote
                    busy={reminderMutation.isPending}
                    className="right-0 top-10"
                    onConfirm={(remindAt, note) => reminderMutation.mutate({ remindAt, note })}
                    onClose={() => setReminderOpen(false)}
                  />
                ))}
            </>
          )}
          {headerActions}
          {canTransfer && (
            <button
              onClick={() => setTransferOpen(true)}
              title="Transferir (Alt+T)"
              className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-2 py-1.5 text-xs font-medium hover:bg-surface-alt sm:px-3"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" /> <span className={actionLabelClass}>Transferir</span>
            </button>
          )}
          {canClose && noReturnSettings?.enabled && (
            <NoReturnStatus conversation={conversation} onHold={(hold) => holdMutation.mutate(hold)} pending={holdMutation.isPending} labelClassName={actionLabelClass} />
          )}
          {canClose && (
            <button
              onClick={() => setCloseConfirmOpen(true)}
              title="Encerrar (Alt+E)"
              className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-2 py-1.5 text-xs font-semibold text-primary-fg hover:opacity-90 sm:px-3"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> <span className={actionLabelClass}>Encerrar</span>
            </button>
          )}
          {onToggleClientPanel && (
            <button
              onClick={onToggleClientPanel}
              className={clsx(
                "focus-ring flex items-center rounded-card border p-1.5",
                clientPanelOpen ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted hover:bg-surface-alt"
              )}
              aria-pressed={clientPanelOpen}
              aria-label={clientPanelOpen ? "Recolher painel do cliente" : "Mostrar painel do cliente"}
              title={clientPanelOpen ? "Recolher painel do cliente" : "Mostrar painel do cliente"}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <ConversationSearchBar search={search} loadingOlder={Boolean(cursor)} />

      <PinnedContactNote conversationId={conversation.id} />

      <div ref={scrollContainerRef} className="chat-wallpaper flex-1 overflow-y-auto px-4 py-4">
        {cursor && (
          <div className="text-center">
            <p className="text-xs text-muted">Carregando histórico...</p>
          </div>
        )}
        {/* Only once this app's own local pagination is exhausted (no more
            `cursor`) does it make sense to ask WhatsApp itself for whatever
            came before that — see syncOlderHistoryMutation above. */}
        {!cursor && messages.length > 0 && !connectionDisconnected && (
          <div className="mb-3 text-center">
            <button
              onClick={() => syncOlderHistoryMutation.mutate()}
              disabled={syncOlderHistoryMutation.isPending}
              className="focus-ring text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {syncOlderHistoryMutation.isPending ? "Buscando..." : "Buscar mensagens anteriores no WhatsApp"}
            </button>
          </div>
        )}
        <div ref={contentRef} className="space-y-3">
          <TimelineByDay entries={timeline} />
          {/* Like WhatsApp: the customer's "digitando…" / "gravando áudio…" as a bubble at the end of the conversation. */}
          {customerTyping && (
            <div className="flex justify-start" aria-live="polite">
              <span className={clsx("chat-pop inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-surface px-3 py-2.5 shadow-sm", customerTyping.kind === "recording" && "text-xs font-bold text-danger")}>
                {customerTyping.kind === "recording" ? (
                  <>
                    <Mic className="chat-pulse h-3.5 w-3.5" /> gravando áudio
                  </>
                ) : (
                  [0, 1, 2].map((d) => <span key={d} className="chat-typing-dot block h-1.5 w-1.5 rounded-full bg-muted" />)
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {connectionDisconnected && (
        <div className="mx-4 mb-2 rounded-card bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
          Esta conexão de WhatsApp está desconectada — não é possível enviar mensagens até que ela seja reconectada.
        </div>
      )}

      {conversation.startedOnDevice && conversation.status !== "HANDLED_EXTERNALLY" && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-card border border-border bg-surface-alt px-3 py-2 text-xs text-muted">
          <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong className="text-[var(--color-text)]">Conversa iniciada pelo celular</strong> — o cliente já estava sendo atendido, por isso a mensagem
            de aceite não foi enviada. Continue de onde a conversa parou.
          </span>
        </div>
      )}

      {lockedByIntervention && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-card border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>{conversation.intervention?.name}</strong> está intervindo nesta conversa. Você acompanha em tempo real e pode deixar notas para ele, mas não
            pode responder ao cliente, transferir nem encerrar.
          </span>
        </div>
      )}

      {agentTools && scheduled.length > 0 && (
        <div className="space-y-1 border-t border-border bg-surface px-4 py-2">
          {scheduled.map((m) => (
            <div key={m.id} className="flex items-center gap-2 rounded-lg bg-info-soft px-2.5 py-1.5 text-xs text-info">
              <CalendarClock className="h-3.5 w-3.5 shrink-0" />
              <span className="shrink-0 font-semibold tabular-nums">Agendada {format(new Date(m.sendAt), "dd/MM 'às' HH:mm")}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">{m.body}</span>
              <button
                onClick={() => cancelScheduledMutation.mutate(m.id)}
                disabled={cancelScheduledMutation.isPending}
                className="focus-ring shrink-0 rounded px-1.5 py-0.5 font-semibold hover:bg-surface"
              >
                Cancelar
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 border-t border-border bg-surface px-4 pt-2 text-xs" role="tablist" aria-label="Tipo de mensagem">
        {(
          [
            { value: "reply", label: "Responder" },
            { value: "note", label: "Nota interna" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.value}
            role="tab"
            aria-selected={composerMode === tab.value}
            disabled={lockedByIntervention && tab.value === "reply"}
            title={lockedByIntervention && tab.value === "reply" ? "Bloqueado durante a intervenção" : undefined}
            onClick={() => setComposerMode(tab.value)}
            className={clsx(
              "focus-ring -mb-px flex items-center gap-1 border-b-2 pb-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-50",
              composerMode === tab.value
                ? tab.value === "note"
                  ? "border-amber-500 text-amber-600 dark:text-amber-400"
                  : "border-primary text-primary"
                : "border-transparent text-muted hover:text-[var(--color-text)]"
            )}
          >
            {lockedByIntervention && tab.value === "reply" && <Lock className="h-3 w-3" />}
            {tab.label}
          </button>
        ))}
        {templateContext?.official && composerMode === "reply" && !windowClosed && (
          <button
            type="button"
            onClick={() => setTemplateOpen(true)}
            className="focus-ring -mb-px flex items-center gap-1 border-b-2 border-transparent pb-1.5 font-medium text-muted hover:text-[var(--color-text)]"
          >
            <FileText className="h-3.5 w-3.5" /> Template
          </button>
        )}
        {composerMode === "reply" && quickRepliesQuery.data && quickRepliesQuery.data.length > 0 && (
          <div className="ml-auto hidden min-w-0 items-center gap-1.5 overflow-hidden pb-1.5 lg:flex">
            {quickRepliesQuery.data.slice(0, 4).map((reply) => (
              <button
                key={reply.id}
                onClick={() => {
                  if (!connectionDisconnected) composerRef.current?.applyQuickReply(reply);
                }}
                className="focus-ring shrink-0 truncate rounded-full border border-border px-2 py-0.5 text-[11px] text-muted hover:border-primary/40 hover:text-[var(--color-text)]"
                title={reply.text}
              >
                <span className="font-mono text-primary">/{reply.shortcut}</span> {reply.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {composerMode === "note" ? (
        <form
          className="flex items-end gap-2 bg-surface px-3 pb-3 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (noteText.trim()) createNoteMutation.mutate(noteText.trim());
          }}
        >
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (noteText.trim()) createNoteMutation.mutate(noteText.trim());
              }
            }}
            rows={2}
            maxLength={2000}
            placeholder={lockedByIntervention ? `Escreva uma nota para ${conversation.intervention?.name} — o cliente não vê` : "Escreva uma nota para a equipe — o cliente não vê"}
            className="focus-ring min-h-[44px] flex-1 resize-none rounded-card border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 placeholder:text-amber-700/60 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
          />
          <button
            type="submit"
            disabled={!noteText.trim() || createNoteMutation.isPending}
            className="focus-ring flex h-10 shrink-0 items-center gap-1.5 rounded-card bg-amber-500 px-3 text-xs font-semibold text-white disabled:opacity-50"
          >
            <StickyNote className="h-4 w-4" /> {createNoteMutation.isPending ? "Salvando..." : "Salvar nota"}
          </button>
        </form>
      ) : windowClosed ? (
        <div className="flex flex-col gap-2 bg-surface px-4 pb-3 pt-2 sm:flex-row sm:items-center">
          <p className="flex-1 text-xs text-muted">
            Já se passaram 24 horas desde a última mensagem do cliente. Pela regra do WhatsApp Oficial, agora só é possível enviar um template aprovado. Quando o cliente responder, a conversa volta ao normal.
          </p>
          <button
            type="button"
            disabled={connectionDisconnected}
            onClick={() => setTemplateOpen(true)}
            className="focus-ring flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-fg disabled:opacity-50"
          >
            <FileText className="h-4 w-4" /> Enviar template
          </button>
        </div>
      ) : (
      <Composer
        ref={composerRef}
        conversationId={conversation.id}
        checkWriting
        onScheduleText={
          agentTools
            ? async (body, sendAt) => {
                try {
                  await api.post("/agent-tools/scheduled-messages", { conversationId: conversation.id, body, sendAt: sendAt.toISOString() });
                  invalidateScheduled();
                  toast.success(`Mensagem agendada para ${format(sendAt, "dd/MM 'às' HH:mm")}.`);
                } catch (err) {
                  toast.error(getApiErrorMessage(err));
                  throw err;
                }
              }
            : undefined
        }
        disabled={sendTextMutation.isPending || connectionDisconnected}
        quickReplies={quickRepliesQuery.data}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onPresence={(presence) => void api.post(`/conversations/${conversation.id}/presence`, { presence }).catch(() => undefined)}
        onSendText={async (text, replyToMessageId) => {
          await sendTextMutation.mutateAsync({ body: text, replyToMessageId });
        }}
        onSendFile={async (file, caption) => {
          await sendFileMutation.mutateAsync({ file, caption });
        }}
        onSendAudio={async (file) => {
          await sendAudioMutation.mutateAsync(file);
        }}
        onSendLocation={async (lat, lng) => {
          await sendLocationMutation.mutateAsync({ latitude: lat, longitude: lng });
        }}
      />
      )}

      {templateOpen && templateContext && (
        <SendTemplateModal
          conversationId={conversation.id}
          templates={templateContext.templates}
          onClose={() => setTemplateOpen(false)}
          onSent={() => {
            setTemplateOpen(false);
            queryClient.invalidateQueries({ queryKey: ["template-context", conversation.id] });
          }}
        />
      )}

      {/* The attendant's warning — someone only watching (Gestão) must not use up their once-per-conversation popup. */}
      {conversation.assignedAgentId === userId && <SuspensionWarningModal conversationId={conversation.id} />}
      {conversation.assignedAgentId === userId && (
        <BirthdayModal
          conversationId={conversation.id}
          onSend={async (text, file) => {
            if (file) await sendFileMutation.mutateAsync({ file, caption: text });
            else await sendTextMutation.mutateAsync({ body: text });
          }}
          onEdit={(text, file) => {
            if (file) composerRef.current?.addFiles([file]);
            composerRef.current?.applyQuickReply({ id: "", name: "Aniversário", shortcut: "", text });
          }}
        />
      )}

      {forwarding && <ForwardModal message={forwarding} currentConversationId={conversation.id} onClose={() => setForwarding(null)} />}

      {transferOpen && (
        <TransferModal
          onClose={() => setTransferOpen(false)}
          onConfirm={async (agentId, note) => {
            await transferMutation.mutateAsync({ toAgentId: agentId, note });
          }}
        />
      )}

      {closeConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Encerrar atendimento?</h2>
            <p className="mt-2 text-sm text-muted">
              Esta ação encerra a conversa com {displayName}. O histórico permanece disponível na gestão.
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setCloseConfirmOpen(false)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => closeMutation.mutate()}
                disabled={closeMutation.isPending}
                className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
              >
                {closeMutation.isPending ? "Encerrando..." : "Encerrar"}
              </button>
            </div>
            <button
              onClick={() => closeNoReturnMutation.mutate()}
              disabled={closeNoReturnMutation.isPending || conversation.scheduledMessagePending}
              title={conversation.scheduledMessagePending ? "Há mensagem agendada: envie ou cancele o agendamento para encerrar por falta de retorno" : undefined}
              className="focus-ring mt-2 flex w-full items-center justify-center gap-1.5 rounded-card border border-border py-2 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
            >
              <MessageSquareOff className="h-4 w-4" />
              {closeNoReturnMutation.isPending ? "Encerrando..." : "Encerrar por falta de retorno"}
            </button>
            <p className="mt-1 text-center text-[11px] text-muted">
              {conversation.scheduledMessagePending
                ? "Bloqueado: esta conversa tem mensagem agendada. Envie ou cancele o agendamento primeiro."
                : noReturnSettings?.sendSurvey
                  ? "Envia a mensagem de falta de retorno e a pesquisa de satisfação, sem o nome do atendente."
                  : "Envia a mensagem de falta de retorno, sem pesquisa de satisfação."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Internal note in the timeline — yellow and dashed so it never reads as something the customer saw. */
export function InternalNoteCard({ note }: { note: ConversationNoteDTO }) {
  return (
    <div className="mx-auto max-w-[85%] rounded-card border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
      <p className="mb-0.5 flex items-center gap-1 font-semibold">
        <StickyNote className="h-3 w-3" /> Nota interna · {note.authorName}
        <span className="ml-auto font-normal opacity-70">{new Date(note.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
      </p>
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
    </div>
  );
}
