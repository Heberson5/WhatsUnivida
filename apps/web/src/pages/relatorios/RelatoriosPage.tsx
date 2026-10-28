import { useCallback, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ArrivalsByHourDTO, AutoMessageBlocksReportDTO } from "@whatsatendende/types";
import { ChevronDown, Download, FileSpreadsheet, FileText } from "lucide-react";
import { api } from "../../lib/api";
import { PeriodFilter, type PeriodValue } from "../../components/common/PeriodFilter";
import { ConnectionFilter } from "../../components/common/ConnectionFilter";
import { SatisfactionReport } from "../../components/reports/SatisfactionReport";
import { AutoMessageBlocksReport } from "../../components/reports/AutoMessageBlocksReport";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";
import { ArrivalsByHourChart } from "../../components/dashboard/ArrivalsByHourChart";
import { formatHour, type HourRange } from "../../components/dashboard/HourRangeMenu";
import { useAuthStore } from "../../store/auth-store";
import { useBranding } from "../../hooks/useBranding";

type ReportKind = "attendance" | "per-agent" | "messages" | "arrivals" | "satisfaction" | "auto-message-blocks";

const TABS: { key: ReportKind; label: string }[] = [
  { key: "attendance", label: "Atendimentos" },
  { key: "per-agent", label: "Por atendente" },
  { key: "messages", label: "Mensagens" },
  { key: "arrivals", label: "Chegadas por hora" },
  { key: "satisfaction", label: "Pesquisa de satisfação" },
  { key: "auto-message-blocks", label: "Mensagens bloqueadas" },
];

const EXPORT_FORMATS: { key: "csv" | "pdf" | "xlsx"; label: string; icon: typeof Download }[] = [
  { key: "csv", label: "CSV", icon: Download },
  { key: "pdf", label: "PDF", icon: FileText },
  { key: "xlsx", label: "Excel (XLSX)", icon: FileSpreadsheet },
];

// The satisfaction exports are keyed by their file's column titles (satisfaction-report.service.ts) — each on-screen
// column of the two satisfaction tables maps to the file columns it shows.
const SATISFACTION_EXPORT_COLUMNS: Record<"agents" | "responses", Record<string, string[]>> = {
  agents: {
    agent: ["Atendente"],
    sent: ["Pesquisas enviadas"],
    answered: ["Respostas"],
    unanswered: ["Não responderam"],
    rate: ["Taxa de resposta (%)"],
    average: ["Nota média"],
    nps: ["NPS (0 a 100)"],
    variation: ["NPS no período anterior"],
    promoters: ["Promotores"],
    passives: ["Neutros"],
    detractors: ["Detratores"],
    range: ["Menor nota", "Maior nota"],
  },
  responses: {
    date: ["Enviada em", "Respondida em"],
    client: ["Cliente", "Telefone"],
    agent: ["Atendente"],
    connection: ["Conexão"],
    score: ["Nota"],
    answer: ["Resposta do cliente"],
    category: ["Classificação"],
  },
};

