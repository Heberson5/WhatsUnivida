import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Inbox, MessageSquare, MessageSquareOff, Presentation, Timer, Users } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type ArrivalsByHourDTO, type AutoMessageBlocksReportDTO, type PresenceByHourDTO, type SatisfactionOverviewDTO, type SatisfactionReportDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { PeriodFilter, type PeriodValue } from "../../components/common/PeriodFilter";
import { ConnectionFilter } from "../../components/common/ConnectionFilter";
import { StatCard, compareWithPrevious, formatMinutes } from "../../components/common/StatCard";
import { AgentsTable, TeamNowCard, type TeamData } from "../../components/dashboard/TeamCards";
import { DistributionChartCard } from "../../components/dashboard/DistributionChartCard";
import { SeriesChartCard } from "../../components/dashboard/SeriesChartCard";
import { WordCloudCard } from "../../components/dashboard/WordCloudCard";
import { SatisfactionCard } from "../../components/dashboard/SatisfactionCard";
import { SatisfactionDetailSection } from "../../components/dashboard/SatisfactionDetailSection";
import { PresenceByHourChart, type HourRange } from "../../components/dashboard/PresenceByHourChart";
import { ArrivalsByHourChart } from "../../components/dashboard/ArrivalsByHourChart";
import { useBranding } from "../../hooks/useBranding";
import { useExportBranding } from "../../hooks/useExportBranding";
import { NEUTRAL_SERIES_COLOR } from "../../lib/chart-theme";
import { exportDashboardPptx } from "../../lib/exportDashboardPptx";

interface AgentOption {
  id: string;
  displayName: string;
}

interface DashboardData {
  conversations: { received: number; unique: number; inProgress: number; closed: number; closedNoReturn: number; waiting: number };
  messages: { received: number; sent: number; total: number };
  timings: { avgAcceptMs: number | null; avgFirstResponseMs: number | null; avgHandlingMs: number | null; avgClosingMs: number | null };
  perAgent: { agentId: string; agentName: string; conversations: number; closedNoReturn: number; messagesSent: number; messagesReceived: number; avgHandlingMs: number | null }[];
  users: { online: number; active: number; total: number };
  previous: { received: number; unique: number; closed: number; messagesTotal: number; avgFirstResponseMs: number | null };
}

// Amber for "waiting" doesn't come from the brand (it's a status-severity
// color, same convention as StatCard/queue badges elsewhere), the other two
// slots follow the company's own primary/secondary — see PROMPT: "gráficos
// neste estilo, mais apresentável com estilo de 3d e profundidade".
const WAITING_COLOR = "#F59E0B";
const SURVEY_UNANSWERED_COLOR = WAITING_COLOR;

