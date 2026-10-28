import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import clsx from "clsx";
import { Search, ShieldAlert, Timer, Trash2 } from "lucide-react";
import type { ChatOversightRoomDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { PersonAvatar, RoomIcon } from "../../components/internal-chat/ChatAvatar";
import { ChatRoomView } from "../../components/internal-chat/ChatRoomView";
import { typingLabel, useInternalChatStore } from "../../store/internal-chat-store";

type Filter = "all" | "groups" | "direct" | "finished";

/**
 * Gestão › Chat interno (administrador only): every conversation of the team as its members see it — plus what
 * disappeared for them (finished groups, temporary, deleted and edited messages). No sign to who is talking; each
 * conversation opened is audited.
 */
export default function AcompanharChatPage() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const typing = useInternalChatStore((s) => s.typing);
  const { data: rooms } = useQuery({ queryKey: ["internal-chat-oversight"], queryFn: async () => (await api.get<ChatOversightRoomDTO[]>("/internal-chat/oversight/rooms")).data });
  const room = rooms?.find((r) => r.id === roomId);
  const finished = (rooms ?? []).filter((r) => r.deletedAt).length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rooms ?? []).filter((r) => {
      if (filter === "groups" && r.kind === "DIRECT") return false;
      if (filter === "direct" && r.kind !== "DIRECT") return false;
      if (filter === "finished" && !r.deletedAt) return false;
      return !q || r.name.toLowerCase().includes(q) || r.members.some((m) => m.name.toLowerCase().includes(q));
    });
  }, [rooms, filter, search]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start gap-2 border-b border-warning bg-warning-soft px-4 py-2.5 text-xs">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p>
          Só o administrador vê esta tela. Quem conversa não é avisado desta leitura, e cada conversa aberta aqui fica registrada na auditoria. Use conforme a política interna da empresa e
          a LGPD, para fins de gestão e segurança.
        </p>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={clsx("flex w-full flex-col border-r border-border bg-surface md:w-80 md:shrink-0", roomId && "hidden md:flex")}>
          <div className="space-y-2 p-3">
            <label className="flex items-center gap-2 rounded-full bg-surface-alt px-3 py-1.5 text-sm text-muted">
              <Search className="h-4 w-4" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar conversa ou pessoa" className="w-full bg-transparent text-[var(--color-text)] outline-none" />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["all", "Todas"],
                  ["groups", "Grupos"],
                  ["direct", "Diretas"],
                  ["finished", "Finalizados"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={clsx("rounded-full border px-2.5 py-0.5 text-xs font-semibold", filter === key ? "border-primary bg-primary text-primary-fg" : "border-border text-muted hover:bg-surface-alt")}
                >
                  {label}
                  {key === "finished" && finished > 0 && <b className="ml-1">{finished}</b>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {rooms?.length === 0 && <p className="p-4 text-sm text-muted">Nenhuma conversa ainda.</p>}
            {visible.map((r) => {
              const live = typingLabel(typing[r.id] ? Object.values(typing[r.id]) : undefined);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRoomId(r.id)}
                  className={clsx("relative flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-alt", r.id === roomId && "bg-primary/[0.08]", r.deletedAt && "opacity-80")}
                >
                  {r.deletedAt ? (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
                      <Trash2 className="h-4 w-4" />
                    </span>
                  ) : r.kind === "DIRECT" ? (
                    <span className="flex -space-x-2">
                      {r.members.slice(0, 2).map((m) => (
                        <PersonAvatar key={m.userId} name={m.name} photoUrl={m.photoUrl} id={m.userId} size="sm" />
                      ))}
                    </span>
                  ) : (
                    <RoomIcon kind={r.kind} icon={r.icon} seed={r.id} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold">{r.name}</span>
                      {r.deletedAt && <span className="shrink-0 rounded-full bg-danger-soft px-1.5 text-[10.5px] font-bold text-danger">finalizado</span>}
                      {r.autoDeleteSeconds && <Timer className="h-3 w-3 shrink-0 text-warning" />}
                    </span>
                    <span className={clsx("block truncate text-xs", live ? "font-semibold italic text-success" : "text-muted")}>
                      {live
                        ? live.text
                        : r.deletedAt
                          ? `por ${r.deletedByName ?? "—"} · ${format(new Date(r.deletedAt), "dd/MM HH:mm")}`
                          : `${r.members.length} integrantes${r.lastMessageAt ? ` · ${format(new Date(r.lastMessageAt), "dd/MM HH:mm")}` : ""}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className={clsx("min-w-0 flex-1 flex-col", roomId ? "flex" : "hidden md:flex")}>
          {room ? (
            <ChatRoomView key={room.id} mode="oversight" room={room} onBack={() => setRoomId(null)} />
          ) : (
            <div className="chat-wallpaper flex flex-1 items-center justify-center text-sm text-muted">Escolha uma conversa para ler</div>
          )}
        </div>
      </div>
    </div>
  );
}