export default function RelatoriosPage() {
  const [tab, setTab] = useState<ReportKind>("attendance");
  const [period, setPeriod] = useState<PeriodValue>({ period: "month" });
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  // Each tabular report has its own column view (⋮ in the table header) — it
  // drives both the on-screen table and every export format.
  const attendanceView = useColumnView("relatorioAtendimentos");
  const perAgentView = useColumnView("relatorioPorAtendente");
  const columnView = tab === "per-agent" ? perAgentView : attendanceView;
  const satisfactionAgentsView = useColumnView("relatorioSatisfacaoAtendentes");
  const satisfactionResponsesView = useColumnView("relatorioSatisfacaoRespostas");

  const { data, isLoading } = useQuery({
    queryKey: ["report", tab, period, connectionIds],
    queryFn: async () => {
      const res = await api.get(`/reports/${tab}`, {
        params: {
          period: period.period,
          from: period.from,
          to: period.to,
          connectionId: connectionIds.length ? connectionIds : undefined,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      });
      return res.data;
    },
    // The satisfaction tab has its own screen and query (SatisfactionReport).
    enabled: tab !== "satisfaction",
  });

  const rows: Record<string, unknown>[] = Array.isArray(data) ? data : [];
  const visibleColumns = columnView.visibleKeys;

  // See PROMPT: "Relatórios poder extrair em PDF e em xlsx" — alongside the
  // pre-existing CSV export, same three formats on every tab.
  async function download(format: "csv" | "pdf" | "xlsx", satisfactionTable?: "responses" | "agents") {
    setExportMenuOpen(false);
    const res = await api.get(`/reports/${tab}`, {
      params: {
        period: period.period,
        from: period.from,
        to: period.to,
        connectionId: connectionIds.length ? connectionIds : undefined,
        format,
        // Chegadas por hora exports every column of its table.
        columns: tab === "arrivals" || tab === "auto-message-blocks"
          ? undefined
          : satisfactionTable
          ? (satisfactionTable === "agents" ? satisfactionAgentsView : satisfactionResponsesView).visibleKeys
              .flatMap((key) => SATISFACTION_EXPORT_COLUMNS[satisfactionTable][key])
              .join(",")
          : visibleColumns.join(","),
        table: satisfactionTable,
        // The export is what is on screen: the attendant chosen next to the period, too.
        agentId: satisfactionTable && satisfactionAgentId !== "all" ? satisfactionAgentId : undefined,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      },
      responseType: "blob",
    });
    const url = window.URL.createObjectURL(new Blob([res.data]));
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", satisfactionTable ? `relatorio-pesquisa-${satisfactionTable === "agents" ? "por-atendente" : "respostas"}.${format}` : `relatorio-${tab}.${format}`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }

  // Pesquisa de satisfação: the attendant filter sits next to the period. It lists whoever was rated, and keeps the
  // one selected while the report narrows to them.
  const [satisfactionAgentId, setSatisfactionAgentId] = useState("all");
  const [satisfactionAgents, setSatisfactionAgents] = useState<{ id: string; name: string }[]>([]);
  const rememberSatisfactionAgents = useCallback((agents: { id: string; name: string }[]) => {
    setSatisfactionAgents((prev) => {
      const merged = new Map([...prev, ...agents].map((a) => [a.id, a]));
      if (merged.size === prev.length) return prev;
      return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    });
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {/* On a phone the tabs don't fit: the bar scrolls sideways instead of cutting the last ones off. */}
        <div className="shadow-soft flex max-w-full gap-1 overflow-x-auto rounded-card border border-border bg-surface p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 whitespace-nowrap rounded-card px-3 py-1.5 text-sm font-medium ${tab === t.key ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          {tab === "satisfaction" && (
            <select
              value={satisfactionAgentId}
              onChange={(e) => setSatisfactionAgentId(e.target.value)}
              aria-label="Filtrar por atendente"
              className="focus-ring rounded-card border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="all">Todos os atendentes</option>
              {satisfactionAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <ConnectionFilter value={connectionIds} onChange={setConnectionIds} />
          <div className="relative">
            <button
              onClick={() => setExportMenuOpen((o) => !o)}
              className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-3 py-2 text-sm font-medium hover:bg-surface-alt"
            >
              <Download className="h-4 w-4" /> Exportar <ChevronDown className="h-3.5 w-3.5 text-muted" />
            </button>
            {exportMenuOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" onClick={() => setExportMenuOpen(false)} aria-label="Fechar menu de exportação" />
                <div className={`shadow-soft absolute right-0 top-full z-20 mt-1 rounded-card border border-border bg-surface p-1 ${tab === "satisfaction" ? "w-60" : "w-44"}`}>
                  {tab === "satisfaction" ? (
                    (
                      [
                        { table: "responses", label: "Respostas (cliente e nota)" },
                        { table: "agents", label: "Notas por atendente" },
                      ] as const
                    ).map((group) => (
                      <div key={group.table} className="py-1">
                        <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.label}</p>
                        {EXPORT_FORMATS.map((f) => (
                          <button
                            key={f.key}
                            onClick={() => download(f.key, group.table)}
                            className="focus-ring flex w-full items-center gap-2 rounded-card px-2.5 py-1.5 text-left text-sm hover:bg-surface-alt"
                          >
                            <f.icon className="h-4 w-4 text-muted" /> {f.label}
                          </button>
                        ))}
                      </div>
                    ))
                  ) : (
                    EXPORT_FORMATS.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => download(f.key)}
                        className="focus-ring flex w-full items-center gap-2 rounded-card px-2.5 py-2 text-left text-sm hover:bg-surface-alt"
                      >
                        <f.icon className="h-4 w-4 text-muted" /> {f.label}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {tab === "messages" && data && (
        <div className="grid grid-cols-3 gap-4">
          {Object.entries(data as Record<string, number>).map(([key, value]) => (
            <div key={key} className="shadow-soft rounded-card border border-border bg-surface p-4">
              <p className="text-xs uppercase text-muted">{key}</p>
              <p className="mt-1 text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </div>
      )}

      {tab === "satisfaction" && (
        <SatisfactionReport period={period} connectionIds={connectionIds} agentId={satisfactionAgentId} onAgentsLoaded={rememberSatisfactionAgents} />
      )}

      {tab === "arrivals" && <ArrivalsReport data={data as ArrivalsByHourDTO | undefined} isLoading={isLoading} isToday={period.period === "today"} />}

      {tab === "auto-message-blocks" && <AutoMessageBlocksReport data={data as AutoMessageBlocksReportDTO | undefined} isLoading={isLoading} />}

      {tab !== "messages" && tab !== "satisfaction" && tab !== "arrivals" && tab !== "auto-message-blocks" && (
        <div className="shadow-soft flex-1 overflow-auto rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-0 py-3 pl-2 pr-0">
                  <ColumnViewMenu view={columnView} />
                </th>
                {visibleColumns.map((key) => (
                  <th key={key} className="whitespace-nowrap px-4 py-3">
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="px-4 py-8 text-center text-muted">
                    Carregando...
                  </td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="px-4 py-8 text-center text-muted">
                    Nenhum dado para o período selecionado.
                  </td>
                </tr>
              )}
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-border hover:bg-surface-alt">
                  <td className="w-0 p-0" />
                  {visibleColumns.map((key) => (
                    <td key={key} className="whitespace-nowrap px-4 py-2.5">
                      {String(row[key] ?? "-")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Relatórios › Chegadas por hora: the Dashboard's chart (same saved range) and the hour-by-hour table the exports carry. */
function ArrivalsReport({ data, isLoading, isToday }: { data: ArrivalsByHourDTO | undefined; isLoading: boolean; isToday: boolean }) {
  const user = useAuthStore((s) => s.user);
  const updateArrivalsChartHours = useAuthStore((s) => s.updateArrivalsChartHours);
  const { data: branding } = useBranding();
  const primaryColor = branding?.primaryColor ?? "#0097B4";
  const saveDefault = useMutation({
    mutationFn: (range: HourRange | null) => api.patch("/settings/arrivals-chart-hours", { startHour: range?.start ?? null, endHour: range?.end ?? null }),
    onSuccess: (_res, range) => updateArrivalsChartHours(range?.start ?? null, range?.end ?? null),
  });
  const decimal = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return (
    <div className="flex-1 space-y-4 overflow-auto">
      <ArrivalsByHourChart
        data={data}
        isLoading={isLoading}
        isToday={isToday}
        primaryColor={primaryColor}
        initialRange={user?.arrivalsChartStartHour != null && user?.arrivalsChartEndHour != null ? { start: user.arrivalsChartStartHour, end: user.arrivalsChartEndHour } : null}
        onSaveDefaultRange={(range) => saveDefault.mutate(range)}
      />
      <div className="shadow-soft overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {["Hora", "Dentro do expediente", "Fora do expediente", "Total", "Média por dia", "Atendentes online (média)"].map((label) => (
                <th key={label} className="whitespace-nowrap px-4 py-3">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.hours ?? []).map((h) => (
              <tr key={h.hour} className="border-t border-border hover:bg-surface-alt">
                <td className="px-4 py-2 font-medium tabular-nums">{formatHour(h.hour)}</td>
                <td className="px-4 py-2 tabular-nums">{h.inside}</td>
                <td className="px-4 py-2 tabular-nums">{h.outside}</td>
                <td className="px-4 py-2 font-semibold tabular-nums">{h.inside + h.outside}</td>
                <td className="px-4 py-2 tabular-nums">{h.days ? decimal((h.inside + h.outside) / h.days) : "0"}</td>
                <td className="px-4 py-2 tabular-nums">{decimal(h.onlineAvg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
