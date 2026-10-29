import { npsZoneOf } from "@whatsatendende/types";

/**
 * Number helpers shared by the Dashboard cards and the PowerPoint presentation built from them —
 * kept free of React so the presentation builder (and its tests) can use them as they are.
 */

export interface StatDelta {
  text: string;
  /** Whether the change is good news (green) or bad (red) — "fewer minutes" can be good. */
  good: boolean;
  up: boolean;
}

/**
 * "12% vs período anterior". Null when there's nothing meaningful to compare
 * (no previous data at all). `lowerIsBetter` flips the color for times.
 */
export function compareWithPrevious(current: number | null, previous: number | null, lowerIsBetter = false): StatDelta | null {
  if (current === null || previous === null || previous === 0) return null;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { text: "igual ao período anterior", good: true, up: false };
  const up = change > 0;
  return { text: `${Math.round(Math.abs(change) * 100)}% vs período anterior`, good: lowerIsBetter ? !up : up, up };
}

export function formatMinutes(ms: number | null): string {
  if (ms === null) return "-";
  // Under a minute in seconds: a quick 1ª resposta used to read "0 min", as if the acceptance message had counted.
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h ${remainder}min`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("pt-BR");
}

/** NPS from 0 to 100, as the server sends it. */
export function formatNps(nps: number): string {
  return String(nps);
}

/** Change against the period before, in points: "▲ 6", "▼ 3", "= 0" — null when either side has no NPS. */
export function npsDelta(current: number | null, previous: number | null): { text: string; tone: "up" | "down" | "same" } | null {
  if (current === null || previous === null) return null;
  const diff = current - previous;
  if (diff === 0) return { text: "= igual", tone: "same" };
  return { text: `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)} ${Math.abs(diff) === 1 ? "ponto" : "pontos"}`, tone: diff > 0 ? "up" : "down" };
}

/** Share of `part` in `whole`, as a whole percentage (0 when there is no whole). */
export function percentOf(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0;
}

/** The NPS zone on the 0–100 scale: 88 or more excellence, 75–87 quality, 50–74 improvement, below 50 critical. */
export function npsZone(nps: number): { label: string; tone: "success" | "primary" | "warning" | "danger" } {
  const zone = npsZoneOf(nps);
  return { label: zone.label, tone: zone.tone };
}

// last15days, lastYear and year only come from a scheduled send (Agendamento da apresentação).
export type PeriodKey = "today" | "yesterday" | "last7days" | "last15days" | "month" | "lastMonth" | "year" | "lastYear" | "custom" | "all";

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

const two = (n: number) => String(n).padStart(2, "0");
const dayMonthYear = (d: Date) => `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
const dayMonth = (d: Date) => `${two(d.getDate())}/${two(d.getMonth() + 1)}`;

/** A YYYY-MM-DD from a date input, read as that calendar day (not as UTC midnight). */
function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function range(from: Date, to: Date): string {
  if (from.getFullYear() !== to.getFullYear()) return `${dayMonthYear(from)} a ${dayMonthYear(to)}`;
  return `${dayMonth(from)} a ${dayMonthYear(to)}`;
}

/**
 * The period of the Dashboard written out for people outside the system: its name and the actual
 * days it covers — the same days the API counts (see resolvePeriod in apps/api/src/lib/period.ts).
 */
export function describePeriod(period: { period: PeriodKey; from?: string; to?: string }, now: Date): { name: string; dates: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  switch (period.period) {
    case "today":
      return { name: "Hoje", dates: dayMonthYear(today) };
    case "yesterday":
      return { name: "Ontem", dates: dayMonthYear(daysAgo(1)) };
    case "last7days":
      return { name: "Últimos 7 dias", dates: range(daysAgo(6), today) };
    case "last15days":
      return { name: "Últimos 15 dias", dates: range(daysAgo(14), today) };
    case "month":
      return { name: "Este mês", dates: `${MONTHS[today.getMonth()]} de ${today.getFullYear()}, até ${dayMonth(today)}` };
    case "year":
      return { name: "Este ano", dates: `${today.getFullYear()}, até ${dayMonth(today)}` };
    case "lastYear":
      return { name: "Ano anterior", dates: `${today.getFullYear() - 1}` };
    case "lastMonth": {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return { name: "Mês anterior", dates: `${MONTHS[first.getMonth()]} de ${first.getFullYear()}` };
    }
    case "custom": {
      const from = period.from ? parseDay(period.from) : null;
      const to = period.to ? parseDay(period.to) : null;
      return { name: "Período personalizado", dates: from && to ? range(from, to) : "datas escolhidas no Dashboard" };
    }
    case "all":
      return { name: "Todo o período", dates: "desde o início do uso do sistema" };
  }
}
