import type { AnnouncementRecurrence } from "@whatsatendende/types";

/**
 * When a notice shows, on each person's own clock: from its start date and time to its end date and time, every day
 * (ONCE, DAILY), on the start date's weekday (WEEKLY) or on the start date's day of the month (MONTHLY — a 31 falls on
 * the last day of a shorter month). Older notices may have no times (the whole day) and no end date (ONCE: only its start
 * date; the others: no end).
 */

const DAY_MS = 86_400_000;

export interface AnnouncementDays {
  startDate: string;
  endDate: string | null;
  recurrence: AnnouncementRecurrence;
  startTime?: string | null;
  endTime?: string | null;
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

/** The person's date and time right now, "YYYY-MM-DD HH:mm": compared as text against a notice's start and end. */
export function nowKey(tzOffsetMinutes: number, now = new Date()): string {
  return new Date(now.getTime() - tzOffsetMinutes * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function occursOn(a: AnnouncementDays, day: string): boolean {
  if (day < a.startDate) return false;
  const last = lastDay(a);
  if (last && day > last) return false;
  if (a.recurrence === "ONCE" || a.recurrence === "DAILY") return true;
  const start = parse(a.startDate);
  const d = parse(day);
  if (a.recurrence === "WEEKLY") return d.getUTCDay() === start.getUTCDay();
  const wanted = Math.min(start.getUTCDate(), lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth()));
  return d.getUTCDate() === wanted;
}

/** The last day it can show — null when it repeats with no end. */
export function lastDay(a: AnnouncementDays): string | null {
  return a.endDate ?? (a.recurrence === "ONCE" ? a.startDate : null);
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

export function hasStarted(a: AnnouncementDays, now: string): boolean {
  return now >= `${a.startDate} ${a.startTime ?? "00:00"}`;
}

/** Whether it is over: its end date and time have arrived. */
export function hasEnded(a: AnnouncementDays, now: string): boolean {
  const last = lastDay(a);
  return last !== null && now >= `${last} ${a.endTime ?? "24:00"}`;
}

export function showsNow(a: AnnouncementDays, now: string): boolean {
  return occursOn(a, now.slice(0, 10)) && hasStarted(a, now) && !hasEnded(a, now);
}
