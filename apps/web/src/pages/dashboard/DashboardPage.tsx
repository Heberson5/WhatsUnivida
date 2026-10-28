import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileBarChart2, Inbox, MessageSquare, Timer, UserCheck, Users, Wifi } from "lucide-react";
import { api, getApiErrorMessage } from "../../lib/api";
import { PeriodFilter, type PeriodValue } from "../../components/common/PeriodFilter";
import { ConnectionFilter } from "../../components/common/ConnectionFilter";
import { StatCard, formatMinutes } from "../../components/common/StatCard";
import { DistributionChartCard } from "../../components/dashboard/DistributionChartCard";
import { SeriesChartCard } from "../../components/dashboard/SeriesChartCard";
import { useBranding } from "../../hooks/useBranding";
import { NEUTRAL_SERIES_COLOR } from "../../lib/chart-theme";
import { exportDashboardPptx } from "../../lib/exportDashboardPptx";

interface AgentOption {
  id: string;
  displayName: string;
}

interface DashboardData {
  conversations: { received: number; unique: number; inProgress: number; closed: number; waiting: number };
  messages: { received: number; sent: number; total: number };
  timings: { avgAcceptMs: number | null; avgFirstResponseMs: number | null; avgHandlingMs: number | null; avgClosingMs: number | null };
  perAgent: { agentId: string; agentName: string; conversations: number; messagesSent: number; avgHandlingMs: number | null }[];
  users: { online: number; active: number; total: number };
}

// Amber for "waiting" doesn't come from the brand (it's a status-severity
// color, same convention as StatCard/queue badges elsewhere), the other two
// slots follow the company's own primary/secondary — see PROMPT: "gráficos
// neste estilo, mais apresentável com estilo de 3d e profundidade".
const WAITING_COLOR = "#F59E0B";

export default function DashboardPage() {
  const [period, setPeriod] = useState<PeriodValue>({ period: "today" });
  const [agentId, setAgentId] = useState("all");
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [exportingPptx, setExportingPptx] = useState(false);
  const { data: branding } = useBranding();
  const primaryColor = branding?.primaryColor ?? "#0097B4";
  const secondaryColor = branding?.secondaryColor ?? "#FFE450";
  const statusColors = [WAITING_COLOR, primaryColor, NEUTRAL_SERIES_COLOR];
  const messageColors = [primaryColor, secondaryColor];
  const agentSeriesColors = [primaryColor, secondaryColor];

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => (await api.get<AgentOption[]>("/agents")).data,
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

  // Native, editable PowerPoint charts (not screenshots) built straight from
  // the same data already loaded here — see PROMPT: "forma de exportar em
  // Power Point bem formatado para ser apresentável à diretoria".
  async function handleExportPptx() {
    if (!data) return;
    setExportingPptx(true);
    try {
      await exportDashboardPptx({
        data,
        period,
        branding: branding ?? null,
        statusColors,
        messageColors,
        agentSeriesColors,
      });
    } finally {
      setExportingPptx(false);
    }
  }

  return (
    <div className="h-full overflow-auto p-3 sm:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="focus-ring rounded-card border border-border bg-surface px-3 py-2 text-sm">
            <option value="all">Todos os atendentes</option>
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
          <ConnectionFilter value={connectionIds} onChange={setConnectionIds} />
        </div>
        <button
          onClick={handleExportPptx}
          disabled={!data || exportingPptx}
          className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileBarChart2 className="h-4 w-4" /> {exportingPptx ? "Gerando..." : "Exportar PPT"}
        </button>
      </div>

      {isLoading && <p className="text-sm text-muted">Carregando indicadores...</p>}

      {isError && (
        <p className="text-sm text-red-600">
          Não foi possível carregar os indicadores: {getApiErrorMessage(error, "erro inesperado")}
        </p>
      )}

      {data && (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Usuários</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <StatCard label="Online agora" value={data.users.online} icon={Wifi} />
              <StatCard label="Ativos" value={data.users.active} icon={UserCheck} />
              <StatCard label="Total" value={data.users.total} icon={Users} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Conversas</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <StatCard label="Recebidas" value={data.conversations.received} icon={Inbox} />
              <StatCard label="Únicas" value={data.conversations.unique} icon={Users} />
              <StatCard label="Aguardando" value={data.conversations.waiting} icon={Timer} />
              <StatCard label="Em atendimento" value={data.conversations.inProgress} icon={MessageSquare} />
              <StatCard label="Encerradas" value={data.conversations.closed} icon={Inbox} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Mensagens</h2>
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Recebidas" value={data.messages.received} icon={MessageSquare} />
              <StatCard label="Enviadas" value={data.messages.sent} icon={MessageSquare} />
              <StatCard label="Total" value={data.messages.total} icon={MessageSquare} />
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
            <SeriesChartCard
              title="Conversas e mensagens enviadas por atendente"
              data={data.perAgent}
              categoryKey="agentName"
              series={[
                { key: "conversations", name: "Conversas", color: agentSeriesColors[0] },
                { key: "messagesSent", name: "Mensagens enviadas", color: agentSeriesColors[1] },
              ]}
            />
          </section>
        </div>
      )}
    </div>
  );
}
