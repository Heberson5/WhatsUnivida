import clsx from "clsx";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useNow } from "../../hooks/useNow";
import { formatMinutes } from "../common/StatCard";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";
import type { TeamData } from "@whatsatendende/presentation/shared";

// A pause running longer than this is highlighted in red.
const LONG_PAUSE_MINUTES = 30;

// Shared with the presentation, which turns the same team data into slides.
export type { TeamData };

export interface AgentConversationStats {
  agentId: string;
  conversations: number;
  closedNoReturn: number;
  avgHandlingMs: number | null;
}

function Avatar({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 text-[10px] font-bold text-primary">
      {photoUrl ? <img src={photoUrl} alt="" className="h-full w-full object-cover" /> : name.slice(0, 2).toUpperCase()}
    </span>
  );
}

function PresencePill({ presence, reason }: { presence: TeamData["agents"][number]["presence"]; reason: string | null }) {
  const style =
    presence === "ONLINE"
      ? "bg-success-soft text-success"
      : presence === "AWAY"
        ? "bg-warning-soft text-warning"
        : "border border-border bg-surface-alt text-muted";
  const label = presence === "ONLINE" ? "Online" : presence === "AWAY" ? (reason ? `Pausa · ${reason}` : "Pausado") : "Offline";
  return (
    <span className={clsx("inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px] font-semibold", style)} title={label}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** Live snapshot: how many people are online, paused and offline, and who's paused for how long. */
export function TeamNowCard({ team, onOpenUsers }: { team: TeamData | undefined; onOpenUsers?: () => void }) {
  const now = useNow();
  const total = team ? team.now.online + team.now.paused + team.now.offline : 0;
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : "0%");

  return (
    <div className="shadow-soft flex flex-col rounded-card border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Equipe agora</h3>
        <span className="text-xs text-muted">só atendentes · atualiza sozinho</span>
        {onOpenUsers && (
          <button onClick={onOpenUsers} className="focus-ring ml-auto text-xs font-semibold text-primary hover:underline">
            Ver Usuários →
          </button>
        )}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border px-3 py-2">
          <p className="text-xl font-semibold tabular-nums text-success">{team?.now.online ?? "–"}</p>
          <p className="text-xs text-muted">Online</p>
        </div>
        <div className={clsx("rounded-lg border px-3 py-2", team?.now.paused ? "border-warning/40 bg-warning-soft" : "border-border")}>
          <p className="text-xl font-semibold tabular-nums text-warning">{team?.now.paused ?? "–"}</p>
          <p className="text-xs text-muted">Em pausa</p>
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <p className="text-xl font-semibold tabular-nums">{team?.now.offline ?? "–"}</p>
          <p className="text-xs text-muted">Offline</p>
        </div>
      </div>
      <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-alt" aria-hidden>
        <span className="bg-success" style={{ width: pct(team?.now.online ?? 0) }} />
        <span className="bg-amber-500" style={{ width: pct(team?.now.paused ?? 0) }} />
        <span className="bg-border" style={{ width: pct(team?.now.offline ?? 0) }} />
      </div>
      <div className="mt-3 space-y-2">
        {team?.now.pausedUsers.length === 0 && <p className="text-xs text-muted">Ninguém em pausa agora.</p>}
        {team?.now.pausedUsers.map((u) => {
          const minutes = u.since ? (now - new Date(u.since).getTime()) / 60_000 : 0;
          return (
            <div key={u.userId} className="flex items-center gap-2 text-[13px]">
              <Avatar name={u.name} photoUrl={u.photoUrl} />
              <span className="truncate font-medium">{u.name}</span>
              <span className="truncate rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">{u.reasonName ?? "Pausa"}</span>
              {u.since && (
                <span className={clsx("ml-auto shrink-0 text-xs tabular-nums", minutes >= LONG_PAUSE_MINUTES ? "font-semibold text-danger" : "text-muted")}>
                  há {formatDistanceToNow(new Date(u.since), { locale: ptBR })}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatHours(ms: number) {
  if (ms <= 0) return "—";
  return formatMinutes(ms);
}

/** One row per agent: status right now, conversations, and time online / paused in the period. */
export function AgentsTable({ team, stats }: { team: TeamData | undefined; stats: AgentConversationStats[] }) {
  const columnView = useColumnView("dashboardEquipe");
  const byId = new Map(stats.map((s) => [s.agentId, s]));
  const maxConversations = Math.max(1, ...stats.map((s) => s.conversations));
  const rows = team?.agents ?? [];
  const maxPaused = Math.max(...rows.map((a) => a.pausedMs), 0);

  return (
    <div className="shadow-soft overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <h3 className="text-sm font-semibold">Atendentes</h3>
        <span className="text-xs text-muted">no período</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted">
              <th className="w-0 py-2 pl-2 pr-0">
                <ColumnViewMenu view={columnView} />
              </th>
              {columnView.visibleKeys.map((key) => {
                switch (key) {
                  case "agent":
                    return (
                      <th key="agent" className="px-4 py-2">Atendente</th>
                    );
                  case "now":
                    return (
                      <th key="now" className="px-2 py-2">Agora</th>
                    );
                  case "conversations":
                    return (
                      <th key="conversations" className="px-2 py-2">Conversas</th>
                    );
                  case "noReturn":
                    return (
                      <th key="noReturn" className="px-2 py-2 text-right" title="Encerradas por falta de retorno do cliente — já contam em Conversas">
                        Sem retorno
                      </th>
                    );
                  case "avgTime":
                    return (
                      <th key="avgTime" className="px-2 py-2 text-right">Tempo médio</th>
                    );
                  case "online":
                    return (
                      <th key="online" className="px-2 py-2 text-right">Online</th>
                    );
                  case "paused":
                    return (
                      <th key="paused" className="px-4 py-2 text-right">Em pausa</th>
                    );
                  default:
                    return null;
                }
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 1} className="px-4 py-6 text-center text-xs text-muted">
                  Nenhum atendente ativo.
                </td>
              </tr>
            )}
            {rows.map((a) => {
              const s = byId.get(a.agentId);
              return (
                <tr key={a.agentId} className="border-b border-border last:border-b-0">
                  <td className="w-0 p-0" />
                  {columnView.visibleKeys.map((key) => {
                    switch (key) {
                      case "agent":
                        return (
                          <td key="agent" className="px-4 py-2">
                            <span className="flex items-center gap-2">
                              <Avatar name={a.agentName} photoUrl={a.photoUrl} />
                              <span className="truncate font-medium">{a.agentName}</span>
                            </span>
                          </td>
                        );
                      case "now":
                        return (
                          <td key="now" className="max-w-[140px] px-2 py-2">
                            <PresencePill presence={a.presence} reason={a.pauseReasonName} />
                          </td>
                        );
                      case "conversations":
                        return (
                          <td key="conversations" className="px-2 py-2">
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-alt">
                                <span className="block h-full rounded-full bg-primary" style={{ width: `${((s?.conversations ?? 0) / maxConversations) * 100}%` }} />
                              </span>
                              <span className="tabular-nums">{s?.conversations ?? 0}</span>
                            </span>
                          </td>
                        );
                      case "noReturn":
                        return (
                          <td key="noReturn" className="px-2 py-2 text-right tabular-nums">{s?.closedNoReturn ?? 0}</td>
                        );
                      case "avgTime":
                        return (
                          <td key="avgTime" className="px-2 py-2 text-right tabular-nums">{formatMinutes(s?.avgHandlingMs ?? null)}</td>
                        );
                      case "online":
                        return (
                          <td key="online" className="px-2 py-2 text-right tabular-nums">{formatHours(a.onlineMs)}</td>
                        );
                      case "paused":
                        return (
                          <td key="paused"
                            className={clsx(
                              "px-4 py-2 text-right tabular-nums",
                              a.pausedMs > 0 && a.pausedMs === maxPaused && rows.length > 1 && "font-semibold text-danger"
                            )}
                          >
                            {formatHours(a.pausedMs)}
                          </td>
                        );
                      default:
                        return null;
                    }
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
