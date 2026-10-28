import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AreaChart as AreaChartIcon, BarChart3, LineChart as LineChartIcon } from "lucide-react";
import { ChartTypeMenu } from "./ChartTypeMenu";
import { CHART_CARD_SHADOW, CHART_DEPTH_FILTER, darken, gradientId, lighten } from "../../lib/chart-theme";

type SeriesKind = "bar" | "line" | "area";

const KIND_OPTIONS = [
  { key: "bar" as const, label: "Barras", icon: BarChart3 },
  { key: "line" as const, label: "Linha", icon: LineChartIcon },
  { key: "area" as const, label: "Área", icon: AreaChartIcon },
];

interface Series {
  key: string;
  name: string;
  color: string;
}

/**
 * "Atendimentos por atendente" — the Dashboard's one multi-series card —
 * switchable between bar/line/area, with the same glossy gradient +
 * drop-shadow "3D" treatment as DistributionChartCard. See PROMPT:
 * "gráficos... mais apresentável com estilo de 3d e profundidade...
 * opção de alterar o tipo de gráfico".
 */
export function SeriesChartCard({
  title,
  data,
  series,
  categoryKey,
  defaultKind = "bar",
  height = 280,
  emptyMessage = "Sem dados no período selecionado.",
}: {
  title: string;
  data: Record<string, unknown>[];
  series: Series[];
  categoryKey: string;
  defaultKind?: SeriesKind;
  height?: number;
  emptyMessage?: string;
}) {
  const [kind, setKind] = useState<SeriesKind>(defaultKind);
  const barIds = series.map((s) => gradientId("sbar", s.color));
  const areaIds = series.map((s) => gradientId("sarea", s.color));

  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{title}</p>
        <ChartTypeMenu value={kind} onChange={setKind} options={KIND_OPTIONS} />
      </div>

      {data.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {kind === "bar" ? (
            <BarChart data={data} style={{ filter: CHART_DEPTH_FILTER }}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={barIds[i]} id={barIds[i]} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lighten(s.color, 0.25)} />
                    <stop offset="100%" stopColor={darken(s.color, 0.1)} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey={categoryKey} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.name} fill={`url(#${barIds[i]})`} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          ) : kind === "line" ? (
            <LineChart data={data} style={{ filter: CHART_DEPTH_FILTER }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey={categoryKey} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: s.color, stroke: "var(--color-surface)", strokeWidth: 2 }}
                  activeDot={{ r: 6 }}
                />
              ))}
            </LineChart>
          ) : (
            <AreaChart data={data} style={{ filter: CHART_DEPTH_FILTER }}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={areaIds[i]} id={areaIds[i]} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.55} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey={categoryKey} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {series.map((s, i) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2.5}
                  fill={`url(#${areaIds[i]})`}
                />
              ))}
            </AreaChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}
