import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Eye, Search } from "lucide-react";
import clsx from "clsx";
import { toast } from "sonner";
import { NPS_SMALL_SAMPLE, PERMISSION, columnLabel, type ConversationListItemDTO, type SatisfactionCategory, type SatisfactionReportDTO, type SatisfactionResponseDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { formatPhone } from "../../lib/format-phone";
import { npsDelta, npsZone } from "../../lib/dashboardMetrics";
import { CHART_CARD_SHADOW, CHART_TOOLTIP_PROPS } from "../../lib/chart-theme";
import { ReadOnlyConversationDrawer } from "../gestao/ReadOnlyConversationDrawer";
import type { PeriodValue } from "../common/PeriodFilter";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";
import { useAuthStore } from "../../store/auth-store";
import { ChartTypeMenu } from "../dashboard/ChartTypeMenu";
import { SERIES_KIND_OPTIONS, type SeriesKind } from "../dashboard/SeriesChartCard";

const formatNps = (nps: number | null) => (nps === null ? "–" : String(nps));
const DELTA_TONE = { up: "text-success", down: "text-danger", same: "text-muted" } as const;

/** "▲ 6 pontos" against the period before, colored — nothing when either side had no answers. */
function Delta({ current, previous, className }: { current: number | null; previous: number | null; className?: string }) {
  const delta = npsDelta(current, previous);
  if (!delta) return null;
  return (
    <span className={clsx("whitespace-nowrap font-semibold", DELTA_TONE[delta.tone], className)} title={`Período anterior: ${previous}`}>
      {delta.text}
    </span>
  );
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const formatAverage = (v: number | null) => (v === null ? "–" : v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

const CATEGORY: Record<SatisfactionCategory, { label: string; chip: string; color: string }> = {
  promoter: { label: "Promotor", chip: "bg-success-soft text-success", color: "var(--color-success)" },
  passive: { label: "Neutro", chip: "bg-warning-soft text-warning", color: "var(--color-warning)" },
  detractor: { label: "Detrator", chip: "bg-danger-soft text-danger", color: "var(--color-danger)" },
};
const ZONE_TEXT = { success: "text-success", primary: "text-primary", warning: "text-warning", danger: "text-danger" } as const;
const npsTone = (nps: number | null) => (nps === null ? "text-muted" : ZONE_TEXT[npsZone(nps).tone]);

type ResponseFilter = "answered" | SatisfactionCategory | "unanswered" | "review";
const RESPONSE_FILTERS: { key: ResponseFilter; label: string }[] = [
  { key: "answered", label: "Respondidas" },
  { key: "detractor", label: "Detratores (0–6)" },
  { key: "passive", label: "Neutros (7–8)" },
  { key: "promoter", label: "Promotores (9–10)" },
  { key: "unanswered", label: "Sem resposta" },
  { key: "review", label: "Para revisar" },
];

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–";
}

function Kpi({ label, value, detail, tone, extra }: { label: string; value: string; detail?: string; tone?: string; extra?: ReactNode }) {
  return (
    <div className={clsx("rounded-card border border-border bg-surface p-4", CHART_CARD_SHADOW)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={clsx("mt-1 text-3xl font-semibold tabular-nums", tone)}>{value}</p>
      {detail && <p className="mt-0.5 text-xs text-muted">{detail}</p>}
      {extra && <div className="mt-1 text-xs">{extra}</div>}
    </div>
  );
}

/**
 * Relatórios › Pesquisa de satisfação: NPS and average of the period, the 0–10 spread, how it moved, each
 * attendant and each connection, and every answer with the customer — each one opens the conversation that
 * was rated. See PROMPT: "relatório somente das pesquisas, podendo saber de qual cliente foi a nota e poder
 * olhar a conversa avaliada, poder saber as notas que cada atendente recebe".
 */
/**
 * The attendant filter lives in the page's top bar, next to the period (see RelatoriosPage) — this reports who was
 * rated in the period through `onAgentsLoaded`, so the list keeps whoever is selected.
 */
export function SatisfactionReport({
  period,
  connectionIds,
  agentId,
  onAgentsLoaded,
}: {
  period: PeriodValue;
  connectionIds: string[];
  agentId: string;
  onAgentsLoaded: (agents: { id: string; name: string }[]) => void;
}) {
  const columnView = useColumnView("relatorioSatisfacaoAtendentes");
  const responsesView = useColumnView("relatorioSatisfacaoRespostas");
  const [distributionKind, setDistributionKind] = useState<SeriesKind>("bar");
  const [trendKind, setTrendKind] = useState<SeriesKind>("line");
  const [filter, setFilter] = useState<ResponseFilter>("answered");
  const [search, setSearch] = useState("");
  const [openConversation, setOpenConversation] = useState<ConversationListItemDTO | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["report", "satisfaction", period, connectionIds, agentId],
    queryFn: async () =>
      (
        await api.get<SatisfactionReportDTO>("/reports/satisfaction", {
          params: {
            period: period.period,
            from: period.from,
            to: period.to,
            connectionId: connectionIds.length ? connectionIds : undefined,
            agentId: agentId === "all" ? undefined : agentId,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          },
        })
      ).data,
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    const rated = (data?.byAgent ?? []).filter((a) => a.agentId).map((a) => ({ id: a.agentId!, name: a.agentName }));
    if (rated.length) onAgentsLoaded(rated);
  }, [data, onAgentsLoaded]);

  const canCorrect = useAuthStore((s) => s.permissions?.[PERMISSION.RELATORIOS_PESQUISA_CORRIGIR]);
  const queryClient = useQueryClient();
  const correctMutation = useMutation({
    mutationFn: ({ surveyId, score }: { surveyId: string; score: number }) => api.patch(`/reports/satisfaction/${surveyId}/score`, { score }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report", "satisfaction"] });
      toast.success("Nota corrigida.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const openMutation = useMutation({
    mutationFn: async (conversationId: string) => (await api.get<ConversationListItemDTO>(`/conversations/${conversationId}`)).data,
    onSuccess: setOpenConversation,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const responses = (data?.responses ?? []).filter((r) => {
    const byFilter =
      filter === "answered"
        ? r.status === "answered"
        : filter === "unanswered"
          ? r.status !== "answered"
          : filter === "review"
            ? r.rereadScore !== null
            : r.category === filter;
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    const bySearch = !q || (r.contactName ?? "").toLowerCase().includes(q) || (digits.length > 0 && (r.contactPhone ?? "").includes(digits));
    return byFilter && bySearch;
  });

  if (isLoading && !data) return <p className="py-10 text-center text-sm text-muted">Carregando...</p>;
  if (!data || data.totals.sent === 0) {
    return <p className="py-10 text-center text-sm text-muted">Nenhuma pesquisa de satisfação enviada no período selecionado.</p>;
  }

  const { totals, previous, settings } = data;
  const goal = settings.npsGoal;
  const zone = totals.nps === null ? null : npsZone(totals.nps);
  const distribution = totals.distribution.map((count, score) => ({ score: String(score), count, category: (score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor") as SatisfactionCategory }));

  return (
    <div className="flex-1 space-y-4 overflow-y-auto pb-4">
      <p className="text-xs text-muted">
        NPS de 0 a 100: 0 quando todos são detratores, 50 quando promotores e detratores empatam, 100 quando todos são promotores. Comparado com o
        período anterior de mesmo tamanho ({shortDate(data.previous.from)} a {shortDate(data.previous.to)}). Só as pesquisas de nota de 0 a 10.
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="NPS (0 a 100)"
          value={formatNps(totals.nps)}
          detail={zone?.label ?? "sem respostas"}
          tone={npsTone(totals.nps)}
          extra={
            <span className="flex flex-wrap gap-x-2">
              <Delta current={totals.nps} previous={previous.nps} />
              {goal !== null && totals.nps !== null && (
                <span className={totals.nps >= goal ? "text-success" : "text-danger"}>
                  {totals.nps >= goal ? "acima" : "abaixo"} da meta ({goal})
                </span>
              )}
            </span>
          }
        />
        <Kpi
          label="Nota média"
          value={formatAverage(totals.average)}
          detail={`de 0 a 10 · antes ${formatAverage(previous.average)}`}
        />
        <Kpi
          label="Respostas"
          value={totals.answered.toLocaleString("pt-BR")}
          detail={`de ${totals.sent.toLocaleString("pt-BR")} enviadas · ${totals.responseRate ?? 0}%${totals.awaiting ? ` · ${totals.awaiting} aguardando` : ""} · antes ${previous.answered.toLocaleString("pt-BR")}`}
        />
        <div className={clsx("rounded-card border border-border bg-surface p-4", CHART_CARD_SHADOW)}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Promotores · Neutros · Detratores</p>
          <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-surface-alt" role="img" aria-label={`Promotores ${totals.promoters}, neutros ${totals.passives}, detratores ${totals.detractors}`}>
            <span className="h-full bg-success" style={{ width: `${percent(totals.promoters, totals.answered)}%` }} />
            <span className="h-full bg-warning" style={{ width: `${percent(totals.passives, totals.answered)}%` }} />
            <span className="h-full bg-danger" style={{ width: `${percent(totals.detractors, totals.answered)}%` }} />
          </div>
          <p className="mt-2 text-xs tabular-nums">
            <span className="font-semibold text-success">{percent(totals.promoters, totals.answered)}%</span>
            <span className="text-muted"> · </span>
            <span className="font-semibold text-warning">{percent(totals.passives, totals.answered)}%</span>
            <span className="text-muted"> · </span>
            <span className="font-semibold text-danger">{percent(totals.detractors, totals.answered)}%</span>
          </p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className={clsx("rounded-card border border-border bg-surface p-4", CHART_CARD_SHADOW)} aria-label="Notas de 0 a 10">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Notas de 0 a 10</h3>
            <ChartTypeMenu value={distributionKind} onChange={setDistributionKind} options={SERIES_KIND_OPTIONS} />
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={distribution} margin={{ top: 16, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="score" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(v: number) => [v, "Respostas"]} labelFormatter={(l) => `Nota ${l}`} />
                {distributionKind === "line" ? (
                  <Line type="monotone" dataKey="count" stroke="var(--color-primary)" strokeWidth={2.5} dot={{ r: 3.5 }} />
                ) : distributionKind === "area" ? (
                  <Area type="monotone" dataKey="count" stroke="var(--color-primary)" fill="var(--color-primary)" fillOpacity={0.25} />
                ) : (
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} label={{ position: "top", fontSize: 11, formatter: (v: number) => (v ? v : "") }}>
                    {distribution.map((d) => (
                      <Cell key={d.score} fill={CATEGORY[d.category].color} />
                    ))}
                  </Bar>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className={clsx("rounded-card border border-border bg-surface p-4", CHART_CARD_SHADOW)} aria-label="Evolução do NPS">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Evolução do NPS no período</h3>
            <ChartTypeMenu value={trendKind} onChange={setTrendKind} options={SERIES_KIND_OPTIONS} />
          </div>
          {data.trend.length < 2 ? (
            <p className="flex h-56 items-center justify-center text-sm text-muted">A evolução aparece quando há respostas em mais de um dia.</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data.trend} margin={{ top: 16, right: 12, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fontSize: 11 }} />
                  {goal !== null && (
                    <ReferenceLine
                      y={goal}
                      stroke="var(--color-success)"
                      strokeDasharray="6 4"
                      label={{ value: `Meta ${goal}`, position: "insideTopLeft", fontSize: 11, fill: "var(--color-success)" }}
                    />
                  )}
                  <Tooltip
                    {...CHART_TOOLTIP_PROPS}
                    formatter={(v: number, name: string) => (name === "nps" ? [formatNps(v), "NPS (0 a 100)"] : [v, name])}
                  />
                  {trendKind === "bar" ? (
                    <Bar dataKey="nps" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
                  ) : trendKind === "area" ? (
                    <Area type="linear" dataKey="nps" stroke="var(--color-primary)" fill="var(--color-primary)" fillOpacity={0.25} strokeWidth={2.5} />
                  ) : (
                    <Line type="linear" dataKey="nps" stroke="var(--color-primary)" strokeWidth={2.5} dot={{ r: 3.5 }} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>

      <section className={clsx("overflow-hidden rounded-card border border-border bg-surface", CHART_CARD_SHADOW)} aria-label="Notas por atendente">
        <h3 className="px-4 pb-2 pt-4 text-sm font-semibold">Notas por atendente</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-0 py-2.5 pl-2 pr-0">
                  <ColumnViewMenu view={columnView} />
                </th>
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "agent":
                      return (
                        <th key="agent" className="px-4 py-2.5">Atendente</th>
                      );
                    case "sent":
                      return (
                        <th key="sent" className="px-4 py-2.5 text-right">Pesquisas</th>
                      );
                    case "answered":
                      return (
                        <th key="answered" className="px-4 py-2.5 text-right">Respostas</th>
                      );
                    case "unanswered":
                      return (
                        <th key="unanswered" className="px-4 py-2.5 text-right">Não responderam</th>
                      );
                    case "rate":
                      return (
                        <th key="rate" className="px-4 py-2.5 text-right">Taxa</th>
                      );
                    case "average":
                      return (
                        <th key="average" className="px-4 py-2.5 text-right">Nota média</th>
                      );
                    case "nps":
                      return (
                        <th key="nps" className="px-4 py-2.5 text-right">NPS (0–100)</th>
                      );
                    case "variation":
                      return (
                        <th key="variation" className="px-4 py-2.5 text-right">Variação</th>
                      );
                    case "promoters":
                      return (
                        <th key="promoters" className="px-4 py-2.5 text-right">Promotores</th>
                      );
                    case "passives":
                      return (
                        <th key="passives" className="px-4 py-2.5 text-right">Neutros</th>
                      );
                    case "detractors":
                      return (
                        <th key="detractors" className="px-4 py-2.5 text-right">Detratores</th>
                      );
                    case "range":
                      return (
                        <th key="range" className="px-4 py-2.5 text-right">Menor / maior</th>
                      );
                    default:
                      return null;
                  }
                })}
              </tr>
            </thead>
            <tbody>
              {data.byAgent.map((a) => (
                <tr key={a.agentId ?? "none"} className="border-t border-border">
                  <td className="w-0 p-0" />
                  {columnView.visibleKeys.map((key) => {
                    switch (key) {
                      case "agent":
                        return (
                          <td key="agent" className="px-4 py-2.5 font-medium">
                            {a.agentName}
                            {a.answered > 0 && a.answered < NPS_SMALL_SAMPLE && (
                              <span className="ml-1.5 whitespace-nowrap rounded bg-surface-alt px-1 text-[10px] font-normal text-muted" title="Com poucas respostas, uma nota muda muito o NPS">
                                amostra pequena
                              </span>
                            )}
                          </td>
                        );
                      case "sent":
                        return (
                          <td key="sent" className="px-4 py-2.5 text-right tabular-nums">{a.sent}</td>
                        );
                      case "answered":
                        return (
                          <td key="answered" className="px-4 py-2.5 text-right tabular-nums">{a.answered}</td>
                        );
                      case "unanswered":
                        return (
                          <td key="unanswered" className={clsx("px-4 py-2.5 text-right tabular-nums", a.unanswered > 0 && "font-semibold text-warning")}>{a.unanswered}</td>
                        );
                      case "rate":
                        return (
                          <td key="rate" className="px-4 py-2.5 text-right tabular-nums">{a.responseRate === null ? "–" : `${a.responseRate}%`}</td>
                        );
                      case "average":
                        return (
                          <td key="average" className="px-4 py-2.5 text-right tabular-nums">{formatAverage(a.average)}</td>
                        );
                      case "nps":
                        return (
                          <td key="nps" className={clsx("px-4 py-2.5 text-right font-semibold tabular-nums", npsTone(a.nps))}>{formatNps(a.nps)}</td>
                        );
                      case "variation":
                        return (
                          <td key="variation" className="px-4 py-2.5 text-right text-xs tabular-nums">
                            <Delta current={a.nps} previous={a.previousNps} />
                          </td>
                        );
                      case "promoters":
                        return (
                          <td key="promoters" className="px-4 py-2.5 text-right tabular-nums text-success">{a.promoters}</td>
                        );
                      case "passives":
                        return (
                          <td key="passives" className="px-4 py-2.5 text-right tabular-nums text-warning">{a.passives}</td>
                        );
                      case "detractors":
                        return (
                          <td key="detractors" className="px-4 py-2.5 text-right tabular-nums text-danger">{a.detractors}</td>
                        );
                      case "range":
                        return (
                          <td key="range" className="px-4 py-2.5 text-right tabular-nums text-muted">{a.lowest === null ? "–" : `${a.lowest} / ${a.highest}`}</td>
                        );
                      default:
                        return null;
                    }
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data.byConnection.length > 1 && (
        <section className={clsx("overflow-hidden rounded-card border border-border bg-surface", CHART_CARD_SHADOW)} aria-label="Notas por conexão">
          <h3 className="px-4 pb-2 pt-4 text-sm font-semibold">Notas por conexão</h3>
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
            {data.byConnection.map((c) => (
              <div key={c.connectionId} className="flex items-center justify-between gap-3 bg-surface px-4 py-3">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: c.connectionColor }} />
                  <span className="truncate">{c.connectionName}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted">
                  <span className={clsx("text-base font-semibold tabular-nums", npsTone(c.nps))}>NPS {formatNps(c.nps)}</span>
                  <br />
                  média {formatAverage(c.average)} · {c.answered} de {c.sent}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={clsx("overflow-hidden rounded-card border border-border bg-surface", CHART_CARD_SHADOW)} aria-label="Respostas">
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-4">
          <h3 className="mr-2 text-sm font-semibold">Respostas</h3>
          {RESPONSE_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={clsx(
                "focus-ring rounded-full border px-2.5 py-0.5 text-xs font-medium",
                filter === f.key ? "border-primary bg-primary/10 text-primary" : "border-border text-muted hover:text-[var(--color-text)]"
              )}
            >
              {f.label}
            </button>
          ))}
          <label className="ml-auto flex h-8 min-w-[200px] items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-muted focus-within:border-primary/50">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar cliente"
              aria-label="Buscar cliente nas respostas"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text)] outline-none placeholder:text-muted"
            />
          </label>
        </div>
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-0 py-2.5 pl-2 pr-0">
                  <ColumnViewMenu view={responsesView} />
                </th>
                {responsesView.visibleKeys.map((key) => (
                  <th key={key} className={clsx("px-4 py-2.5", key === "score" && "text-right")}>
                    {columnLabel("relatorioSatisfacaoRespostas", key)}
                  </th>
                ))}
                <th className="px-4 py-2.5">
                  <span className="sr-only">Conversa</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {responses.length === 0 && (
                <tr>
                  <td colSpan={responsesView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                    Nenhuma resposta com esse filtro.
                  </td>
                </tr>
              )}
              {responses.map((r) => (
                <ResponseRow
                  key={r.surveyId}
                  response={r}
                  columns={responsesView.visibleKeys}
                  onCorrect={canCorrect ? (score) => correctMutation.mutate({ surveyId: r.surveyId, score }) : undefined}
                  opening={openMutation.isPending && openMutation.variables === r.conversationId} onOpen={() => openMutation.mutate(r.conversationId)} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {openConversation && <ReadOnlyConversationDrawer key={openConversation.id} conversation={openConversation} onClose={() => setOpenConversation(null)} />}
    </div>
  );
}

const SCORE_OPTIONS = Array.from({ length: 11 }, (_, n) => n);

function ResponseCell({ column, response: r, onCorrect }: { column: string; response: SatisfactionResponseDTO; onCorrect?: (score: number) => void }) {
  switch (column) {
    case "date":
      return <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted">{when(r.answeredAt ?? r.sentAt)}</td>;
    case "client":
      return (
        <td className="px-4 py-2.5">
          <p className="font-medium">{r.contactName ?? (r.contactPhone ? formatPhone(r.contactPhone) : "–")}</p>
          {r.contactName && r.contactPhone && <p className="text-xs tabular-nums text-muted">{formatPhone(r.contactPhone)}</p>}
        </td>
      );
    case "agent":
      return <td className="px-4 py-2.5">{r.agentName ?? "–"}</td>;
    case "connection":
      return <td className="px-4 py-2.5 text-muted">{r.connectionName}</td>;
    case "score":
      return (
        <td className="px-4 py-2.5 text-right">
          {onCorrect && r.score !== null ? (
            <select
              value={r.score}
              onChange={(e) => onCorrect(Number(e.target.value))}
              aria-label={`Corrigir a nota de ${r.contactName ?? r.contactPhone ?? "cliente"}`}
              title="Corrigir a nota"
              className="focus-ring rounded-md border border-border bg-surface px-1.5 py-0.5 text-base font-semibold tabular-nums"
            >
              {SCORE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-base font-semibold tabular-nums">{r.score ?? "–"}</span>
          )}
          {r.rereadScore !== null && (
            <span className="mt-0.5 block whitespace-nowrap text-[11px] font-medium text-warning" title="Com a leitura atual, essa resposta vale outra nota">
              Revisar: parece {r.rereadScore}
            </span>
          )}
          {r.correction && (
            <span
              className="mt-0.5 block whitespace-nowrap text-[11px] text-muted"
              title={`Corrigida por ${r.correction.byName ?? "—"} em ${new Date(r.correction.at).toLocaleDateString("pt-BR")}`}
            >
              corrigida (era {r.correction.originalScore ?? "–"})
            </span>
          )}
        </td>
      );
    case "answer":
      return (
        <td className="max-w-[16rem] px-4 py-2.5 text-xs text-muted">
          <span className="line-clamp-2" title={r.answerText ?? undefined}>
            {r.answerText ?? "–"}
          </span>
        </td>
      );
    case "category":
      return (
        <td className="px-4 py-2.5">
          {r.category ? (
            <span className={clsx("rounded-full px-2 py-0.5 text-xs font-semibold", CATEGORY[r.category].chip)}>{CATEGORY[r.category].label}</span>
          ) : (
            <span className="text-xs text-muted">{r.status === "awaiting" ? "Aguardando" : "Sem resposta"}</span>
          )}
        </td>
      );
    default:
      return null;
  }
}

function ResponseRow({
  response: r,
  columns,
  onCorrect,
  opening,
  onOpen,
}: {
  response: SatisfactionResponseDTO;
  columns: string[];
  onCorrect?: (score: number) => void;
  opening: boolean;
  onOpen: () => void;
}) {
  return (
    <tr className="border-t border-border hover:bg-surface-alt">
      <td className="w-0 p-0" />
      {columns.map((column) => (
        <ResponseCell key={column} column={column} response={r} onCorrect={onCorrect} />
      ))}
      <td className="px-4 py-2 text-right">
        <button
          onClick={onOpen}
          disabled={opening}
          className="focus-ring inline-flex items-center gap-1.5 whitespace-nowrap rounded-card border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt disabled:opacity-60"
          aria-label={`Ver a conversa avaliada de ${r.contactName ?? r.contactPhone ?? "cliente"}`}
        >
          <Eye className="h-3.5 w-3.5" /> {opening ? "Abrindo..." : "Ver conversa"}
        </button>
      </td>
    </tr>
  );
}
