import { useEffect, useState } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ArrivalsByHourDTO } from "@whatsatendende/types";
import { ChartTypeMenu } from "./ChartTypeMenu";
import { SERIES_KIND_OPTIONS, type SeriesKind } from "./SeriesChartCard";
import { HourRangeMenu, formatHour, type HourRange } from "./HourRangeMenu";
import { CHART_CARD_SHADOW, CHART_DEPTH_FILTER, CHART_TOOLTIP_PROPS, darken, gradientId, lighten } from "../../lib/chart-theme";

const OUTSIDE_COLOR = "#F59E0B";
const ONLINE_LINE_COLOR = "#334155";
const INSIDE_LABEL = "Dentro do expediente";
const OUTSIDE_LABEL = "Fora do expediente";
const ONLINE_LABEL = "Atendentes online (média)";

const formatDecimal = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** The figures above the chart: the busiest hour, the total and the share outside the hours. */
export function arrivalsSummary(data: ArrivalsByHourDTO | undefined) {
  const hours = data?.hours ?? [];
  const total = hours.reduce((sum, h) => sum + h.inside + h.outside, 0);
  const outside = hours.reduce((sum, h) => sum + h.outside, 0);
  const peak = hours.reduce<ArrivalsByHourDTO["hours"][number] | null>((best, h) => (h.inside + h.outside > (best ? best.inside + best.outside : 0) ? h : best), null);
  return { total, peakHour: peak?.hour ?? null, outsideShare: total ? Math.round((outside / total) * 100) : 0 };
}

/**
 * "Conversas que chegam ao longo do dia": new conversations opened by the customer per hour, inside/outside their
 * connection's Horário de expediente, with the attendants online on average as a line on its own scale. Same gear as
 * "Presença ao longo do dia" (its own saved range) and the same "Hoje" cut at the current hour.
 */
