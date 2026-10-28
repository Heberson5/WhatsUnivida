import { format, isSameDay, isSameYear, subDays } from "date-fns";

/**
 * "hoje 14:32", "ontem 18:10", "06/10 09:12" (or "06/10/2025 09:12" in another year) —
 * when something last happened, in the viewer's own calendar days.
 */
export function formatActivity(when: Date | string | number, now: Date | number = Date.now()): string {
  const date = new Date(when);
  const today = new Date(now);
  const time = format(date, "HH:mm");
  if (isSameDay(date, today)) return `hoje ${time}`;
  if (isSameDay(date, subDays(today, 1))) return `ontem ${time}`;
  return `${format(date, isSameYear(date, today) ? "dd/MM" : "dd/MM/yyyy")} ${time}`;
}
