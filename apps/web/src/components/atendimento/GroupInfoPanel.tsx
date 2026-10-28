import { useQuery } from "@tanstack/react-query";
import { format, isToday, isYesterday } from "date-fns";
import clsx from "clsx";
import { CheckCheck, Clock3, EyeOff, PanelRightClose, Shield, Users } from "lucide-react";
import type { GroupListItemDTO, GroupParticipantDTO, GroupReaderDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { initials, unreadLabel } from "../../lib/groups";

function when(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return `às ${format(d, "HH:mm")}`;
  if (isYesterday(d)) return `ontem às ${format(d, "HH:mm")}`;
  return `em ${format(d, "dd/MM 'às' HH:mm")}`;
}

export function readerStatus(r: GroupReaderDTO) {
  if (r.neverOpened) return { icon: EyeOff, tone: "text-warning", text: `Não abriu · ${unreadLabel(r.unreadCount)}` };
  if (r.unreadCount === 0) return { icon: CheckCheck, tone: "text-success", text: `Leu tudo · abriu ${when(r.lastReadAt!)}` };
  return { icon: Clock3, tone: "text-muted", text: `Abriu ${when(r.lastReadAt!)} · ${unreadLabel(r.unreadCount)}` };
}

/** "Leitura da equipe" (each person's own reading) and the group's participants. */
export function GroupInfoPanel({ group, onClose }: { group: GroupListItemDTO; onClose: () => void }) {
  const participants = useQuery({
    queryKey: ["group-participants", group.id],
    queryFn: async () => (await api.get<GroupParticipantDTO[]>(`/groups/${group.id}/participants`)).data,
    staleTime: 5 * 60_000,
  });
  const readers = [...group.readers].sort((a, b) => Number(b.isMe) - Number(a.isMe));
  return (
    <aside className="flex h-full flex-col overflow-y-auto border-l border-border bg-surface" aria-label="Painel do grupo">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold">Dados do grupo</p>
        <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Recolher painel do grupo">
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-1 border-b border-border px-4 py-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary/25 text-secondary-fg">
          <Users className="h-7 w-7" />
        </div>
        <p className="mt-1 text-sm font-semibold">{group.name}</p>
        <p className="text-xs text-muted">
          Grupo{group.participantsCount ? ` · ${group.participantsCount} participantes` : ""} · {group.whatsappConnectionName}
        </p>
      </div>

      <section className="border-b border-border px-4 py-3" aria-label="Leitura da equipe">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Leitura da equipe</p>
        <ul className="space-y-2.5">
          {readers.map((r) => {
            const s = readerStatus(r);
            return (
              <li key={r.userId} className="flex items-start gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10.5px] font-bold text-primary">{initials(r.name)}</span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {r.name}
                    {r.isMe && <span className="font-normal text-muted"> (você)</span>}
                  </p>
                  <p className={clsx("flex items-center gap-1 text-[11.5px]", s.tone)}>
                    <s.icon className="h-3 w-3 shrink-0" /> {s.text}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[11px] leading-snug text-muted">Cada pessoa tem a sua leitura: o grupo só deixa de aparecer como não lido para quem abriu.</p>
      </section>

      <section className="px-4 py-3" aria-label="Participantes">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Participantes{participants.data?.length ? ` · ${participants.data.length}` : ""}</p>
        {participants.data?.length === 0 && <p className="text-xs text-muted">A lista vem do WhatsApp e aparece quando o número está conectado.</p>}
        <ul className="space-y-1.5">
          {(participants.data ?? []).map((p, i) => (
            <li key={`${p.phone ?? p.name}-${i}`} className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="min-w-0 truncate">{p.name}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {p.phone && p.name !== `+${p.phone}` && <span className="text-[11px] tabular-nums text-muted">+{p.phone}</span>}
                {p.isAdmin && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-surface-alt px-1.5 py-0.5 text-[10px] font-medium text-muted">
                    <Shield className="h-2.5 w-2.5" /> admin
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