export function ArrivalsByHourChart({
  data,
  isLoading,
  isToday,
  primaryColor,
  initialRange,
  onSaveDefaultRange,
  onActiveRangeChange,
  onOpenInGestao,
}: {
  data: ArrivalsByHourDTO | undefined;
  isLoading: boolean;
  isToday: boolean;
  primaryColor: string;
  initialRange: HourRange | null;
  onSaveDefaultRange: (range: HourRange | null) => void;
  onActiveRangeChange?: (range: HourRange | null) => void;
  /** Gestão with the conversations the customer opened in the period — at `hour` (a bar), or all of them (null). */
  onOpenInGestao?: (hour: number | null) => void;
}) {
  const [range, setRange] = useState<HourRange | null>(initialRange);
  const [kind, setKind] = useState<SeriesKind>("bar");

  useEffect(() => {
    onActiveRangeChange?.(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const currentLocalHour = new Date().getHours();
  const chartData = (data?.hours ?? [])
    .filter((h) => !range || (h.hour >= range.start && h.hour <= range.end))
    .filter((h) => !isToday || h.hour <= currentLocalHour)
    .map((h) => ({ hour: h.hour, hourLabel: formatHour(h.hour), [INSIDE_LABEL]: h.inside, [OUTSIDE_LABEL]: h.outside, [ONLINE_LABEL]: h.onlineAvg, days: h.days }));
  const summary = arrivalsSummary(data);
  // Conversations in the hours the gear hides — a peak at 05h must not vanish from a chart cut to 08h–20h.
  const hidden = range ? (data?.hours ?? []).filter((h) => (h.hour < range.start || h.hour > range.end) && h.inside + h.outside > 0) : [];
  const hiddenCount = hidden.reduce((sum, h) => sum + h.inside + h.outside, 0);
  const breakdown = data?.summary;
  const openBar = (state: { activePayload?: { payload?: { hour?: number } }[] } | null) => {
    const hour = state?.activePayload?.[0]?.payload?.hour;
    if (onOpenInGestao && hour !== undefined) onOpenInGestao(hour);
  };
  const insideId = gradientId("arrin", primaryColor);
  const outsideId = gradientId("arrout", OUTSIDE_COLOR);

  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted">Conversas que chegam ao longo do dia</p>
          <p className="text-[11px] text-muted/80">
            Conversas novas abertas pelo cliente, pela hora da primeira mensagem{onOpenInGestao ? " · clique numa barra para ver a lista na Gestão" : ""}
          </p>
        </div>
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

      {summary.total > 0 && (
        <div className="mb-2 flex flex-wrap gap-x-6 gap-y-1">
          <Figure value={summary.peakHour !== null ? formatHour(summary.peakHour) : "—"} label="horário de pico" />
          <Figure value={summary.total.toLocaleString("pt-BR")} label="conversas no período" />
          <Figure value={`${summary.outsideShare}%`} label="fora do expediente" />
        </div>
      )}

      {breakdown && breakdown.withActivity > 0 && (
        <p className="mb-2 text-[11px] text-muted" data-testid="arrivals-breakdown">
          De {breakdown.withActivity.toLocaleString("pt-BR")} conversas com movimento no período (as que a Gestão lista):{" "}
          {onOpenInGestao ? (
            <button type="button" onClick={() => onOpenInGestao(null)} className="focus-ring font-semibold text-primary hover:underline">
              {breakdown.openedByCustomer.toLocaleString("pt-BR")} abertas pelo cliente
            </button>
          ) : (
            <strong>{breakdown.openedByCustomer.toLocaleString("pt-BR")} abertas pelo cliente</strong>
          )}{" "}
          · {breakdown.startedByTeam.toLocaleString("pt-BR")} iniciadas pela equipe · {breakdown.fromEarlierDays.toLocaleString("pt-BR")} vindas de dias anteriores
        </p>
      )}

      {hiddenCount > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-card bg-warning-soft px-3 py-1.5 text-xs text-warning">
          <span>
            {hiddenCount.toLocaleString("pt-BR")} {hiddenCount === 1 ? "conversa chegou" : "conversas chegaram"} fora das horas mostradas ({hidden.map((h) => formatHour(h.hour)).join(", ")}).
          </span>
          <button type="button" onClick={() => setRange(null)} className="focus-ring rounded-full border border-warning/40 px-2 py-0.5 font-semibold hover:bg-warning/10">
            Mostrar todas as horas
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted">Carregando...</p>
      ) : summary.total === 0 ? (
        <p className="py-8 text-center text-sm text-muted">Nenhuma conversa nova no período selecionado.</p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} style={{ filter: CHART_DEPTH_FILTER, cursor: onOpenInGestao ? "pointer" : undefined }} onClick={openBar}>
            <defs>
              <linearGradient id={insideId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lighten(primaryColor, 0.25)} />
                <stop offset="100%" stopColor={darken(primaryColor, 0.1)} />
              </linearGradient>
              <linearGradient id={outsideId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lighten(OUTSIDE_COLOR, 0.25)} />
                <stop offset="100%" stopColor={darken(OUTSIDE_COLOR, 0.1)} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="hourLabel" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis yAxisId="conversations" tick={{ fontSize: 12 }} allowDecimals={false} />
            <YAxis yAxisId="online" orientation="right" tick={{ fontSize: 12 }} allowDecimals={false} />
            <Tooltip
              {...CHART_TOOLTIP_PROPS}
              formatter={(value: number, name: string) => [name === ONLINE_LABEL ? `${formatDecimal(value)} em média` : value.toLocaleString("pt-BR"), name]}
              labelFormatter={(label: string, payload) => {
                const row = payload?.[0]?.payload as Record<string, number> | undefined;
                if (!row) return label;
                const total = (row[INSIDE_LABEL] ?? 0) + (row[OUTSIDE_LABEL] ?? 0);
                const perDay = row.days > 1 ? ` (${formatDecimal(total / row.days)} por dia)` : "";
                return `${label} · ${total.toLocaleString("pt-BR")} ${total === 1 ? "conversa" : "conversas"}${perDay}`;
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {kind === "line" ? (
              <>
                <Line yAxisId="conversations" type="monotone" dataKey={INSIDE_LABEL} stroke={primaryColor} strokeWidth={2.5} dot={false} />
                <Line yAxisId="conversations" type="monotone" dataKey={OUTSIDE_LABEL} stroke={OUTSIDE_COLOR} strokeWidth={2.5} dot={false} />
              </>
            ) : kind === "area" ? (
              <>
                <Area yAxisId="conversations" type="monotone" dataKey={INSIDE_LABEL} stackId="arrivals" stroke={primaryColor} fill={`url(#${insideId})`} />
                <Area yAxisId="conversations" type="monotone" dataKey={OUTSIDE_LABEL} stackId="arrivals" stroke={OUTSIDE_COLOR} fill={`url(#${outsideId})`} />
              </>
            ) : (
              <>
                <Bar yAxisId="conversations" dataKey={INSIDE_LABEL} stackId="arrivals" fill={`url(#${insideId})`} />
                <Bar yAxisId="conversations" dataKey={OUTSIDE_LABEL} stackId="arrivals" fill={`url(#${outsideId})`} radius={[4, 4, 0, 0]} />
              </>
            )}
            <Line yAxisId="online" type="monotone" dataKey={ONLINE_LABEL} stroke={ONLINE_LINE_COLOR} strokeWidth={2} dot={{ r: 3, fill: "#fff", strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-base font-bold tabular-nums leading-5">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  );
}
