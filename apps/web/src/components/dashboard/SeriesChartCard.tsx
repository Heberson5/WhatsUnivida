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
import { CHART_CARD_SHADOW, CHART_DEPTH_FILTER, CHART_TOOLTIP_PROPS, darken, gradientId, lighten } from "../../lib/chart-theme";

export type SeriesKind = "bar" | "line" | "area";

export const SERIES_KIND_OPTIONS = [
  { key: "bar" as const, label: "Barras", icon: BarChart3 },
  { key: "line" as const, label: "Linha", icon: LineChartIcon },
  { key: "area" as const, label: "Área", icon: AreaChartIcon },
];

interface Series {
  key: string;
  name: string;
  color: string;
}

// Recharts hides overlapping tick labels by default (interval="preserveEnd"),
// which is exactly why some agent names used to vanish from this axis —
// see PROMPT: "não está aparecendo os nomes de algumas atendentes". interval=0
// forces every category to render; angling the text lets names that would
// otherwise collide fit side by side instead of being dropped.
const CATEGORY_AXIS_PROPS = {
  tick: { fontSize: 11 },
  interval: 0 as const,
  angle: -35,
  textAnchor: "end" as const,
};
// The angled names get the room the longest one needs (a fixed height let "Atendente - Léia Maria" run into the
// legend); past MAX_LABEL_CHARS a name is cut with "…" — the tooltip still shows it whole.
const MAX_LABEL_CHARS = 28;
const CHAR_WIDTH_PX = 6;
const ANGLE_SIN = Math.sin((35 * Math.PI) / 180);
const ANGLE_COS = Math.cos((35 * Math.PI) / 180);
// Roughly what the Y axis and half of the first bar already give the first name on its left.
const ROOM_LEFT_OF_FIRST_PX = 70;
const shortLabel = (value: unknown) => {
  const text = String(value ?? "");
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
};
function categoryAxisHeight(data: Record<string, unknown>[], key: string): number {
  const longest = Math.max(0, ...data.map((d) => shortLabel(d[key]).length));
  return Math.max(40, Math.round(longest * CHAR_WIDTH_PX * ANGLE_SIN) + 16);
}
/** The first name leans left past the Y axis: the chart moves right just enough for it to show whole. */
function leftMargin(data: Record<string, unknown>[], key: string): number {
  const first = shortLabel(data[0]?.[key]).length;
  return Math.max(0, Math.round(first * CHAR_WIDTH_PX * ANGLE_COS) - ROOM_LEFT_OF_FIRST_PX);
}
// Above the plot, out of the way of the names.
const LEGEND_PROPS = { verticalAlign: "top" as const, align: "right" as const, height: 28, wrapperStyle: { fontSize: 12 } };

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
  const axis = { ...CATEGORY_AXIS_PROPS, dataKey: categoryKey, height: categoryAxisHeight(data, categoryKey), tickFormatter: shortLabel };
  const margin = { bottom: 8, left: leftMargin(data, categoryKey) };

  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{title}</p>
        <ChartTypeMenu value={kind} onChange={setKind} options={SERIES_KIND_OPTIONS} />
      </div>

      {data.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{emptyMessage}</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {kind === "bar" ? (
            <BarChart data={data} style={{ filter: CHART_DEPTH_FILTER }} margin={margin}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={barIds[i]} id={barIds[i]} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lighten(s.color, 0.25)} />
                    <stop offset="100%" stopColor={darken(s.color, 0.1)} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis {...axis} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip {...CHART_TOOLTIP_PROPS} />
              <Legend {...LEGEND_PROPS} />
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.name} fill={`url(#${barIds[i]})`} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          ) : kind === "line" ? (
            <LineChart data={data} style={{ filter: CHART_DEPTH_FILTER }} margin={margin}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis {...axis} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip {...CHART_TOOLTIP_PROPS} />
              <Legend {...LEGEND_PROPS} />
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
            <AreaChart data={data} style={{ filter: CHART_DEPTH_FILTER }} margin={margin}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={areaIds[i]} id={areaIds[i]} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.55} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis {...axis} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip {...CHART_TOOLTIP_PROPS} />
              <Legend {...LEGEND_PROPS} />
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
