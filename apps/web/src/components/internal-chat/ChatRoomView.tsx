import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { format } from "date-fns";
import clsx from "clsx";
import { ArrowDown, ArrowLeft, Bell, BellOff, Eye, History, Pin, PinOff, Settings2, Star, Timer, Trash2, X, Zap } from "lucide-react";
import {
  chatDurationLabel,
  type ChatFormerMemberDTO,
  type ChatMemberDTO,
  type ChatMessageDTO,
  type ChatPinDTO,
  type ChatRoomDTO,
  type ChatRoomKind,
  type ConversationListItemDTO,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { dayLabel } from "../../lib/chatDays";
import { useAuthStore } from "../../store/auth-store";
import { typingLabel, useInternalChatStore } from "../../store/internal-chat-store";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { ChatConfirm, ChatDialog } from "./ChatDialogs";
import { GroupSettings } from "./GroupSettings";
import { AutoDeleteDialog } from "./AutoDeleteDialog";
import { MessageInfoPanel } from "./MessageInfoPanel";
import { PersonAvatar, RoomIcon } from "./ChatAvatar";

const GROUP_GAP_MS = 5 * 60_000;

/** What the room view needs, whether it's a member's room or Gestão's read-only one. */
export interface ChatRoomShape {
  id: string;
  kind: ChatRoomKind;
  name: string;
  icon: string | null;
  members: ChatMemberDTO[];
  pins: ChatPinDTO[];
  autoDeleteSeconds: number | null;
}

type Props =
  | { mode: "member"; room: ChatRoomDTO; onBack: () => void }
  | {
      mode: "oversight";
      room: ChatRoomShape & { formerMembers: ChatFormerMemberDTO[]; deletedAt: string | null; deletedByName: string | null };
      onBack: () => void;
    };

export function ChatRoomView(props: Props) {
  const { room, onBack, mode } = props;
  const member = mode === "member" ? props.room : null;
  const oversight = mode === "oversight";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const typingEntries = useInternalChatStore((s) => s.typing[room.id]);
  const focusMessageId = useInternalChatStore((s) => s.focusMessageId);
  const clearFocus = useInternalChatStore((s) => s.clearFocus);
  const setOpen = useInternalChatStore((s) => s.setOpen);
  const [, setTick] = useState(0);
  const [replyTo, setReplyTo] = useState<ChatMessageDTO | null>(null);
  const [editing, setEditing] = useState<ChatMessageDTO | null>(null);
  const [infoFor, setInfoFor] = useState<ChatMessageDTO | null>(null);
  const [pinFor, setPinFor] = useState<ChatMessageDTO | null>(null);
  const [deleteFor, setDeleteFor] = useState<ChatMessageDTO | null>(null);
  const [editsFor, setEditsFor] = useState<ChatMessageDTO | null>(null);
  const [dialog, setDialog] = useState<"settings" | "autodelete" | "mute" | "nudge" | null>(null);
  const [pinIndex, setPinIndex] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [dragging, setDragging] = useState(false);
  const allPeople = oversight ? [...room.members, ...props.room.formerMembers.map((f) => ({ userId: f.userId, name: f.name }))] : room.members;
  const [viewAs, setViewAs] = useState<string | null>(oversight ? (room.members[0]?.userId ?? null) : null);
  const viewerId = oversight ? viewAs : meId;
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const prevHeight = useRef<number | null>(null);
  const unreadAtOpen = useRef(member?.unreadCount ?? 0);

  const messagesKey = oversight ? ["internal-chat-oversight", room.id] : ["internal-chat", "messages", room.id];
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: messagesKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (await api.get<ChatMessageDTO[]>(oversight ? `/internal-chat/oversight/rooms/${room.id}/messages` : `/internal-chat/rooms/${room.id}/messages`, { params: pageParam ? { before: pageParam } : {} })).data,
    getNextPageParam: (last) => (last.length >= 50 ? last[0].createdAt : undefined),
  });
  const messages = useMemo(() => (data ? [...data.pages].reverse().flat() : []), [data]);

  // Temporary messages leave the screen the moment their clock runs out.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const next = messages.filter((m) => m.expiresAt && !m.oversight).map((m) => new Date(m.expiresAt!).getTime() - Date.now()).filter((ms) => ms > 0);
    if (!next.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...next) + 50);
    return () => clearTimeout(timer);
  }, [messages, now]);
  const shown = oversight ? messages : messages.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now);

  // Opening the room (and every new message while it's open) marks it as read — that's what turns the sender's ✓✓ colored.
  useEffect(() => {
    if (oversight) return;
    api
      .post(`/internal-chat/rooms/${room.id}/read`)
      .then(() => queryClient.invalidateQueries({ queryKey: ["internal-chat", "rooms"] }))
      .catch(() => undefined);
  }, [room.id, messages.length, queryClient, oversight]);

  // Stick to the bottom on new messages; keep the place when older ones are added on top.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [shown.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!typingEntries) return;
    const timer = setTimeout(() => setTick((t) => t + 1), 4_100);
    return () => clearTimeout(timer);
  }, [typingEntries]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (el.scrollTop < 120 && hasNextPage && !isFetchingNextPage) {
      prevHeight.current = el.scrollHeight;
      void fetchNextPage();
    }
  }

  async function jumpTo(messageId: string) {
    const find = () => document.getElementById(`chat-msg-${messageId}`);
    // An older message: load pages back until it shows up (or the conversation's start).
    for (let i = 0; !find() && i < 20; i++) {
      prevHeight.current = scrollRef.current?.scrollHeight ?? null;
      const result = await fetchNextPage();
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (!result.hasNextPage) break;
    }
    const el = find();
    if (!el) return toast.info("Essa mensagem não está mais disponível.");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlight(messageId);
    setTimeout(() => setHighlight(null), 1800);
  }

  useEffect(() => {
    if (focusMessageId && messages.length) {
      void jumpTo(focusMessageId);
      clearFocus();
    }
  }, [focusMessageId, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["internal-chat"] });
  const onError = (err: unknown) => toast.error(getApiErrorMessage(err));
  const reactMutation = useMutation({ mutationFn: ({ id, emoji }: { id: string; emoji: string | null }) => api.put(`/internal-chat/messages/${id}/reaction`, { emoji }), onSuccess: refresh, onError });
  const voteMutation = useMutation({ mutationFn: ({ pollId, optionIds }: { pollId: string; optionIds: string[] }) => api.put(`/internal-chat/polls/${pollId}/votes`, { optionIds }), onSuccess: refresh, onError });
  const deleteMutation = useMutation({ mutationFn: (id: string) => api.delete(`/internal-chat/messages/${id}`), onSuccess: () => (refresh(), setDeleteFor(null)), onError });
  const pinMutation = useMutation({
    mutationFn: ({ messageId, days }: { messageId: string; days: 1 | 7 | 30 | null }) => api.post(`/internal-chat/rooms/${room.id}/pins`, { messageId, days }),
    onSuccess: () => (refresh(), setPinFor(null)),
    onError,
  });
  const unpinMutation = useMutation({ mutationFn: (messageId: string) => api.delete(`/internal-chat/rooms/${room.id}/pins/${messageId}`), onSuccess: refresh, onError });
  const nudgeMutation = useMutation({
    mutationFn: (userId?: string) => api.post(`/internal-chat/rooms/${room.id}/nudge`, userId ? { userId } : {}),
    onSuccess: () => (refresh(), setDialog(null)),
    onError,
  });
  const favoriteMutation = useMutation({ mutationFn: (favorite: boolean) => api.put(`/internal-chat/rooms/${room.id}/favorite`, { favorite }), onSuccess: refresh, onError });
  const muteMutation = useMutation({ mutationFn: (until: string | null) => api.put(`/internal-chat/rooms/${room.id}/mute`, { until }), onSuccess: () => (refresh(), setDialog(null)), onError });

  const { data: myConversations } = useQuery({
    queryKey: ["mine"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/mine")).data,
    enabled: !oversight,
  });
  function openConversation(conversationId: string) {
    const mine = myConversations?.some((c) => c.id === conversationId) ?? true;
    setOpen(false);
    navigate(mine ? `/atendimento?open=${conversationId}` : `/gestao?open=${conversationId}`);
  }

  const typing = typingLabel(typingEntries ? Object.values(typingEntries) : undefined);
  const subtitle = (() => {
    if (typing) return typing.text;
    if (oversight) return `${room.members.length} integrantes`;
    if (room.kind === "DIRECT" && member?.peer) return member.peer.presence === "ONLINE" ? "online" : member.peer.presence === "AWAY" ? "ausente" : "offline";
    return `${room.members.length} integrantes · ${room.members.filter((m) => m.presence === "ONLINE").length} online`;
  })();

  const pins = room.pins;
  const pin = pins[pinIndex % Math.max(1, pins.length)];
  const firstUnreadIndex = unreadAtOpen.current > 0 ? Math.max(0, shown.length - unreadAtOpen.current) : -1;
  const peer = member?.peer ?? null;
  const deletedRoom = oversight ? props.room.deletedAt : null;

  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (oversight || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (oversight) return;
        e.preventDefault();
        setDragging(false);
        composerRef.current?.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3 py-2.5">
        <button onClick={onBack} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt md:hidden" aria-label="Voltar">
          <ArrowLeft className="h-4 w-4" />
        </button>
        {room.kind === "DIRECT" && peer ? (
          <PersonAvatar name={peer.name} photoUrl={peer.photoUrl} presence={peer.presence} id={peer.userId} />
        ) : room.kind === "DIRECT" ? (
          <span className="flex shrink-0 -space-x-2">
            {room.members.slice(0, 2).map((m) => (
              <PersonAvatar key={m.userId} name={m.name} photoUrl={m.photoUrl} id={m.userId} size="sm" />
            ))}
          </span>
        ) : (
          <RoomIcon kind={room.kind} icon={room.icon} seed={room.id} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{room.name}</p>
          <p className={clsx("truncate text-[11.5px]", typing ? (typing.kind === "recording" ? "font-semibold text-danger" : "font-semibold text-success") : "text-muted")}>{subtitle}</p>
        </div>
        {room.kind === "DIRECT" && room.autoDeleteSeconds && (
          <span className="hidden items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning sm:inline-flex" title="Mensagens autoexplosivas">
            <Timer className="h-3 w-3" /> {chatDurationLabel(room.autoDeleteSeconds)}
          </span>
        )}
        {oversight && (
          <label className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
            <Eye className="h-3.5 w-3.5 text-muted" />
            <span className="hidden sm:inline">Ver como</span>
            <select value={viewAs ?? ""} onChange={(e) => setViewAs(e.target.value || null)} className="bg-transparent font-semibold" aria-label="Ver como">
              {allPeople.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {props.mode === "oversight" && <OversightPeople room={props.room} />}
        {member && (
          <>
            {member.canNudge && (
              <HeaderButton
                label="Chamar a atenção"
                className="text-warning"
                onClick={() => (room.kind === "DIRECT" ? nudgeMutation.mutate(undefined) : setDialog("nudge"))}
              >
                <Zap className="h-4 w-4" />
              </HeaderButton>
            )}
            {room.kind !== "GENERAL" && (
              <HeaderButton label={member.favorite ? "Desafixar conversa" : "Fixar conversa no topo"} onClick={() => favoriteMutation.mutate(!member.favorite)}>
                <Star className={clsx("h-4 w-4", member.favorite && "fill-current text-warning")} />
              </HeaderButton>
            )}
            <HeaderButton label={member.mutedUntil ? "Tirar do silencioso" : "Silenciar"} onClick={() => (member.mutedUntil ? muteMutation.mutate(null) : setDialog("mute"))}>
              {member.mutedUntil ? <BellOff className="h-4 w-4 text-warning" /> : <Bell className="h-4 w-4" />}
            </HeaderButton>
            {room.kind === "DIRECT" && (
              <HeaderButton label="Mensagens autoexplosivas" onClick={() => setDialog("autodelete")}>
                <Timer className={clsx("h-4 w-4", room.autoDeleteSeconds && "text-warning")} />
              </HeaderButton>
            )}
            {room.kind === "GROUP" && (
              <HeaderButton label="Dados do grupo" onClick={() => setDialog("settings")}>
                <Settings2 className="h-4 w-4" />
              </HeaderButton>
            )}
          </>
        )}
      </div>

      {deletedRoom && (
        <div className="flex items-center gap-2 border-b border-border bg-danger-soft px-4 py-2 text-xs font-semibold text-danger">
          <Trash2 className="h-4 w-4 shrink-0" />
          Grupo finalizado: excluído por {props.mode === "oversight" ? props.room.deletedByName : ""} em {format(new Date(deletedRoom), "dd/MM/yyyy 'às' HH:mm")}. Os integrantes saíram na hora. Só leitura.
        </div>
      )}
      {pin && (
        <div className="flex items-center gap-2 border-b border-border bg-secondary/20 px-3 py-1.5 text-xs">
          <div className="flex flex-col gap-0.5" aria-hidden>
            {pins.map((p, i) => (
              <span key={p.messageId} className={clsx("block h-1.5 w-[3px] rounded-full bg-warning", i === pinIndex % pins.length ? "opacity-100" : "opacity-30")} />
            ))}
          </div>
          <Pin className="h-3.5 w-3.5 shrink-0 text-warning" />
          <button type="button" onClick={() => (void jumpTo(pin.messageId), setPinIndex((i) => i + 1))} className="min-w-0 flex-1 truncate text-left">
            <b>Fixada{pin.authorName ? ` · ${pin.authorName}` : ""}:</b> {pin.preview}
            {pin.until && <span className="text-muted"> · até {format(new Date(pin.until), "dd/MM")}</span>}
          </button>
          {pins.length > 1 && <span className="shrink-0 text-muted">{(pinIndex % pins.length) + 1} de {pins.length}</span>}
          {member?.canPin && (
            <button type="button" onClick={() => unpinMutation.mutate(pin.messageId)} className="rounded-full p-1 text-muted hover:bg-surface" aria-label="Desafixar" title="Desafixar">
              <PinOff className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="chat-wallpaper flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        {isFetchingNextPage && <p className="py-2 text-center text-xs text-muted">Carregando mensagens anteriores…</p>}
        {!hasNextPage && shown.length > 0 && <p className="py-2 text-center text-[11px] text-muted">Início da conversa</p>}
        {data && shown.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <span className="text-3xl">👋</span>
            Nenhuma mensagem ainda. Diga um oi!
          </div>
        )}
        {shown.map((m, i) => {
          const prev = shown[i - 1];
          const next = shown[i + 1];
          const newDay = !prev || format(new Date(prev.createdAt), "yyyy-MM-dd") !== format(new Date(m.createdAt), "yyyy-MM-dd");
          const sameRun = (a?: ChatMessageDTO, b?: ChatMessageDTO) =>
            Boolean(a && b && a.authorId && a.authorId === b.authorId && a.kind !== "NUDGE" && b.kind !== "NUDGE" && Math.abs(new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) < GROUP_GAP_MS && format(new Date(a.createdAt), "yyyy-MM-dd") === format(new Date(b.createdAt), "yyyy-MM-dd"));
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="sticky top-0 z-[5] flex justify-center py-2">
                  <span className="rounded-full border border-border bg-surface px-3 py-0.5 text-[11px] font-semibold text-muted shadow-sm">{dayLabel(new Date(m.createdAt), new Date())}</span>
                </div>
              )}
              {i === firstUnreadIndex && (
                <div className="my-2 flex items-center gap-3 text-[11px] font-bold text-primary">
                  <span className="h-px flex-1 bg-primary/40" />
                  {unreadAtOpen.current === 1 ? "1 mensagem nova" : `${unreadAtOpen.current} mensagens novas`}
                  <span className="h-px flex-1 bg-primary/40" />
                </div>
              )}
              <ChatMessageBubble
                message={m}
                mine={Boolean(viewerId && m.authorId === viewerId)}
                meId={viewerId}
                first={!sameRun(prev, m) || newDay}
                last={!sameRun(m, next)}
                readOnly={oversight || Boolean(deletedRoom)}
                oversight={oversight}
                canPin={member?.canPin}
                highlighted={highlight === m.id}
                actions={{
                  onReply: (msg) => (setEditing(null), setReplyTo(msg)),
                  onReact: (msg, emoji) => reactMutation.mutate({ id: msg.id, emoji }),
                  onInfo: setInfoFor,
                  onPin: setPinFor,
                  onEdit: (msg) => (setReplyTo(null), setEditing(msg)),
                  onDelete: setDeleteFor,
                  onVote: (pollId, optionIds) => voteMutation.mutate({ pollId, optionIds }),
                  onOpenConversation: oversight ? undefined : openConversation,
                  onJumpTo: (id) => void jumpTo(id),
                  onShowEdits: oversight ? setEditsFor : undefined,
                }}
              />
            </Fragment>
          );
        })}
        {typing && (
          <div className="mb-1 flex items-end gap-2">
            <span className="w-7" />
            <span className={clsx("inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-surface px-3 py-2.5 shadow-sm", typing.kind === "recording" && "text-xs font-bold text-danger")}>
              {typing.kind === "recording" ? (
                <>
                  <span className="chat-pulse h-2 w-2 rounded-full bg-danger" /> gravando áudio
                </>
              ) : (
                [0, 1, 2].map((d) => <span key={d} className="chat-typing-dot block h-1.5 w-1.5 rounded-full bg-muted" />)
              )}
            </span>
          </div>
        )}
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
          className="absolute bottom-24 right-5 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-elevated hover:text-[var(--color-text)]"
          aria-label="Ir para o fim da conversa"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/10 text-sm font-bold text-primary ring-4 ring-inset ring-primary/50">Solte os arquivos para enviar</div>
      )}

      {member && (
        <ChatComposer
          ref={composerRef}
          room={member}
          meId={meId}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onSent={() => {
            setAtBottom(true);
            refresh();
          }}
        />
      )}

      {infoFor && <MessageInfoPanel message={infoFor} oversight={oversight} onClose={() => setInfoFor(null)} />}
      {editsFor && (
        <ChatDialog title="Versões da mensagem" icon={<History className="h-4 w-4 text-info" />} onClose={() => setEditsFor(null)}>
          <div className="space-y-2">
            {editsFor.oversight?.edits.map((e, i) => (
              <div key={i} className="rounded-xl border border-border px-3 py-2 text-muted">
                <p className="text-[11px] font-semibold">{i === 0 ? "Original" : `Versão ${i + 1}`} · até {format(new Date(e.editedAt), "dd/MM HH:mm:ss")}</p>
                <p className="line-through">{e.body ?? "(sem texto)"}</p>
              </div>
            ))}
            <div className="rounded-xl border border-primary/40 px-3 py-2">
              <p className="text-[11px] font-semibold text-muted">Atual · editada às {editsFor.editedAt && format(new Date(editsFor.editedAt), "dd/MM HH:mm:ss")}</p>
              <p>{editsFor.body}</p>
            </div>
          </div>
        </ChatDialog>
      )}
      {pinFor && (
        <ChatDialog title="Fixar por quanto tempo?" icon={<Pin className="h-4 w-4 text-warning" />} onClose={() => setPinFor(null)}>
          <div className="grid gap-1.5">
            {([
              [1, "24 horas"],
              [7, "7 dias"],
              [30, "30 dias"],
              [null, "Até tirar"],
            ] as const).map(([days, label]) => (
              <button key={label} onClick={() => pinMutation.mutate({ messageId: pinFor.id, days })} className="rounded-card border border-border px-3 py-2 text-left text-sm font-semibold hover:bg-surface-alt">
                {label}
              </button>
            ))}
            <p className="pt-1 text-xs text-muted">Até 3 mensagens fixadas por conversa.</p>
          </div>
        </ChatDialog>
      )}
      {deleteFor && (
        <ChatConfirm
          title="Apagar para todos?"
          icon={<Trash2 className="h-4 w-4 text-danger" />}
          message="A mensagem some para todos da conversa e fica “Mensagem apagada” no lugar."
          confirmLabel="Apagar"
          danger
          busy={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteFor.id)}
          onClose={() => setDeleteFor(null)}
        />
      )}
      {dialog === "mute" && (
        <ChatDialog title="Silenciar conversa" icon={<BellOff className="h-4 w-4 text-warning" />} onClose={() => setDialog(null)}>
          <div className="grid gap-1.5">
            {([
              [8 * 3600_000, "8 horas"],
              [7 * 86_400_000, "1 semana"],
              [3650 * 86_400_000, "Sempre"],
            ] as const).map(([ms, label]) => (
              <button key={label} onClick={() => muteMutation.mutate(new Date(Date.now() + ms).toISOString())} className="rounded-card border border-border px-3 py-2 text-left text-sm font-semibold hover:bg-surface-alt">
                {label}
              </button>
            ))}
            <p className="pt-1 text-xs text-muted">Sem som nem notificação. Quando alguém marcar você com @, o aviso chega mesmo assim.</p>
          </div>
        </ChatDialog>
      )}
      {dialog === "nudge" && (
        <ChatDialog title="Chamar a atenção de quem?" icon={<Zap className="h-4 w-4 text-warning" />} onClose={() => setDialog(null)}>
          <div className="grid gap-1">
            {room.members
              .filter((m) => m.userId !== meId)
              .map((m) => (
                <button key={m.userId} onClick={() => nudgeMutation.mutate(m.userId)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-alt">
                  <PersonAvatar name={m.name} photoUrl={m.photoUrl} presence={m.presence} id={m.userId} size="sm" />
                  {m.name}
                </button>
              ))}
          </div>
        </ChatDialog>
      )}
      {dialog === "autodelete" && member && <AutoDeleteDialog room={member} onClose={() => setDialog(null)} />}
      {dialog === "settings" && member && <GroupSettings room={member} onClose={() => setDialog(null)} onLeft={onBack} />}
    </div>
  );
}

function HeaderButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt", className)} aria-label={label} title={label}>
      {children}
    </button>
  );
}

/** Gestão: who is in the room and who left (and how). */
function OversightPeople({ room }: { room: ChatRoomShape & { formerMembers: ChatFormerMemberDTO[] } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs font-semibold text-muted hover:bg-surface-alt hover:text-[var(--color-text)]">
        Integrantes · {room.members.length}
      </button>
      {open && (
        <ChatDialog title="Integrantes" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <div className="space-y-1.5">
              {room.members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2">
                  <PersonAvatar name={m.name} photoUrl={m.photoUrl} presence={m.presence} id={m.userId} size="sm" />
                  <span className="flex-1 truncate">{m.name}</span>
                  {m.isOwner && <span className="rounded-full bg-warning-soft px-2 text-[11px] font-bold text-warning">criador</span>}
                  {!m.isOwner && m.isAdmin && <span className="rounded-full bg-primary/10 px-2 text-[11px] font-bold text-primary">admin</span>}
                </div>
              ))}
            </div>
            {room.formerMembers.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted">Saíram ou foram removidos</p>
                {room.formerMembers.map((f) => (
                  <div key={f.userId + f.leftAt} className="flex items-center gap-2 text-muted">
                    <X className="h-3.5 w-3.5" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-[11px]">
                      {f.removedByName ? `removido por ${f.removedByName}` : "saiu"} · {format(new Date(f.leftAt), "dd/MM HH:mm")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ChatDialog>
      )}
    </>
  );
}
