import { useEffect, useState } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTypeMenu } from "./ChartTypeMenu";
import { SERIES_KIND_OPTIONS, type SeriesKind } from "./SeriesChartCard";
import { HourRangeMenu, formatHour, type HourRange } from "./HourRangeMenu";
import type { PresenceByHourDTO } from "@whatsatendende/types";
import { CHART_CARD_SHADOW, CHART_DEPTH_FILTER, CHART_TOOLTIP_PROPS, NEUTRAL_SERIES_COLOR, darken, gradientId, lighten } from "../../lib/chart-theme";

const PAUSE_COLOR = "#F59E0B";

function seriesColor(index: number, primaryColor: string, secondaryColor: string): string {
  const base = [primaryColor, PAUSE_COLOR, secondaryColor, NEUTRAL_SERIES_COLOR, lighten(primaryColor, 0.3), darken(secondaryColor, 0.25)];
  return base[index % base.length];
}

export type { HourRange };

/**
 * Dashboard section 8 — "Presença ao longo do dia": stacked columns showing,
 * for each hour, how many agents were Online vs Paused (per motivo). For
 * period="Hoje" the hours are trimmed to "now" — never an empty future hour
 * — since the day genuinely hasn't happened yet; any other period already
 * covers full past days, so every hour shows. The gear icon lets anyone
 * narrow the displayed range (e.g. 8h-20h to cut an empty overnight) and
 * optionally save it as their own default for next time.
 */
export function PresenceByHourChart({
  data,
  isLoading,
  isToday,
  primaryColor,
  secondaryColor,
  initialRange,
  onSaveDefaultRange,
  onActiveRangeChange,
}: {
  data: PresenceByHourDTO | undefined;
  isLoading: boolean;
  isToday: boolean;
  primaryColor: string;
  secondaryColor: string;
  initialRange: HourRange | null;
  onSaveDefaultRange: (range: HourRange | null) => void;
  // Reports whatever range is currently displayed (including the initial
  // one) so the parent can reuse it for the PPT export's own presence
  // slide — see PROMPT: "Novo gráfico de colunas empilhadas nativo...
  // respeitando a faixa de horário configurada".
  onActiveRangeChange?: (range: HourRange | null) => void;
}) {
  const [range, setRange] = useState<HourRange | null>(initialRange);
  const [kind, setKind] = useState<SeriesKind>("bar");

  useEffect(() => {
    onActiveRangeChange?.(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const series = data?.series ?? [];
  const currentLocalHour = new Date().getHours();

  const chartData = (data?.hours ?? [])
    .filter((p) => !range || (p.hour >= range.start && p.hour <= range.end))
    .filter((p) => !isToday || p.hour <= currentLocalHour)
    .map((p) => {
      const row: Record<string, unknown> = { hourLabel: formatHour(p.hour) };
      for (const key of series) row[key] = p.counts[key] ?? 0;
      return row;
    });

  const barIds = series.map((key, i) => gradientId("presbar", seriesColor(i, primaryColor, secondaryColor)));

  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">Presença ao longo do dia</p>
        <div className="flex items-center gap-1">
        <ChartTypeMenu value={kind} onChange={setKind} options={SERIES_KIND_OPTIONS} />
        <HourRangeMenu
          range={range}
          onChange={(next, asDefault) => {
            setRange(next);
            if (asDefault) onSaveDefaultRange(next);
          }}
        />
        </div>
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted">Carregando...</p>
      ) : chartData.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">Sem dados de presença no período selecionado.</p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} style={{ filter: CHART_DEPTH_FILTER }}>
            <defs>
              {series.map((key, i) => (
                <linearGradient key={barIds[i]} id={barIds[i]} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lighten(seriesColor(i, primaryColor, secondaryColor), 0.25)} />
                  <stop offset="100%" stopColor={darken(seriesColor(i, primaryColor, secondaryColor), 0.1)} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="hourLabel" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
            <Tooltip {...CHART_TOOLTIP_PROPS} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {series.map((key, i) =>
              kind === "line" ? (
                <Line key={key} type="monotone" dataKey={key} name={key} stroke={seriesColor(i, primaryColor, secondaryColor)} strokeWidth={2.5} dot={false} />
              ) : kind === "area" ? (
                <Area key={key} type="monotone" dataKey={key} name={key} stackId="presence" stroke={seriesColor(i, primaryColor, secondaryColor)} fill={`url(#${barIds[i]})`} />
              ) : (
                <Bar key={key} dataKey={key} name={key} stackId="presence" fill={`url(#${barIds[i]})`} radius={i === series.length - 1 ? [4, 4, 0, 0] : undefined} />
              )
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
