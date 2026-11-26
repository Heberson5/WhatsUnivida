import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { Clock, Copy, Download, Eye, Globe, LogIn, RadioTower, UserPlus, Users, Undo2 } from "lucide-react";
import type { SiteAnalyticsLiveDTO, SiteAnalyticsSummaryDTO, SiteVisitDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { downloadFile } from "../../lib/download";
import { useBranding } from "../../hooks/useBranding";
import { PeriodFilter, type PeriodValue } from "../../components/common/PeriodFilter";
import { StatCard, compareWithPrevious } from "../../components/common/StatCard";
import { SeriesChartCard } from "../../components/dashboard/SeriesChartCard";
import { DistributionChartCard } from "../../components/dashboard/DistributionChartCard";
import { NEUTRAL_SERIES_COLOR, seriesPalette } from "../../lib/chart-theme";

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/** "1 min 25 s", "48 s", "2 h 05 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const s = Math.round(seconds % 60);
    return `${Math.floor(seconds / 60)} min${s ? ` ${s} s` : ""}`;
  }
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")} min`;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const card = "shadow-soft rounded-card border border-border bg-surface";

/**
 * Administração › Acessos ao site (administrador): visits to the public page — the login screen and any site with the
 * tracking snippet — with time on the page, where visitors came from, their devices and who is on it right now.
 */
export default function AcessosSitePage() {
  const queryClient = useQueryClient();
  const { data: branding } = useBranding();
  const primary = branding?.effective?.primaryColor ?? branding?.primaryColor ?? "#0097B4";
  const secondary = branding?.effective?.secondaryColor ?? branding?.secondaryColor ?? "#FFE450";
  const palette = seriesPalette(primary, secondary);
  const [period, setPeriod] = useState<PeriodValue>({ period: "last7days" });
  const [site, setSite] = useState("");
  const [page, setPage] = useState(1);
  const params = { period: period.period, from: period.from, to: period.to, site: site || undefined, tzOffsetMinutes: new Date().getTimezoneOffset() };

  const { data: summary, isLoading } = useQuery({
    queryKey: ["site-analytics", "summary", params],
    queryFn: async () => (await api.get<SiteAnalyticsSummaryDTO>("/site-analytics/summary", { params })).data,
  });
  const { data: live } = useQuery({
    queryKey: ["site-analytics", "live", site],
    queryFn: async () => (await api.get<SiteAnalyticsLiveDTO>("/site-analytics/live", { params: { site: site || undefined } })).data,
    refetchInterval: 15_000,
  });
  const { data: visits } = useQuery({
    queryKey: ["site-analytics", "visits", params, page],
    queryFn: async () => (await api.get<{ total: number; page: number; pageSize: number; visits: SiteVisitDTO[] }>("/site-analytics/visits", { params: { ...params, page, pageSize: 50 } })).data,
  });
  const { data: settings } = useQuery({
    queryKey: ["site-analytics", "settings"],
    queryFn: async () => (await api.get<{ retentionDays: number }>("/site-analytics/settings")).data,
  });
  const [retention, setRetention] = useState<number | null>(null);
  const saveRetention = useMutation({
    mutationFn: () => api.put("/site-analytics/settings", { retentionDays: retention }),
    onSuccess: () => {
      toast.success("Prazo de guarda salvo");
      setRetention(null);
      void queryClient.invalidateQueries({ queryKey: ["site-analytics", "settings"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const snippet = `<script async src="${window.location.origin}/api/public/site/tracker.js"></script>`;
  const t = summary?.totals;
  const days = (summary?.byDay ?? []).map((d) => ({ dia: format(new Date(`${d.day}T12:00:00`), "dd/MM"), Visitas: d.visits, Visitantes: d.visitors }));
  const hours = (summary?.byHour ?? []).map((v, h) => ({ hora: `${String(h).padStart(2, "0")}h`, Visitas: v }));
  const weekdays = (summary?.byWeekday ?? []).map((v, i) => ({ dia: WEEKDAYS[i], Visitas: v }));
  const dist = (rows?: { key: string; visits: number }[]) => (rows ?? []).map((r) => ({ name: r.key, value: r.visits }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Acessos ao site</h1>
          <p className="text-sm text-muted">Visitas à página pública: a tela de entrada do sistema e os sites com o código de acompanhamento.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(summary?.sites.length ?? 0) > 1 && (
            <select
              value={site}
              onChange={(e) => {
                setSite(e.target.value);
                setPage(1);
              }}
              className="focus-ring rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px]"
              aria-label="Site"
            >
              <option value="">Todos os sites</option>
              {summary!.sites.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
          <PeriodFilter
            value={period}
            onChange={(v) => {
              setPeriod(v);
              setPage(1);
            }}
            segmented
          />
          <button
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium hover:bg-surface-alt"
            onClick={() => void downloadFile(`/site-analytics/export?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`, "acessos-ao-site.xlsx").catch((err) => toast.error(getApiErrorMessage(err)))}
          >
            <Download className="h-4 w-4" /> Excel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Agora no site" value={live?.now ?? 0} icon={RadioTower} hint="Com a página aberta no último minuto" />
        <StatCard label="Visitas" value={t?.visits ?? 0} icon={Eye} delta={t && summary ? compareWithPrevious(t.visits, summary.previous.visits, false, "período anterior", true) : null} />
        <StatCard label="Visitantes" value={t?.visitors ?? 0} icon={Users} delta={t && summary ? compareWithPrevious(t.visitors, summary.previous.visitors, false, "período anterior", true) : null} />
        <StatCard label="Novos visitantes" value={t?.newVisitors ?? 0} icon={UserPlus} hint="Primeira visita neste período" />
        <StatCard
          label="Tempo médio na página"
          value={t ? formatDuration(t.avgDurationSeconds) : "—"}
          icon={Clock}
          delta={t && summary ? compareWithPrevious(t.avgDurationSeconds, summary.previous.avgDurationSeconds) : null}
          hint="Só o tempo com a aba à vista"
        />
        <StatCard
          label={t?.loginRate !== null && t?.loginRate !== undefined ? "Entraram no sistema" : "Saíram em menos de 10 s"}
          value={t ? (t.loginRate !== null ? percent(t.loginRate) : percent(t.bounceRate)) : "—"}
          icon={t?.loginRate !== null ? LogIn : Undo2}
          hint={t?.loginRate !== null && t ? `Das visitas à tela de entrada · ${percent(t.bounceRate)} saíram em menos de 10 s` : undefined}
        />
      </div>

      {isLoading && <p className="text-sm text-muted">Carregando…</p>}
      {summary && (
        <>
          <SeriesChartCard
            title="Visitas por dia"
            data={days}
            categoryKey="dia"
            defaultKind="area"
            series={[
              { key: "Visitas", name: "Visitas", color: primary },
              { key: "Visitantes", name: "Visitantes", color: secondary },
            ]}
          />
          <div className="grid gap-5 lg:grid-cols-2">
            <SeriesChartCard title="Visitas por hora do dia" data={hours} categoryKey="hora" series={[{ key: "Visitas", name: "Visitas", color: primary }]} />
            <SeriesChartCard title="Visitas por dia da semana" data={weekdays} categoryKey="dia" series={[{ key: "Visitas", name: "Visitas", color: primary }]} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <DistributionChartCard title="Aparelhos" data={dist(summary.devices)} colors={palette} />
            <DistributionChartCard title="Navegadores" data={dist(summary.browsers)} colors={palette} />
            <DistributionChartCard title="Sistemas" data={dist(summary.systems)} colors={[...palette, NEUTRAL_SERIES_COLOR]} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <RankCard title="Páginas mais visitadas" rows={summary.pages.map((p) => ({ label: p.path, value: p.visits, extra: formatDuration(p.avgDurationSeconds) }))} extraLabel="Tempo médio" />
            <RankCard title="De onde vieram" rows={summary.referrers.map((r) => ({ label: r.key, value: r.visits }))} />
            <RankCard title="Cidades" rows={summary.places.map((r) => ({ label: r.key, value: r.visits }))} />
            <RankCard title="Campanhas (utm)" rows={summary.campaigns.map((r) => ({ label: r.key, value: r.visits }))} empty="Nenhuma visita veio de link com utm_source / utm_campaign." />
          </div>
        </>
      )}

      <section className={`${card} p-4`}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <RadioTower className="h-4 w-4 text-primary" /> No site agora ({live?.now ?? 0})
        </h2>
        <VisitsTable visits={live?.visits ?? []} empty="Ninguém com a página aberta no último minuto." live />
      </section>

      <section className={`${card} p-4`}>
        <h2 className="text-sm font-semibold">Visitas do período</h2>
        <VisitsTable visits={visits?.visits ?? []} empty="Nenhuma visita no período." />
        {visits && visits.total > visits.pageSize && (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs">
            <span className="text-muted">
              {(page - 1) * visits.pageSize + 1}–{Math.min(page * visits.pageSize, visits.total)} de {visits.total}
            </span>
            <button className="focus-ring rounded border border-border px-2 py-1 disabled:opacity-50" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Anterior
            </button>
            <button className="focus-ring rounded border border-border px-2 py-1 disabled:opacity-50" disabled={page * visits.pageSize >= visits.total} onClick={() => setPage(page + 1)}>
              Próxima
            </button>
          </div>
        )}
      </section>

      <section className={`${card} space-y-3 p-4`}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Globe className="h-4 w-4 text-primary" /> Acompanhar outro site
        </h2>
        <p className="text-xs text-muted">
          A tela de entrada deste sistema já é acompanhada. Para acompanhar outro site (o site institucional, uma página de campanha), cole esta linha no HTML dele, antes de{" "}
          <code>&lt;/body&gt;</code>. As visitas aparecem aqui, com o nome do site.
        </p>
        <div className="flex gap-2">
          <input readOnly value={snippet} className="focus-ring w-full rounded-card border border-border bg-surface-alt px-3 py-2 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Código de acompanhamento" />
          <button
            className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-card border border-border px-3 py-2 text-xs font-medium hover:bg-surface-alt"
            onClick={() => void navigator.clipboard?.writeText(snippet).then(() => toast.success("Código copiado"))}
          >
            <Copy className="h-4 w-4" /> Copiar
          </button>
        </div>
        <p className="text-xs text-muted">
          Privacidade: as visitas são anônimas — nenhum nome, nenhum cookie e o IP não é guardado (só a cidade aproximada). Quem tem o navegador com “Não rastrear” não é contado.
        </p>
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Guardar as visitas por (dias)</span>
            <input
              type="number"
              min={30}
              max={1825}
              value={retention ?? settings?.retentionDays ?? 365}
              onChange={(e) => setRetention(Number(e.target.value))}
              className="focus-ring w-32 rounded-card border border-border bg-transparent px-3 py-1.5 text-sm"
            />
          </label>
          <button
            className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt disabled:opacity-50"
            disabled={retention === null || retention < 30 || retention > 1825 || saveRetention.isPending}
            onClick={() => saveRetention.mutate()}
          >
            Salvar
          </button>
          <span className="text-xs text-muted">As mais antigas são apagadas sozinhas (de 30 a 1825 dias).</span>
        </div>
      </section>
    </div>
  );
}

function RankCard({ title, rows, extraLabel, empty = "Sem dados no período." }: { title: string; rows: { label: string; value: number; extra?: string }[]; extraLabel?: string; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className={`${card} p-4`}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {rows.length === 0 && <p className="text-xs text-muted">{empty}</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate" title={r.label}>
                {r.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted">
                {r.value.toLocaleString("pt-BR")}
                {r.extra && ` · ${extraLabel ?? ""} ${r.extra}`}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-primary" style={{ width: `${(r.value / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VisitsTable({ visits, empty, live = false }: { visits: SiteVisitDTO[]; empty: string; live?: boolean }) {
  if (!visits.length) return <p className="mt-2 text-xs text-muted">{empty}</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1.5 pr-3 font-medium">{live ? "Desde" : "Início"}</th>
            <th className="py-1.5 pr-3 font-medium">Página</th>
            <th className="py-1.5 pr-3 font-medium">Tempo</th>
            <th className="py-1.5 pr-3 font-medium">Origem</th>
            <th className="py-1.5 pr-3 font-medium">Aparelho</th>
            <th className="py-1.5 pr-3 font-medium">Local</th>
            <th className="py-1.5 font-medium">Visitante</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => (
            <tr key={v.id} className="border-t border-border">
              <td className="py-1.5 pr-3 tabular-nums">{format(new Date(v.startedAt), live ? "HH:mm" : "dd/MM HH:mm")}</td>
              <td className="max-w-[220px] truncate py-1.5 pr-3" title={`${v.site}${v.path}`}>
                {v.path}
                <span className="block text-[11px] text-muted">{v.site}</span>
              </td>
              <td className="py-1.5 pr-3 tabular-nums">{formatDuration(v.durationSeconds)}</td>
              <td className="py-1.5 pr-3">{v.campaign ?? v.referrer ?? "Acesso direto"}</td>
              <td className="py-1.5 pr-3">{[v.device, v.browser, v.os].filter(Boolean).join(" · ")}</td>
              <td className="py-1.5 pr-3">{v.place ?? "—"}</td>
              <td className="py-1.5">
                {v.returning ? "Retorno" : "Nova"}
                {v.loggedIn && <span className="ml-1 rounded bg-primary/10 px-1 text-primary">entrou</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
