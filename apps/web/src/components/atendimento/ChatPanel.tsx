import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRightLeft, CheckCircle2, ChevronDown, ChevronUp, Paperclip, Phone, Search, X as CloseIcon } from "lucide-react";
import { PERMISSION, type ConversationListItemDTO, type MessageDTO, type PaginatedResult, type QuickReplyDTO } from "@whatsunivida/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { getSocket } from "../../lib/socket";
import { useAuthStore } from "../../store/auth-store";
import { MessageBubble } from "./MessageBubble";
import { Composer, type ComposerHandle } from "./Composer";
import { TransferModal } from "./TransferModal";

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
}: {
  conversation: ConversationListItemDTO;
  onClosed: () => void;
  onBack?: () => void;
  /** A new conversation was started from a vCard received in this chat (see MessageBubble's "Iniciar conversa") — the caller decides what to do with it (open it, refresh lists...). */
  onConversationStarted?: (conversation: ConversationListItemDTO) => void;
}) {
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");
  const canTransfer = permissions?.[PERMISSION.ATENDIMENTO_TRANSFERIR];
  const canClose = permissions?.[PERMISSION.ATENDIMENTO_ENCERRAR];
  // A disconnected connection can't actually deliver anything — see PROMPT:
  // "não permitindo enviar mensagens... de conexões desconectadas".
  const connectionDisconnected = conversation.whatsappConnectionStatus !== "CONNECTED";
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());

  const messagesQuery = useQuery({
    queryKey: ["messages", conversation.id],
    queryFn: () => fetchMessages(conversation.id),
  });

  const markReadMutation = useMutation({
    mutationFn: () => api.post(`/conversations/${conversation.id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mine"] }),
  });

  // Powers the "/" quick-reply picker in the Composer — scoped server-side
  // to this conversation's WhatsApp connection (see quick-replies.routes.ts),
  // so the same list an admin can also see doesn't leak across connections.
  const quickRepliesQuery = useQuery({
    queryKey: ["quick-replies", "conversation", conversation.id],
    queryFn: async () => (await api.get<QuickReplyDTO[]>(`/quick-replies/conversation/${conversation.id}`)).data,
    staleTime: 60_000,
  });

  useEffect(() => {
    nearBottomRef.current = true;
    setMessages([]);
    setCursor(undefined);
    // A search stays scoped to the conversation it was opened on — switching
    // away leaves it open otherwise, quietly searching the wrong messages.
    setSearchOpen(false);
    setSearchQuery("");
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

  const searchMatches = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return [];
    return messages.filter((m) => m.body?.toLowerCase().includes(normalized));
  }, [messages, searchQuery]);

  // A fresh search starts at the most recent match — the one an agent is
  // most likely looking for — rather than the oldest. Keyed off the query
  // (not searchMatches itself) so it only jumps on a deliberate new search,
  // not every time the underlying message list changes mid-search.
  useEffect(() => {
    setMatchIndex(Math.max(0, searchMatches.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  useEffect(() => {
    if (!searchOpen) return;
    const current = searchMatches[matchIndex];
    if (!current) return;
    messageElementsRef.current.get(current.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [searchOpen, searchMatches, matchIndex]);

  function goToMatch(direction: 1 | -1) {
    if (searchMatches.length === 0) return;
    setMatchIndex((i) => (i + direction + searchMatches.length) % searchMatches.length);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setMatchIndex(0);
  }

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
  useEffect(() => {
    if (!cursor) return;
    const timer = setTimeout(() => loadOlder(), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

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
      toast.success("Atendimento encerrado.");
      onClosed();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const displayName = conversation.contact.name || conversation.contact.phone;
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
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-2 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="focus-ring shrink-0 rounded-full p-1.5 text-muted hover:bg-surface-alt md:hidden"
              aria-label="Voltar para a lista de atendimentos"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-surface-alt text-sm font-semibold text-muted">
            {conversation.contact.photoUrl ? (
              <img src={conversation.contact.photoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center">{displayName.slice(0, 2).toUpperCase()}</div>
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{displayName}</p>
            <p className="flex items-center gap-1 text-xs text-muted">
              <Phone className="h-3 w-3" /> {conversation.contact.phone}
            </p>
          </div>
          {conversation.transfer && (
            <span className="rounded-full bg-secondary/40 px-2 py-0.5 text-[11px] font-medium text-secondary-fg">
              TRANSFERIDO por {conversation.transfer.fromAgentName}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="focus-ring flex items-center gap-1.5 rounded-card border border-border p-1.5 text-muted hover:bg-surface-alt sm:px-2"
            aria-label="Pesquisar nesta conversa"
            title="Pesquisar nesta conversa"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          {canTransfer && (
            <button
              onClick={() => setTransferOpen(true)}
              className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-2 py-1.5 text-xs font-medium hover:bg-surface-alt sm:px-3"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Transferir</span>
            </button>
          )}
          {canClose && (
            <button
              onClick={() => setCloseConfirmOpen(true)}
              className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-2 py-1.5 text-xs font-medium text-primary-fg hover:opacity-90 sm:px-3"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Encerrar</span>
            </button>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goToMatch(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") closeSearch();
            }}
            placeholder="Pesquisar nesta conversa"
            className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
          />
          <span className="shrink-0 text-xs text-muted">
            {searchQuery.trim() ? (searchMatches.length > 0 ? `${matchIndex + 1}/${searchMatches.length}` : "0/0") : ""}
          </span>
          <button
            onClick={() => goToMatch(-1)}
            disabled={searchMatches.length === 0}
            className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface-alt disabled:opacity-40"
            aria-label="Resultado anterior"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            onClick={() => goToMatch(1)}
            disabled={searchMatches.length === 0}
            className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface-alt disabled:opacity-40"
            aria-label="Próximo resultado"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button onClick={closeSearch} className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar pesquisa">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4">
        {cursor && (
          <div className="text-center">
            <p className="text-xs text-muted">Carregando histórico...</p>
          </div>
        )}
        <div ref={contentRef} className="space-y-3">
          {messages.map((message) => (
            <div
              key={message.id}
              ref={(el) => {
                if (el) messageElementsRef.current.set(message.id, el);
                else messageElementsRef.current.delete(message.id);
              }}
            >
              <MessageBubble
                message={message}
                repliedMessage={message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined}
                onReply={setReplyTo}
                onReact={(m, emoji) => reactMutation.mutate({ messageId: m.id, emoji })}
                canDelete={isAdmin}
                onDelete={(m) => deleteMessageMutation.mutate(m.id)}
                onStartConversation={onConversationStarted ? (phone, name) => startConversationMutation.mutate({ phone, name }) : undefined}
                highlighted={searchOpen && searchMatches[matchIndex]?.id === message.id}
              />
            </div>
          ))}
        </div>
      </div>

      {connectionDisconnected && (
        <div className="mx-4 mb-2 rounded-card bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
          Esta conexão de WhatsApp está desconectada — não é possível enviar mensagens até que ela seja reconectada.
        </div>
      )}

      <Composer
        ref={composerRef}
        disabled={sendTextMutation.isPending || connectionDisconnected}
        quickReplies={quickRepliesQuery.data}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
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
          </div>
        </div>
      )}
    </div>
  );
}
