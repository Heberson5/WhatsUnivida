import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";
import clsx from "clsx";
import { BellOff, MessageSquarePlus, Search, Star, Timer, Users, X } from "lucide-react";
import type { ChatRoomDTO, ChatSearchResultDTO, ChatUserDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { typingLabel, useInternalChatStore } from "../../store/internal-chat-store";
import { ChatRoomView } from "./ChatRoomView";
import { PersonAvatar, RoomIcon } from "./ChatAvatar";
import { GROUP_ICONS } from "./GroupSettings";

export const chatRoomsKey = ["internal-chat", "rooms"];

export function useChatRooms() {
  return useQuery({ queryKey: chatRoomsKey, queryFn: async () => (await api.get<ChatRoomDTO[]>("/internal-chat/rooms")).data, refetchInterval: 60_000 });
}

type Picker = { mode: "direct" } | { mode: "group"; name: string; icon: string; description: string; memberIds: string[] } | null;
type Filter = "all" | "unread" | "groups" | "direct";

/** The side panel: #Geral, groups and direct conversations on the left, the open one on the right. */
export function InternalChatDrawer() {
  const queryClient = useQueryClient();
  const me = useAuthStore((s) => s.user?.id);
  const { setOpen, activeRoomId, setActiveRoom } = useInternalChatStore();
  const typing = useInternalChatStore((s) => s.typing);
  const { data: rooms } = useChatRooms();
  const [picker, setPicker] = useState<Picker>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const { data: users } = useQuery({ queryKey: ["internal-chat", "users"], queryFn: async () => (await api.get<ChatUserDTO[]>("/internal-chat/users")).data });
  const q = search.trim();
  const { data: found } = useQuery({
    queryKey: ["internal-chat", "search", q],
    queryFn: async () => (await api.get<ChatSearchResultDTO[]>("/internal-chat/search", { params: { q } })).data,
    enabled: q.length >= 2,
  });

  const onOpened = (room: ChatRoomDTO) => {
    queryClient.invalidateQueries({ queryKey: chatRoomsKey });
    setActiveRoom(room.id);
    setPicker(null);
    setSearch("");
  };
  const onError = (err: unknown) => toast.error(getApiErrorMessage(err));
  const directMutation = useMutation({ mutationFn: async (userId: string) => (await api.post<ChatRoomDTO>("/internal-chat/direct", { userId })).data, onSuccess: onOpened, onError });
  const groupMutation = useMutation({
    mutationFn: async (input: { name: string; memberIds: string[]; icon: string; description: string }) => (await api.post<ChatRoomDTO>("/internal-chat/groups", { ...input, description: input.description || null })).data,
    onSuccess: onOpened,
    onError,
  });

  const active = rooms?.find((r) => r.id === activeRoomId) ?? null;
  const others = (users ?? []).filter((u) => u.id !== me);
  const online = others.filter((u) => u.presence === "ONLINE");
  const unreadTotal = (rooms ?? []).filter((r) => r.unreadCount > 0).length;

  const visibleRooms = useMemo(() => {
    const text = q.toLowerCase();
    return (rooms ?? []).filter((r) => {
      if (filter === "unread" && r.unreadCount === 0) return false;
      if (filter === "groups" && r.kind === "DIRECT") return false;
      if (filter === "direct" && r.kind !== "DIRECT") return false;
      return !text || r.name.toLowerCase().includes(text) || r.members.some((m) => m.name.toLowerCase().includes(text));
    });
  }, [rooms, filter, q]);
  const peopleFound = q ? others.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()) && !rooms?.some((r) => r.kind === "DIRECT" && r.peer?.userId === u.id)) : [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/25 [animation:backdrop-in_0.2s_ease-out]" onClick={() => setOpen(false)}>
      <aside
        className="flex h-full w-full max-w-4xl overflow-hidden border-l border-border bg-surface shadow-elevated [animation:drawer-in_0.25s_ease-out]"
        onClick={(e) => e.stopPropagation()}
        aria-label="Chat interno"
      >
        <div className={clsx("flex w-full flex-col border-r border-border md:w-[300px] md:shrink-0", active && "hidden md:flex")}>
          <div className="space-y-2.5 px-3.5 pb-2 pt-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-extrabold">Chat interno</h2>
              <div className="flex items-center gap-0.5">
                <IconButton label="Nova conversa" onClick={() => setPicker({ mode: "direct" })}>
                  <MessageSquarePlus className="h-4 w-4" />
                </IconButton>
                <IconButton label="Novo grupo" onClick={() => setPicker({ mode: "group", name: "", icon: GROUP_ICONS[0], description: "", memberIds: [] })}>
                  <Users className="h-4 w-4" />
                </IconButton>
                <IconButton label="Fechar chat interno" onClick={() => setOpen(false)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
            <label className="flex items-center gap-2 rounded-full bg-surface-alt px-3 py-1.5 text-sm text-muted focus-within:ring-2 focus-within:ring-primary/40">
              <Search className="h-4 w-4 shrink-0" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar pessoa, grupo ou mensagem" className="w-full bg-transparent text-[var(--color-text)] outline-none placeholder:text-muted" />
              {search && (
                <button onClick={() => setSearch("")} aria-label="Limpar busca">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
          </div>

          {online.length > 0 && !picker && !q && (
            <div className="flex gap-3 overflow-x-auto px-3.5 pb-2" aria-label="Equipe online">
              {online.map((u) => (
                <button key={u.id} type="button" onClick={() => directMutation.mutate(u.id)} className="flex w-11 shrink-0 flex-col items-center gap-1 text-[10.5px] text-muted hover:text-[var(--color-text)]" title={`Conversar com ${u.name}`}>
                  <PersonAvatar name={u.name} photoUrl={u.photoUrl} id={u.id} ring />
                  <span className="w-full truncate text-center">{u.name.split(" ")[0]}</span>
                </button>
              ))}
            </div>
          )}

          {!picker && (
            <div className="flex flex-wrap gap-1.5 px-3.5 pb-2">
              {(
                [
                  ["all", "Todas"],
                  ["unread", "Não lidas"],
                  ["groups", "Grupos"],
                  ["direct", "Diretas"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={clsx("rounded-full border px-2.5 py-0.5 text-xs font-semibold", filter === key ? "border-primary bg-primary text-primary-fg" : "border-border text-muted hover:bg-surface-alt")}
                >
                  {label}
                  {key === "unread" && unreadTotal > 0 && <b className="ml-1">{unreadTotal}</b>}
                </button>
              ))}
            </div>
          )}

          {picker && (
            <div className="space-y-2 border-y border-border bg-surface-alt p-3 text-sm">
              <p className="text-xs font-bold">{picker.mode === "direct" ? "Conversar com" : "Novo grupo"}</p>
              {picker.mode === "group" && (
                <>
                  <div className="flex flex-wrap gap-0.5">
                    {GROUP_ICONS.map((e) => (
                      <button key={e} type="button" onClick={() => setPicker({ ...picker, icon: e })} className={clsx("rounded-lg p-0.5 text-lg", picker.icon === e ? "bg-primary/15 ring-2 ring-primary" : "hover:bg-surface")}>
                        {e}
                      </button>
                    ))}
                  </div>
                  <input autoFocus value={picker.name} onChange={(e) => setPicker({ ...picker, name: e.target.value })} placeholder="Nome do grupo" maxLength={60} className="focus-ring w-full rounded-card border border-border bg-surface px-2.5 py-1.5 text-sm" />
                  <input value={picker.description} onChange={(e) => setPicker({ ...picker, description: e.target.value })} placeholder="Descrição (opcional)" maxLength={200} className="focus-ring w-full rounded-card border border-border bg-surface px-2.5 py-1.5 text-xs" />
                </>
              )}
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {others.map((u) => {
                  const selected = picker.mode === "group" && picker.memberIds.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() =>
                        picker.mode === "direct"
                          ? directMutation.mutate(u.id)
                          : setPicker({ ...picker, memberIds: selected ? picker.memberIds.filter((x) => x !== u.id) : [...picker.memberIds, u.id] })
                      }
                      className={clsx("flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-surface", selected && "bg-primary/10 font-semibold")}
                    >
                      <PersonAvatar name={u.name} photoUrl={u.photoUrl} presence={u.presence} id={u.id} size="sm" />
                      <span className="flex-1 truncate">{u.name}</span>
                      {selected && <span className="text-xs text-primary">✓</span>}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setPicker(null)} className="rounded-card px-2.5 py-1 text-xs font-semibold hover:bg-surface">
                  Cancelar
                </button>
                {picker.mode === "group" && (
                  <button
                    onClick={() => groupMutation.mutate({ name: picker.name.trim(), memberIds: picker.memberIds, icon: picker.icon, description: picker.description.trim() })}
                    disabled={!picker.name.trim() || picker.memberIds.length === 0 || groupMutation.isPending}
                    className="rounded-card bg-primary px-2.5 py-1 text-xs font-semibold text-primary-fg disabled:opacity-60"
                  >
                    Criar grupo ({picker.memberIds.length})
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto pb-2">
            {visibleRooms.map((room) => {
              const roomTyping = typingLabel(typing[room.id] ? Object.values(typing[room.id]) : undefined);
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => setActiveRoom(room.id)}
                  className={clsx("relative flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-surface-alt", room.id === activeRoomId && "bg-primary/[0.08]")}
                >
                  {room.id === activeRoomId && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r bg-primary" />}
                  {room.kind === "DIRECT" && room.peer ? (
                    <PersonAvatar name={room.peer.name} photoUrl={room.peer.photoUrl} presence={room.peer.presence} id={room.peer.userId} />
                  ) : (
                    <RoomIcon kind={room.kind} icon={room.icon} seed={room.id} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-1">
                      <span className={clsx("flex min-w-0 items-center gap-1 truncate text-sm", room.unreadCount > 0 ? "font-bold" : "font-semibold")}>
                        <span className="truncate">{room.name}</span>
                        {room.favorite && <Star className="h-3 w-3 shrink-0 fill-current text-warning" />}
                        {room.mutedUntil && <BellOff className="h-3 w-3 shrink-0 text-muted" />}
                        {room.autoDeleteSeconds && <Timer className="h-3 w-3 shrink-0 text-warning" />}
                      </span>
                      {room.lastMessage && (
                        <span className={clsx("shrink-0 text-[10.5px]", room.unreadCount > 0 ? "font-bold text-primary" : "text-muted")}>
                          {formatDistanceToNowStrict(new Date(room.lastMessage.createdAt), { locale: ptBR })}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center justify-between gap-1">
                      {roomTyping ? (
                        <span className={clsx("truncate text-xs font-semibold italic", roomTyping.kind === "recording" ? "text-danger" : "text-success")}>{roomTyping.text}</span>
                      ) : (
                        <span className="truncate text-xs text-muted">
                          {room.lastMessage ? `${room.lastMessage.authorName && room.kind !== "DIRECT" ? `${room.lastMessage.authorName.split(" ")[0]}: ` : ""}${room.lastMessage.body}` : "Sem mensagens"}
                        </span>
                      )}
                      <span className="flex shrink-0 items-center gap-1">
                        {room.unreadMentions > 0 && <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-secondary text-[10px] font-black text-secondary-fg">@</span>}
                        {room.unreadCount > 0 && (
                          <span className={clsx("flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold", room.mutedUntil ? "bg-muted text-white" : "bg-primary text-primary-fg")}>
                            {room.unreadCount > 99 ? "99+" : room.unreadCount}
                          </span>
                        )}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
            {q && peopleFound.length > 0 && (
              <div className="pt-2">
                <p className="px-3.5 pb-1 text-[10.5px] font-bold uppercase tracking-wider text-muted">Pessoas</p>
                {peopleFound.map((u) => (
                  <button key={u.id} type="button" onClick={() => directMutation.mutate(u.id)} className="flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left text-sm hover:bg-surface-alt">
                    <PersonAvatar name={u.name} photoUrl={u.photoUrl} presence={u.presence} id={u.id} size="sm" />
                    {u.name}
                  </button>
                ))}
              </div>
            )}
            {q.length >= 2 && (found ?? []).length > 0 && (
              <div className="pt-2">
                <p className="px-3.5 pb-1 text-[10.5px] font-bold uppercase tracking-wider text-muted">Mensagens</p>
                {found!.map((f) => (
                  <button key={f.messageId} type="button" onClick={() => (setActiveRoom(f.roomId, f.messageId), setSearch(""))} className="block w-full px-3.5 py-1.5 text-left hover:bg-surface-alt">
                    <span className="flex justify-between gap-2 text-xs">
                      <b className="truncate">{f.roomName}</b>
                      <span className="shrink-0 text-muted">{formatDistanceToNowStrict(new Date(f.createdAt), { locale: ptBR })}</span>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted">
                      {f.authorName ? `${f.authorName.split(" ")[0]}: ` : ""}
                      {f.body}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {rooms && visibleRooms.length === 0 && !q && <p className="px-4 py-6 text-center text-xs text-muted">Nenhuma conversa neste filtro.</p>}
          </div>
        </div>
        {active ? (
          <ChatRoomView key={active.id} mode="member" room={active} onBack={() => setActiveRoom(null)} />
        ) : (
          <div className="chat-wallpaper hidden flex-1 flex-col items-center justify-center gap-2 text-sm text-muted md:flex">
            <span className="text-4xl">💬</span>
            Escolha uma conversa ou comece uma nova
          </div>
        )}
      </aside>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-[var(--color-text)]" title={label} aria-label={label}>
      {children}
    </button>
  );
}