export default function DashboardPage() {
  const [period, setPeriod] = useState<PeriodValue>({ period: "today" });
  const [agentId, setAgentId] = useState("all");
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [exportingPptx, setExportingPptx] = useState(false);
  const navigate = useNavigate();
  const permissions = useAuthStore((s) => s.permissions);
  const user = useAuthStore((s) => s.user);
  const updatePresenceChartHours = useAuthStore((s) => s.updatePresenceChartHours);
  const updateArrivalsChartHours = useAuthStore((s) => s.updateArrivalsChartHours);
  const canOpenGestao = permissions?.[PERMISSION.GESTAO_ACESSAR];
  const canOpenUsuarios = permissions?.[PERMISSION.USUARIOS_VISUALIZAR];
  // The presentation is for the board: managers and administrators make it, even where agents were given the Dashboard.
  const canExportPresentation = user?.role === "ADMIN" || user?.role === "MANAGER";

  // "Aguardando" never carries the dashboard's period filter — the count
  // itself isn't period-scoped server-side (it's "right now", same as
  // listQueue), so applying the period here would open a list that doesn't
  // match the card's own number. "Em atendimento"/"Encerradas" do apply it,
  // since those counts ARE scoped to the selected period. See PROMPT: "já
  // aplicado o filtro do período do dashboard e o filtro do card".
  function goToGestao(statuses: string[], includePeriod: boolean) {
    const params = new URLSearchParams({ status: statuses.join(",") });
    if (includePeriod) {
      params.set("period", period.period);
      if (period.from) params.set("from", period.from);
      if (period.to) params.set("to", period.to);
    }
    navigate(`/gestao?${params.toString()}`);
  }

  // A bar of "Conversas que chegam ao longo do dia" (or its "abertas pelo cliente" total): Gestão with exactly those.
  function goToArrivals(hour: number | null) {
    const params = new URLSearchParams({ openedBy: "customer", period: period.period });
    if (period.from) params.set("from", period.from);
    if (period.to) params.set("to", period.to);
    if (hour !== null) params.set("hour", String(hour));
    if (agentId !== "all") params.set("agentId", agentId);
    if (connectionIds.length) params.set("connectionId", connectionIds.join(","));
    navigate(`/gestao?${params.toString()}`);
  }

  const { data: branding } = useBranding();
  const { data: exportBranding } = useExportBranding();
  const primaryColor = branding?.primaryColor ?? "#0097B4";
  const secondaryColor = branding?.secondaryColor ?? "#FFE450";
  const statusColors = [WAITING_COLOR, primaryColor, NEUTRAL_SERIES_COLOR];
  const messageColors = [primaryColor, secondaryColor];
  const agentSeriesColors = [primaryColor, secondaryColor];

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => (await api.get<AgentOption[]>("/agents")).data,
  });

  // Same list (and cache) as the connection filter — for the names on the presentation's cover.
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<{ id: string; name: string }[]>("/whatsapp/connections")).data,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dashboard", period, agentId, connectionIds],
    queryFn: async () =>
      (
        await api.get<DashboardData>("/dashboard", {
          params: {
            period: period.period,
            from: period.from,
            to: period.to,
            agentId: agentId === "all" ? undefined : agentId,
            connectionId: connectionIds.length ? connectionIds : undefined,
          },
        })
      ).data,
  });

  const { data: wordCloud, isLoading: isWordCloudLoading } = useQuery({
    queryKey: ["dashboard-word-cloud", period, agentId, connectionIds],
    queryFn: async () =>
      (
        await api.get<{ word: string; count: number }[]>("/dashboard/word-cloud", {
          params: {
            period: period.period,
            from: period.from,
            to: period.to,
            agentId: agentId === "all" ? undefined : agentId,
            connectionId: connectionIds.length ? connectionIds : undefined,
          },
        })
      ).data,
  });

  // The same numbers as Relatórios › Pesquisa de satisfação; per attendant and the latest evaluations only come for Gestor/Administrador.
  const { data: satisfaction, isLoading: isSatisfactionLoading } = useQuery({
    queryKey: ["dashboard-satisfaction-overview", period, agentId, connectionIds],
    queryFn: async () =>
      (
        await api.get<SatisfactionOverviewDTO>("/dashboard/satisfaction-overview", {
          params: {
            period: period.period,
            from: period.from,
            to: period.to,
            agentId: agentId === "all" ? undefined : agentId,
            connectionId: connectionIds.length ? connectionIds : undefined,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          },
        })
      ).data,
  });

  const { data: team } = useQuery({
    queryKey: ["dashboard-team", period, agentId],
    queryFn: async () =>
      (
        await api.get<TeamData>("/dashboard/team", {
          params: { period: period.period, from: period.from, to: period.to, agentId: agentId === "all" ? undefined : agentId },
        })
      ).data,
    // "Equipe agora" is a live snapshot.
    refetchInterval: 30_000,
  });

  const { data: presenceByHour, isLoading: isPresenceByHourLoading } = useQuery({
    queryKey: ["dashboard-presence-by-hour", period, agentId],
    queryFn: async () =>
      (
        await api.get<PresenceByHourDTO>("/dashboard/presence-by-hour", {
          params: {
            period: period.period,
            from: period.from,
            to: period.to,
            agentId: agentId === "all" ? undefined : agentId,
          },
        })
      ).data,
  });

  // "Conversas que chegam ao longo do dia" — new conversations per hour, inside/outside the hours, and attendants online.
  const { data: arrivalsByHour, isLoading: isArrivalsByHourLoading } = useQuery({
    queryKey: ["dashboard-arrivals-by-hour", period, agentId, connectionIds],
    queryFn: async () =>
      (
        await api.get<ArrivalsByHourDTO>("/dashboard/arrivals-by-hour", {
          params: {
            period: period.period,
            from: period.from,
            to: period.to,
            agentId: agentId === "all" ? undefined : agentId,
            connectionId: connectionIds.length ? connectionIds : undefined,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          },
        })
      ).data,
  });
  const savedArrivalsRange: HourRange | null =
    user?.arrivalsChartStartHour != null && user?.arrivalsChartEndHour != null ? { start: user.arrivalsChartStartHour, end: user.arrivalsChartEndHour } : null;
  const [activeArrivalsRange, setActiveArrivalsRange] = useState<HourRange | null>(savedArrivalsRange);
  const saveDefaultArrivalsRangeMutation = useMutation({
    mutationFn: (range: HourRange | null) =>
      api.patch("/settings/arrivals-chart-hours", { startHour: range?.start ?? null, endHour: range?.end ?? null }),
    onSuccess: (_res, range) => updateArrivalsChartHours(range?.start ?? null, range?.end ?? null),
  });

  const [activeHourRange, setActiveHourRange] = useState<HourRange | null>(
    user?.presenceChartStartHour != null && user?.presenceChartEndHour != null
      ? { start: user.presenceChartStartHour, end: user.presenceChartEndHour }
      : null
  );

  const saveDefaultHourRangeMutation = useMutation({
    mutationFn: (range: HourRange | null) =>
      api.patch("/settings/presence-chart-hours", { startHour: range?.start ?? null, endHour: range?.end ?? null }),
    onSuccess: (_res, range) => updatePresenceChartHours(range?.start ?? null, range?.end ?? null),
  });

  // The board presentation (see lib/dashboardPresentation.ts): the same numbers already loaded here,
  // as native and editable PowerPoint slides — see PROMPT: "forma de exportar em Power Point bem
  // formatado para ser apresentável à diretoria".
  async function handleExportPptx() {
    if (!data) return;
    setExportingPptx(true);
    try {
      const selectedNames = connectionIds.map((id) => connections?.find((c) => c.id === id)?.name).filter((n): n is string => Boolean(n));
      const connectionsText =
        connectionIds.length === 0
          ? "Todas as conexões"
          : selectedNames.length === connectionIds.length && selectedNames.length <= 3
            ? `${selectedNames.length === 1 ? "Conexão" : "Conexões"}: ${selectedNames.join(", ")}`
            : `${connectionIds.length} conexões`;
      // The satisfaction detail (per attendant, over time, low scores) — for whoever can open Relatórios. If it
      // can't be read, the presentation still goes out with the Dashboard's own satisfaction slide.
      let satisfactionReport: SatisfactionReportDTO | null = null;
      if (permissions?.[PERMISSION.RELATORIOS_ACESSAR]) {
        try {
          satisfactionReport = (
            await api.get<SatisfactionReportDTO>("/reports/satisfaction", {
              params: {
                period: period.period,
                from: period.from,
                to: period.to,
                agentId: agentId === "all" ? undefined : agentId,
                connectionId: connectionIds.length ? connectionIds : undefined,
                tzOffsetMinutes: new Date().getTimezoneOffset(),
              },
            })
          ).data;
        } catch {
          satisfactionReport = null;
        }
      }
      // What the tags stopped (Relatórios › Mensagens bloqueadas) — its slide is left out when it can't be read.
      let autoMessageBlocks: AutoMessageBlocksReportDTO | null = null;
      if (permissions?.[PERMISSION.RELATORIOS_ACESSAR]) {
        autoMessageBlocks = await api
          .get<AutoMessageBlocksReportDTO>("/reports/auto-message-blocks", {
            params: {
              period: period.period,
              from: period.from,
              to: period.to,
              agentId: agentId === "all" ? undefined : agentId,
              connectionId: connectionIds.length ? connectionIds : undefined,
              tzOffsetMinutes: new Date().getTimezoneOffset(),
            },
          })
          .then((res) => res.data)
          .catch(() => null);
      }
      const agentText = agentId === "all" ? "todos os atendentes" : `atendente: ${agents?.find((a) => a.id === agentId)?.displayName ?? "1 atendente"}`;
      await exportDashboardPptx({
        data,
        period,
        branding: exportBranding ?? null,
        scopeLabel: `${connectionsText} · ${agentText}`,
        satisfaction: satisfaction ?? null,
        satisfactionReport,
        team: team ?? null,
        wordCloud: wordCloud ?? [],
        presenceByHour: presenceByHour ?? null,
        presenceHourRange: activeHourRange,
        arrivalsByHour: arrivalsByHour ?? null,
        arrivalsHourRange: activeArrivalsRange,
        autoMessageBlocks,
      });
    } catch (err) {
      toast.error(`Não foi possível gerar a apresentação: ${getApiErrorMessage(err, "erro inesperado")}`);
    } finally {
      setExportingPptx(false);
    }
  }

  const periodLabel = { today: "hoje", yesterday: "ontem", last7days: "nos últimos 7 dias", month: "neste mês", lastMonth: "no mês anterior", custom: "no período", all: "em todo o período" }[
    period.period
  ];

  return (
    <div className="h-full overflow-auto p-3 sm:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Visão geral</h2>
          <p className="text-xs text-muted">
            {connectionIds.length ? `${connectionIds.length} ${connectionIds.length === 1 ? "conexão" : "conexões"}` : "Todas as conexões"} ·{" "}
            {agentId === "all" ? "todos os atendentes" : (agents?.find((a) => a.id === agentId)?.displayName ?? "1 atendente")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodFilter value={period} onChange={setPeriod} segmented />
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="focus-ring rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px]">
            <option value="all">Todos os atendentes</option>
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
          <ConnectionFilter value={connectionIds} onChange={setConnectionIds} />
          {canExportPresentation && (
            <button
              onClick={handleExportPptx}
              disabled={!data || exportingPptx}
              title="Baixa uma apresentação de PowerPoint com os números e gráficos deste Dashboard, para a diretoria"
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] font-medium hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Presentation className="h-4 w-4" /> {exportingPptx ? "Gerando apresentação..." : "Apresentação (PPT)"}
            </button>
          )}
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted">Carregando indicadores...</p>}

      {isError && (
        <p className="text-sm text-danger">
          Não foi possível carregar os indicadores: {getApiErrorMessage(error, "erro inesperado")}
        </p>
      )}

      {data && (
        <div className="space-y-8">
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard
              label="Conversas recebidas"
              value={data.conversations.received.toLocaleString("pt-BR")}
              icon={Inbox}
              delta={compareWithPrevious(data.conversations.received, data.previous.received)}
            />
            <StatCard
              label="Atendimentos únicos"
              value={data.conversations.unique.toLocaleString("pt-BR")}
              icon={Users}
              hint="clientes diferentes atendidos"
              delta={compareWithPrevious(data.conversations.unique, data.previous.unique)}
            />
            <StatCard
              label="Na fila agora"
              value={data.conversations.waiting}
              icon={Clock}
              tone={data.conversations.waiting > 0 ? "alert" : undefined}
              hint={data.conversations.waiting > 0 ? "aguardando um atendente" : "ninguém esperando"}
              onClick={canOpenGestao ? () => goToGestao(["NEW", "WAITING"], false) : undefined}
              goToLabel="Ver na Gestão →"
            />
            <StatCard
              label="1ª resposta (média)"
              value={formatMinutes(data.timings.avgFirstResponseMs)}
              icon={Timer}
              hint="sem contar a mensagem de aceite"
              delta={compareWithPrevious(data.timings.avgFirstResponseMs, data.previous.avgFirstResponseMs, true)}
            />
            <StatCard
              label="Encerradas"
              value={data.conversations.closed.toLocaleString("pt-BR")}
              icon={CheckCircle2}
              delta={compareWithPrevious(data.conversations.closed, data.previous.closed)}
              onClick={canOpenGestao ? () => goToGestao(["CLOSED"], true) : undefined}
              goToLabel="Ver na Gestão →"
            />
            <StatCard
              label="Mensagens"
              value={data.messages.total.toLocaleString("pt-BR")}
              icon={MessageSquare}
              delta={compareWithPrevious(data.messages.total, data.previous.messagesTotal)}
            />
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <TeamNowCard team={team} onOpenUsers={canOpenUsuarios ? () => navigate("/usuarios") : undefined} />
            <PresenceByHourChart
              data={presenceByHour}
              isLoading={isPresenceByHourLoading}
              isToday={period.period === "today"}
              primaryColor={primaryColor}
              secondaryColor={secondaryColor}
              initialRange={
                user?.presenceChartStartHour != null && user?.presenceChartEndHour != null
                  ? { start: user.presenceChartStartHour, end: user.presenceChartEndHour }
                  : null
              }
              onSaveDefaultRange={(range) => saveDefaultHourRangeMutation.mutate(range)}
              onActiveRangeChange={setActiveHourRange}
            />
          </section>

          <section>
            <ArrivalsByHourChart
              data={arrivalsByHour}
              isLoading={isArrivalsByHourLoading}
              isToday={period.period === "today"}
              primaryColor={primaryColor}
              initialRange={savedArrivalsRange}
              onSaveDefaultRange={(range) => saveDefaultArrivalsRangeMutation.mutate(range)}
              onActiveRangeChange={setActiveArrivalsRange}
              onOpenInGestao={canOpenGestao ? goToArrivals : undefined}
            />
          </section>

          <section>
            <AgentsTable team={team} stats={data.perAgent} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Mais números {periodLabel}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <StatCard
                label="Em atendimento"
                value={data.conversations.inProgress}
                icon={MessageSquare}
                onClick={canOpenGestao ? () => goToGestao(["IN_PROGRESS", "TRANSFERRED"], true) : undefined}
                goToLabel="Ver na Gestão →"
              />
              <StatCard
                label="Sem retorno do cliente"
                value={data.conversations.closedNoReturn}
                icon={MessageSquareOff}
                hint={`de ${data.conversations.closed.toLocaleString("pt-BR")} encerradas`}
              />
              <StatCard label="Mensagens recebidas" value={data.messages.received.toLocaleString("pt-BR")} icon={MessageSquare} />
              <StatCard label="Mensagens enviadas" value={data.messages.sent.toLocaleString("pt-BR")} icon={MessageSquare} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Distribuição no período</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <DistributionChartCard
                title="Conversas por status"
                data={[
                  { name: "Aguardando", value: data.conversations.waiting },
                  { name: "Em atendimento", value: data.conversations.inProgress },
                  { name: "Encerradas", value: data.conversations.closed },
                ]}
                colors={statusColors}
              />
              <DistributionChartCard
                title="Mensagens recebidas x enviadas"
                data={[
                  { name: "Recebidas", value: data.messages.received },
                  { name: "Enviadas", value: data.messages.sent },
                ]}
                colors={messageColors}
              />
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <WordCloudCard words={wordCloud} isLoading={isWordCloudLoading} />
            <SatisfactionCard overview={satisfaction} isLoading={isSatisfactionLoading} />
          </section>

          {satisfaction?.byAgent && satisfaction.totals.answered > 0 && <SatisfactionDetailSection overview={satisfaction} />}

          {satisfaction?.byAgent && satisfaction.totals.sent > 0 && (
            <SeriesChartCard
              title="Pesquisa por atendente: responderam x não responderam"
              data={satisfaction.byAgent.filter((a) => a.agentId).map((a) => ({ agentName: a.agentName, answered: a.answered, unanswered: a.unanswered }))}
              categoryKey="agentName"
              series={[
                { key: "answered", name: "Responderam", color: agentSeriesColors[0] },
                { key: "unanswered", name: "Não responderam", color: SURVEY_UNANSWERED_COLOR },
              ]}
            />
          )}

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Tempos médios de atendimento</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatCard label="Aceite" value={formatMinutes(data.timings.avgAcceptMs)} icon={Timer} />
              <StatCard label="1ª resposta" value={formatMinutes(data.timings.avgFirstResponseMs)} icon={Timer} />
              <StatCard label="Atendimento" value={formatMinutes(data.timings.avgHandlingMs)} icon={Timer} />
              <StatCard label="Até encerramento" value={formatMinutes(data.timings.avgClosingMs)} icon={Timer} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Atendimentos por atendente</h2>
            {/* With few agents the two charts sit side by side; past a point,
                squeezing both into half-width starts crowding the X axis
                again regardless of the label fix in SeriesChartCard, so each
                chart gets the full row instead — see PROMPT: "deixe
                responsivo para quando houver muitos atendentes, os gráficos
                ficam um abaixo do outro". */}
            <div className={`grid gap-4 ${data.perAgent.length > 6 ? "grid-cols-1" : "md:grid-cols-2"}`}>
              <SeriesChartCard
                title="Conversas por atendente"
                data={data.perAgent}
                categoryKey="agentName"
                series={[{ key: "conversations", name: "Conversas", color: agentSeriesColors[0] }]}
              />
              <SeriesChartCard
                title="Mensagens enviadas x recebidas por atendente"
                data={data.perAgent}
                categoryKey="agentName"
                series={[
                  { key: "messagesSent", name: "Enviadas", color: messageColors[1] },
                  { key: "messagesReceived", name: "Recebidas", color: messageColors[0] },
                ]}
              />
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
