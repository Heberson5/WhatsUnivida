import type { AnnouncementRecurrence } from "@whatsatendende/types";

/**
 * Which days a notice shows. A notice has no time of day — only days (YYYY-MM-DD): from its start date to its end
 * date (or only the start date, for ONCE), every day, on the start date's weekday (WEEKLY) or on the start date's day of
 * the month (MONTHLY — a 31 falls on the last day of a shorter month).
 */

const DAY_MS = 86_400_000;

export interface AnnouncementDays {
  startDate: string;
  endDate: string | null;
  recurrence: AnnouncementRecurrence;
}

function parse(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return dayKey(new Date(parse(day).getTime() + n * DAY_MS));
}

/** The person's calendar day right now, from the browser's getTimezoneOffset() (240 for UTC-4). */
export function todayKey(tzOffsetMinutes: number, now = new Date()): string {
  return dayKey(new Date(now.getTime() - tzOffsetMinutes * 60_000));
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function occursOn(a: AnnouncementDays, day: string): boolean {
  if (day < a.startDate) return false;
  if (a.recurrence === "ONCE") return day === a.startDate;
  if (a.endDate && day > a.endDate) return false;
  if (a.recurrence === "DAILY") return true;
  const start = parse(a.startDate);
  const d = parse(day);
  if (a.recurrence === "WEEKLY") return d.getUTCDay() === start.getUTCDay();
  const wanted = Math.min(start.getUTCDate(), lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth()));
  return d.getUTCDate() === wanted;
}

/** The last day it can show — null when it repeats with no end. */
export function lastDay(a: AnnouncementDays): string | null {
  return a.recurrence === "ONCE" ? a.startDate : a.endDate;
}

/** The first day it shows on or after `from` — null once it has ended. Looks at most ~13 months ahead. */
export function nextDay(a: AnnouncementDays, from: string): string | null {
  let day = from < a.startDate ? a.startDate : from;
  const last = lastDay(a);
  for (let i = 0; i < 400; i++) {
    if (last && day > last) return null;
    if (occursOn(a, day)) return day;
    day = addDays(day, 1);
  }
  return null;
}

/** Whether it is over: its last day has passed. */
export function hasEnded(a: AnnouncementDays, today: string): boolean {
  const last = lastDay(a);
  return last !== null && today > last;
}
