import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { Crown, LogOut, MessageSquare, MoreHorizontal, Pencil, Shield, ShieldOff, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import type { ChatRoomDTO, ChatUserDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { useInternalChatStore } from "../../store/internal-chat-store";
import { PersonAvatar, RoomIcon } from "./ChatAvatar";
import { ChatConfirm } from "./ChatDialogs";

export const GROUP_ICONS = ["💬", "💰", "📞", "🧾", "📋", "🛟", "⭐", "🚀", "🎯", "🔔", "📅", "🏥", "🤝", "☕", "🎉", "🔥"];

type Confirm = { kind: "leave" } | { kind: "delete" } | { kind: "remove"; userId: string; name: string } | null;

/** The group's sheet: name, picture and description, members with their menu, adding people, leaving and deleting. */
export function GroupSettings({ room, onClose, onLeft }: { room: ChatRoomDTO; onClose: () => void; onLeft: () => void }) {
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const setActiveRoom = useInternalChatStore((s) => s.setActiveRoom);
  const [adding, setAdding] = useState<string[]>([]);
  const [canSeeHistory, setCanSeeHistory] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [editingInfo, setEditingInfo] = useState(false);
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description ?? "");
  const [icon, setIcon] = useState(room.icon);
  const { data: users } = useQuery({
    queryKey: ["internal-chat", "users"],
    queryFn: async () => (await api.get<ChatUserDTO[]>("/internal-chat/users")).data,
    enabled: room.canManageMembers,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["internal-chat"] });
  const onError = (err: unknown) => toast.error(getApiErrorMessage(err));

  const addMutation = useMutation({
    mutationFn: () => api.post(`/internal-chat/rooms/${room.id}/members`, { userIds: adding, canSeeHistory }),
    onSuccess: () => (setAdding([]), refresh()),
    onError,
  });
  const adminMutation = useMutation({
    mutationFn: ({ memberId, admin }: { memberId: string; admin: boolean }) => api.put(`/internal-chat/rooms/${room.id}/members/${memberId}/admin`, { admin }),
    onSuccess: refresh,
    onError,
  });
  const removeMutation = useMutation({
    mutationFn: (memberId: string) => api.delete(`/internal-chat/rooms/${room.id}/members/${memberId}`),
    onSuccess: () => (setConfirm(null), refresh()),
    onError,
  });
  const leaveMutation = useMutation({
    mutationFn: () => api.post(`/internal-chat/rooms/${room.id}/leave`),
    onSuccess: () => (refresh(), onLeft()),
    onError,
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/internal-chat/rooms/${room.id}`),
    onSuccess: () => {
      toast.success("Grupo excluído. Todos os integrantes saíram.");
      refresh();
      onLeft();
    },
    onError,
  });
  const infoMutation = useMutation({
    mutationFn: () => api.patch(`/internal-chat/rooms/${room.id}`, { name: name.trim(), description: description.trim() || null, icon }),
    onSuccess: () => (setEditingInfo(false), refresh()),
    onError,
  });
  const directMutation = useMutation({
    mutationFn: async (peerId: string) => (await api.post<ChatRoomDTO>("/internal-chat/direct", { userId: peerId })).data,
    onSuccess: (dm) => (refresh(), setActiveRoom(dm.id)),
    onError,
  });

  const memberIds = new Set(room.members.map((m) => m.userId));
  const candidates = (users ?? []).filter((u) => !memberIds.has(u.id));
  const me = room.members.find((m) => m.userId === userId);
  const isOwner = Boolean(me?.isOwner);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-bold">Dados do grupo</h3>
        <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4 text-sm">
        {editingInfo ? (
          <div className="space-y-2 rounded-2xl border border-border p-3">
            <div className="flex flex-wrap gap-1">
              {GROUP_ICONS.map((e) => (
                <button key={e} type="button" onClick={() => setIcon(e)} className={clsx("rounded-lg p-1 text-xl", icon === e ? "bg-primary/15 ring-2 ring-primary" : "hover:bg-surface-alt")}>
                  {e}
                </button>
              ))}
            </div>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="focus-ring w-full rounded-card border border-border bg-surface-alt px-3 py-2 font-semibold" aria-label="Nome do grupo" />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} rows={2} placeholder="Descrição (opcional)" className="focus-ring w-full resize-none rounded-card border border-border bg-surface-alt px-3 py-2" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditingInfo(false)} className="rounded-card border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-alt">
                Cancelar
              </button>
              <button onClick={() => infoMutation.mutate()} disabled={!name.trim() || infoMutation.isPending} className="rounded-card bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-50">
                Salvar
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <RoomIcon kind="GROUP" icon={room.icon} seed={room.id} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-bold">{room.name}</p>
              <p className="text-xs text-muted">{room.members.length} integrantes</p>
              {room.description && <p className="mt-1 text-xs">{room.description}</p>}
            </div>
            {room.canManageMembers && (
              <button onClick={() => setEditingInfo(true)} className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt" aria-label="Editar nome, ícone e descrição" title="Editar">
                <Pencil className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">{room.members.length} integrantes</p>
          <ul className="space-y-0.5">
            {room.members.map((m) => {
              const canRemove = room.canManageMembers && !m.isOwner && m.userId !== userId && (isOwner || !m.isAdmin);
              const canAdmin = room.canManageAdmins && !m.isOwner && m.userId !== userId;
              // Everyone else has at least "Mandar mensagem".
              const hasMenu = m.userId !== userId;
              return (
                <li key={m.userId} className="relative flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-surface-alt">
                  <PersonAvatar name={m.name} photoUrl={m.photoUrl} presence={m.presence} id={m.userId} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{m.userId === userId ? "Você" : m.name}</span>
                  {m.isOwner && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning">
                      <Crown className="h-3 w-3" /> criador
                    </span>
                  )}
                  {!m.isOwner && m.isAdmin && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                      <Shield className="h-3 w-3" /> admin
                    </span>
                  )}
                  {hasMenu && (
                    <button onClick={() => setMenuFor(menuFor === m.userId ? null : m.userId)} className="focus-ring rounded-full p-1 text-muted hover:bg-surface" aria-label={`Opções de ${m.name}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  )}
                  {menuFor === m.userId && (
                    <div className="absolute right-2 top-9 z-10 w-52 rounded-xl border border-border bg-surface p-1 shadow-elevated" onMouseLeave={() => setMenuFor(null)}>
                      <MenuButton icon={<MessageSquare className="h-4 w-4" />} onClick={() => (setMenuFor(null), directMutation.mutate(m.userId))}>
                        Mandar mensagem
                      </MenuButton>
                      {canAdmin && (
                        <MenuButton icon={m.isAdmin ? <ShieldOff className="h-4 w-4" /> : <Shield className="h-4 w-4" />} onClick={() => (setMenuFor(null), adminMutation.mutate({ memberId: m.userId, admin: !m.isAdmin }))}>
                          {m.isAdmin ? "Tirar admin" : "Tornar admin"}
                        </MenuButton>
                      )}
                      {canRemove && (
                        <MenuButton danger icon={<UserMinus className="h-4 w-4" />} onClick={() => (setMenuFor(null), setConfirm({ kind: "remove", userId: m.userId, name: m.name }))}>
                          Remover do grupo
                        </MenuButton>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {room.canManageMembers && (
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted">Adicionar pessoas</p>
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {candidates.map((u) => {
                const on = adding.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setAdding(on ? adding.filter((x) => x !== u.id) : [...adding, u.id])}
                    className={clsx("inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs", on ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border hover:bg-surface-alt")}
                  >
                    <PersonAvatar name={u.name} photoUrl={u.photoUrl} id={u.id} size="xs" />
                    {u.name}
                  </button>
                );
              })}
              {candidates.length === 0 && <p className="text-xs text-muted">Todo mundo já está no grupo.</p>}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={canSeeHistory} onChange={(e) => setCanSeeHistory(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
              Pode ver o histórico de mensagens anteriores
            </label>
            <button
              onClick={() => addMutation.mutate()}
              disabled={adding.length === 0 || addMutation.isPending}
              className="focus-ring inline-flex items-center gap-1 rounded-card bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-60"
            >
              <UserPlus className="h-3.5 w-3.5" /> Adicionar
            </button>
          </div>
        )}
      </div>
      <div className="space-y-1 border-t border-border p-3">
        <button onClick={() => setConfirm({ kind: "leave" })} className="focus-ring flex w-full items-center gap-2 rounded-card px-3 py-2 text-sm font-semibold text-danger hover:bg-danger-soft">
          <LogOut className="h-4 w-4" /> Sair do grupo
        </button>
        {room.canDelete && (
          <button onClick={() => setConfirm({ kind: "delete" })} className="focus-ring flex w-full items-center gap-2 rounded-card px-3 py-2 text-sm font-semibold text-danger hover:bg-danger-soft">
            <Trash2 className="h-4 w-4" /> Excluir grupo
          </button>
        )}
      </div>

      {confirm?.kind === "leave" && (
        <ChatConfirm
          title={`Sair de “${room.name}”?`}
          icon={<LogOut className="h-4 w-4 text-danger" />}
          message={isOwner ? "O grupo passa para o administrador mais antigo (ou, sem administrador, para o integrante mais antigo) e some para você." : "O grupo some para você."}
          confirmLabel="Sair"
          danger
          busy={leaveMutation.isPending}
          onConfirm={() => leaveMutation.mutate()}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "remove" && (
        <ChatConfirm
          title={`Remover ${confirm.name}?`}
          icon={<UserMinus className="h-4 w-4 text-danger" />}
          message={`${confirm.name} sai do grupo e deixa de ver a conversa. A remoção aparece para todos.`}
          confirmLabel="Remover"
          danger
          busy={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate(confirm.userId)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "delete" && (
        <ChatConfirm
          title={`Excluir “${room.name}”?`}
          icon={<Trash2 className="h-4 w-4 text-danger" />}
          message={`Os ${room.members.length} integrantes saem do grupo na hora e ele some para todos. Ninguém mais manda mensagem nele.`}
          confirmLabel="Excluir grupo"
          danger
          typeToConfirm={room.name}
          busy={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function MenuButton({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={clsx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-alt", danger && "text-danger")}>
      {icon}
      {children}
    </button>
  );
}
