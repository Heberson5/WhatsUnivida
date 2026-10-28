import { useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, ChartPie, CircleDot } from "lucide-react";
import { ChartTypeMenu } from "./ChartTypeMenu";
import { CHART_CARD_SHADOW, CHART_DEPTH_FILTER, darken, gradientId, lighten } from "../../lib/chart-theme";

type DistributionKind = "donut" | "pie" | "bar";

const KIND_OPTIONS = [
  { key: "donut" as const, label: "Rosca", icon: CircleDot },
  { key: "pie" as const, label: "Pizza", icon: ChartPie },
  { key: "bar" as const, label: "Barras", icon: BarChart3 },
];

interface DistributionDatum {
  name: string;
  value: number;
}

/**
 * One of the two "distribution" cards on the Dashboard (conversas por
 * status, mensagens recebidas x enviadas) — switchable between donut/pie/
 * bar, with a glossy gradient + drop-shadow "3D" treatment instead of the
 * previous flat fills. See PROMPT: "gráficos... mais apresentável com
 * estilo de 3d e profundidade... opção de alterar o tipo de gráfico".
 */
export function DistributionChartCard({
  title,
  data,
  colors,
  defaultKind = "donut",
  height = 240,
  emptyMessage = "Sem dados no período selecionado.",
}: {
  title: string;
  data: DistributionDatum[];
  colors: string[];
  defaultKind?: DistributionKind;
  height?: number;
  emptyMessage?: string;
}) {
  const [kind, setKind] = useState<DistributionKind>(defaultKind);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const radialIds = colors.map((c) => gradientId("radial", c));
  const linearIds = colors.map((c) => gradientId("linear", c));

  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{title}</p>
        <ChartTypeMenu value={kind} onChange={setKind} options={KIND_OPTIONS} />
      </div>

      {total === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {kind === "bar" ? (
            <BarChart data={data} style={{ filter: CHART_DEPTH_FILTER }}>
              <defs>
                {colors.map((color, i) => (
                  <linearGradient key={linearIds[i]} id={linearIds[i]} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lighten(color, 0.25)} />
                    <stop offset="100%" stopColor={darken(color, 0.1)} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {data.map((entry, i) => (
                  <Cell key={entry.name} fill={`url(#${linearIds[i % linearIds.length]})`} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <PieChart style={{ filter: CHART_DEPTH_FILTER }}>
              <defs>
                {colors.map((color, i) => (
                  <radialGradient key={radialIds[i]} id={radialIds[i]} cx="35%" cy="35%" r="70%">
                    <stop offset="0%" stopColor={lighten(color, 0.4)} />
                    <stop offset="100%" stopColor={darken(color, 0.15)} />
                  </radialGradient>
                ))}
              </defs>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={kind === "donut" ? 55 : 0}
                outerRadius={85}
                paddingAngle={data.length > 1 ? 3 : 0}
                cornerRadius={6}
                stroke="none"
              >
                {data.map((entry, i) => (
                  <Cell key={entry.name} fill={`url(#${radialIds[i % radialIds.length]})`} />
                ))}
              </Pie>
              <Legend verticalAlign="bottom" height={24} wrapperStyle={{ fontSize: 12 }} />
              <Tooltip />
            </PieChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}
