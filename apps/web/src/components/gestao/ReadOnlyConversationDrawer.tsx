import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Phone } from "lucide-react";
import type { ContactPanelDTO, ConversationListItemDTO, ConversationNoteDTO, MessageDTO, PaginatedResult } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";
import { getSocket } from "../../lib/socket";
import { useJumpToMessage } from "../../hooks/useJumpToMessage";
import { MessageBubble } from "../atendimento/MessageBubble";
import { TransferNoteCard } from "../atendimento/TransferNoteCard";
import { TimelineByDay, type TimelineEntry } from "../atendimento/TimelineByDay";
import { InternalNoteCard } from "../atendimento/ChatPanel";
import { TagChip } from "../../pages/contatos/contactFormat";
import { ContactPhoto } from "../common/ContactPhoto";
import { ConversationSearchBar, ConversationSearchButton, useConversationSearch } from "../atendimento/ConversationSearch";

async function fetchMessages(conversationId: string, cursor?: string) {
  const res = await api.get<PaginatedResult<MessageDTO>>(`/messages/conversations/${conversationId}`, {
    params: { cursor, limit: 100 },
  });
  return res.data;
}

export function ReadOnlyConversationDrawer({
  conversation,
  onClose,
  // "drawer" (default): Gestão's own right-side overlay over the whole
  // screen. "inline": fills its parent's slot in-flow instead — used by
  // Atendimento's Transferidas tab, which reuses the main conversation
  // column's layout (like ChatPanel) rather than a floating panel. See
  // PROMPT: "a tela de visualizar as conversas em Transf, deve abrir
  // normalmente... atualmente está abrindo igual a gestão, em uma [gaveta]
  // lateral direita."
  variant = "drawer",
}: {
  conversation: ConversationListItemDTO;
  onClose: () => void;
  variant?: "drawer" | "inline";
}) {
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Wraps just the message bubbles — observed below so ANY change to its
  // height (a page loading in, or an image/video finishing an async load)
  // re-snaps to the bottom, not just the one-shot check the messages array
  // used to get. See ChatPanel's own copy of this same fix for the full
  // explanation: a scroll-to-bottom taken right when messages first render
  // always missed attachments that hadn't finished loading yet, which used
  // to leave a just-opened conversation stranded mid-history.
  const contentRef = useRef<HTMLDivElement>(null);
  // Only snap to the bottom while the gestor is actually near it — without
  // this, the ResizeObserver below would yank them back down every time an
  // older page loads in while they're scrolled up reading history, fighting
  // the loadOlder-style scroll-position restore in the [cursor] effect.
  const nearBottomRef = useRef(true);
  const { jumpToMessage, flashedId } = useJumpToMessage(contentRef);
  // The magnifier, same as Atendimento's: the gestor finds a word in the conversation without scrolling it all.
  const search = useConversationSearch(messages, (id) =>
    contentRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })
  );

  const queryClient = useQueryClient();

  const messagesQuery = useQuery({
    queryKey: ["oversight-messages", conversation.id],
    queryFn: () => fetchMessages(conversation.id),
  });
  // Internal notes and the customer's tags — read-only here, same data the agent sees.
  const notesQuery = useQuery({
    queryKey: ["notes", conversation.id],
    queryFn: async () => (await api.get<ConversationNoteDTO[]>(`/conversations/${conversation.id}/notes`)).data,
  });
  const panelQuery = useQuery({
    queryKey: ["contact-panel", conversation.id],
    queryFn: async () => (await api.get<ContactPanelDTO>(`/conversations/${conversation.id}/contact-panel`)).data,
  });

  // Upserts page 1 into whatever's already loaded instead of replacing it
  // outright — same merge ChatPanel uses for its own live updates, needed
  // here for the same reason: a realtime event below invalidates this
  // query and refetches page 1 in the background, and a plain "replace
  // wholesale" would silently drop any older history already scrolled
  // into view via loadOlder.
  useEffect(() => {
    if (!messagesQuery.data) return;
    setMessages((prev) => {
      if (prev.length === 0) return messagesQuery.data.items;
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of messagesQuery.data.items) byId.set(m.id, m);
      return Array.from(byId.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
    setCursor((prev) => prev ?? messagesQuery.data.nextCursor ?? undefined);
  }, [messagesQuery.data]);

  // Joins this conversation's own socket room so new messages/status
  // changes reach this drawer live — scoped independently of ChatPanel's
  // own room subscription, since this can be watching a completely
  // different conversation than whatever's open elsewhere for this same
  // user. See PROMPT: "possa abrir a conversa para acompanhar em tempo
  // real sem poder interferir".
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const join = () => socket.emit("conversation:join", conversation.id);
    join();
    socket.on("connect", join);
    const onLiveUpdate = (payload: { conversationId: string }) => {
      if (payload.conversationId !== conversation.id) return;
      queryClient.invalidateQueries({ queryKey: ["oversight-messages", conversation.id] });
      queryClient.invalidateQueries({ queryKey: ["notes", conversation.id] });
    };
    socket.on("message:new", onLiveUpdate);
    socket.on("message:status", onLiveUpdate);
    return () => {
      socket.off("connect", join);
      socket.off("message:new", onLiveUpdate);
      socket.off("message:status", onLiveUpdate);
      socket.emit("conversation:leave", conversation.id);
    };
  }, [conversation.id, queryClient]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      nearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    };
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

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

  // Automatically keeps paging through history until it's all loaded, same
  // as ChatPanel's own conversation view — see PROMPT: "trazer todo o
  // histórico das conversas quando é aberta". Paced with a short delay
  // between pages rather than firing every request back-to-back — a very
  // long conversation could otherwise mean dozens of requests bursting in
  // the same instant against the single API process that is also running
  // the live WhatsApp connection.
  useEffect(() => {
    if (!cursor) return;
    const timer = setTimeout(() => {
      const container = scrollContainerRef.current;
      const prevScrollHeight = container?.scrollHeight ?? 0;
      const prevScrollTop = container?.scrollTop ?? 0;
      fetchMessages(conversation.id, cursor).then((page) => {
        setMessages((prev) => [...page.items, ...prev]);
        setCursor(page.nextCursor ?? undefined);
        requestAnimationFrame(() => {
          if (!container) return;
          container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
        });
      });
    }, search.searching ? 0 : 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, conversation.id, search.searching]);

  const isLoading = messagesQuery.isLoading;
  const displayName = contactDisplayName(conversation.contact, conversation.channel);
  const messageById = new Map(messages.map((m) => [m.id, m]));

  // Same inline placement as ChatPanel — the transfer note sits between the
  // last message before it and the first one after, not as a static banner
  // above the whole thread. Internal notes sit in the timeline right where
  // they were written. TimelineByDay then splits the list by day.
  const transferAt = conversation.transfer?.note ? new Date(conversation.transfer.at).getTime() : null;
  let noteInserted = false;
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
  for (const m of messages) {
    const at = new Date(m.createdAt).getTime();
    const insertNoteHere = transferAt !== null && !noteInserted && at >= transferAt;
    if (insertNoteHere) noteInserted = true;
    takeNotesUpTo(at).forEach(addNote);
    if (insertNoteHere) addTransferNote();
    timeline.push({
      key: m.id,
      at,
      node: (
        <div data-message-id={m.id}>
          <MessageBubble
            message={m}
            readOnly
            highlighted={flashedId === m.id || search.currentId === m.id}
            onJumpToMessage={jumpToMessage}
            onReply={() => undefined}
            onReact={() => undefined}
            repliedMessage={m.replyToMessageId ? messageById.get(m.replyToMessageId) : undefined}
          />
        </div>
      ),
    });
  }
  if (transferAt !== null && !noteInserted) addTransferNote();
  pendingNotes.forEach(addNote);

  const content = (
    <div className={variant === "drawer" ? "flex h-full w-full max-w-lg flex-col bg-surface shadow-elevated" : "flex h-full w-full flex-col bg-surface"}>
        <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
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
              <p className="truncate text-sm font-semibold">{displayName}</p>
              <p className="flex items-center gap-1 text-xs text-muted">
                {conversation.contact.phone && (
                  <>
                    <Phone className="h-3 w-3" /> {conversation.contact.phone} ·{" "}
                  </>
                )}
                Atendente: {conversation.assignedAgentName ?? "-"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <ConversationSearchButton search={search} />
            <button onClick={onClose} className="focus-ring shrink-0 rounded-full p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <ConversationSearchBar search={search} loadingOlder={Boolean(cursor)} />

        {(panelQuery.data?.tags.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2" aria-label="Etiquetas do cliente">
            {panelQuery.data!.tags.map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </div>
        )}

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto bg-[var(--color-bg)] px-4 py-4">
          {(isLoading || cursor) && <p className="text-center text-sm text-muted">Carregando histórico...</p>}
          <div ref={contentRef} className="space-y-3">
            <TimelineByDay entries={timeline} />
          </div>
        </div>

        <div className="border-t border-border px-5 py-3 text-center text-xs text-muted">
          Modo de visualização — não é possível interagir nesta conversa.
        </div>
    </div>
  );

  if (variant === "inline") return content;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
      {/* Mirrors ChatPanel's own header/message-list styling so oversight
          shows a conversation exactly as it looks in Atendimento — just
          without the composer, since gestores only watch. */}
      {content}
    </div>
  );
}
