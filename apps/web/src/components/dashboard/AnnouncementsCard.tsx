import { Link } from "react-router-dom";
import { Megaphone, ShieldCheck } from "lucide-react";
import type { AnnouncementStatsDTO } from "@whatsatendende/types";
import { CHART_CARD_SHADOW } from "../../lib/chart-theme";
import { KIND_STYLE } from "../announcements/announcement-ui";

/**
 * Dashboard › Comunicados (Gestor e Administrador): the notices of Pop Up › Avisos in the period — how many people read
 * and confirmed them, and the three with the most "ciente" still owed. The same numbers go to the presentation's slide.
 */
export function AnnouncementsCard({ stats, isLoading, boardName }: { stats: AnnouncementStatsDTO | undefined; isLoading: boolean; boardName: string }) {
  const owing = (stats?.items ?? [])
    .filter((it) => it.requireAck && it.pendingNames.length > 0)
    .sort((a, b) => b.pendingNames.length - a.pendingNames.length)
    .slice(0, 3);
  const figures = [
    { label: stats?.published === 1 ? "aviso no período" : "avisos no período", value: stats ? String(stats.published) : "-" },
    { label: "leram", value: stats?.readRate === null || !stats ? "-" : `${stats.readRate}%` },
    { label: "confirmaram o ciente", value: stats?.ackRate === null || !stats ? "-" : `${stats.ackRate}%` },
  ];
  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
          <Megaphone className="h-3.5 w-3.5" /> {boardName}: leitura dos avisos
        </p>
        <Link to="/popup" className="text-xs font-medium text-primary hover:underline">
          Ver em Pop Up › Avisos
        </Link>
      </div>
      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted">Carregando...</p>
      ) : !stats?.published ? (
        <p className="py-8 text-center text-sm text-muted">Nenhum aviso apareceu no período selecionado.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="grid grid-cols-3 gap-2">
            {figures.map((f) => (
              <div key={f.label} className="rounded-card bg-surface-alt p-3">
                <p className="text-2xl font-semibold">{f.value}</p>
                <p className="text-xs text-muted">{f.label}</p>
              </div>
            ))}
            <div className="col-span-3 space-y-1.5">
              {stats.items.slice(0, 4).map((it) => {
                const pct = it.audience ? Math.round((it.read / it.audience) * 100) : 0;
                return (
                  <div key={it.id}>
                    <div className="flex justify-between text-xs">
                      <span className="truncate pr-2">{it.title}</span>
                      <span className="shrink-0 text-muted">
                        {it.read}/{it.audience}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-alt">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: KIND_STYLE[it.kind].solid }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold">Aguardando o ciente</p>
            {owing.length === 0 ? (
              <p className="text-sm text-muted">{stats.items.some((it) => it.requireAck) ? "Todos confirmaram." : "Nenhum aviso do período pedia confirmação."}</p>
            ) : (
              <ul className="space-y-2">
                {owing.map((it) => (
                  <li key={it.id} className="rounded-card border border-border p-2.5">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <ShieldCheck className="h-4 w-4 shrink-0 text-warning" /> <span className="truncate">{it.title}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {it.pendingNames.length} de {it.audience}: {it.pendingNames.slice(0, 6).join(", ")}
                      {it.pendingNames.length > 6 ? ` e mais ${it.pendingNames.length - 6}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
