import { differenceInCalendarDays, format } from "date-fns";
import { ptBR } from "date-fns/locale";

// Same as WhatsApp Web: the name of the weekday for the last few days, the full date from then on.
const WEEKDAY_LABEL_DAYS = 7;

/**
 * Text of the cut that opens a day in a conversation: "Hoje", "Ontem", the
 * weekday for the days before that ("Segunda-feira"), and the full date
 * ("25/09/2026") once the weekday would be ambiguous — 7 or more days back.
 * `today` is the viewer's current day (local time); see useToday.
 */
export function dayLabel(at: Date | number, today: Date): string {
  const daysAgo = differenceInCalendarDays(today, at);
  if (daysAgo <= 0) return "Hoje";
  if (daysAgo === 1) return "Ontem";
  if (daysAgo < WEEKDAY_LABEL_DAYS) {
    const weekday = format(at, "EEEE", { locale: ptBR });
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  }
  return format(at, "dd/MM/yyyy");
}

export interface DayGroup<T> {
  /** Local calendar day, yyyy-MM-dd. */
  key: string;
  /** When the first entry of the day happened — what the cut's text is computed from. */
  at: number;
  entries: T[];
}

/**
 * Splits a chronological list into one group per calendar day, in the
 * viewer's local time (the same clock the message times are shown in). An
 * entry that arrives out of order is kept with the day it follows instead of
 * jumping back to an earlier one, so a day never shows up twice in a row.
 */
export function groupByDay<T extends { at: number }>(entries: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  let latest = -Infinity;
  for (const entry of entries) {
    latest = Math.max(latest, entry.at);
    const key = format(latest, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last?.key === key) last.entries.push(entry);
    else groups.push({ key, at: latest, entries: [entry] });
  }
  return groups;
}
