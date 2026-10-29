import type { ReportScheduleFrequency } from "@whatsatendende/types";

/**
 * When a scheduled presentation goes out. Each "base" day comes from the frequency (daily, the chosen weekdays, every
 * other week, a day of the month or of the year, or every N days/weeks/months); a base day that falls on a holiday of
 * the cadastro, or on a Saturday/Sunday the schedule skips, moves to the next day that is free. Days are calendar days
 * (YYYY-MM-DD) in the schedule's own time zone; the send instant is that day at `time`.
 */

const DAY_MS = 86_400_000;
/** How far ahead the next send is looked for — a yearly schedule needs a little over a year. */
const HORIZON_DAYS = 800;

export interface ScheduleRule {
  frequency: ReportScheduleFrequency;
  time: string;
  tzOffsetMinutes: number;
  startDate: string;
  weekdays: number[];
  monthDay: number | null;
  month: number | null;
  customInterval: number;
  customUnit: string;
  endType: string;
  endAfter: number | null;
  endDate: string | null;
  skipSaturday: boolean;
  skipSunday: boolean;
}

const parse = (day: string) => new Date(`${day}T00:00:00.000Z`);
const key = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => key(new Date(parse(day).getTime() + n * DAY_MS));
const weekday = (day: string) => parse(day).getUTCDay();
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The schedule's calendar day of an instant. */
export function localDay(instant: Date, tzOffsetMinutes: number): string {
  return key(new Date(instant.getTime() - tzOffsetMinutes * 60_000));
}

/** `day` at the schedule's `time`, as a real instant. */
export function sendInstant(day: string, time: string, tzOffsetMinutes: number): Date {
  const [h, m] = time.split(":").map(Number);
  return new Date(parse(day).getTime() + ((h || 0) * 60 + (m || 0) + tzOffsetMinutes) * 60_000);
}

function weekIndex(day: string, start: string): number {
  // Weeks counted from the Sunday of the start date's week.
  const startSunday = addDays(start, -weekday(start));
  return Math.floor((parse(day).getTime() - parse(startSunday).getTime()) / (7 * DAY_MS));
}

function monthsBetween(day: string, start: string): number {
  const a = parse(start);
  const b = parse(day);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

function isMonthDay(day: string, wanted: number): boolean {
  const d = parse(day);
  return d.getUTCDate() === Math.min(wanted, lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth()));
}

/** Whether `day` is one of the frequency's own days (before any holiday/weekend move). */
export function isBaseDay(rule: ScheduleRule, day: string): boolean {
  if (day < rule.startDate) return false;
  const start = parse(rule.startDate);
  const days = rule.weekdays.length ? rule.weekdays : [start.getUTCDay()];
  const monthDay = rule.monthDay ?? start.getUTCDate();
  switch (rule.frequency) {
    case "DAILY":
      return true;
    case "WEEKLY":
      return days.includes(weekday(day));
    case "BIWEEKLY":
      return days.includes(weekday(day)) && weekIndex(day, rule.startDate) % 2 === 0;
    case "MONTHLY":
      return isMonthDay(day, monthDay);
    case "YEARLY":
      return parse(day).getUTCMonth() + 1 === (rule.month ?? start.getUTCMonth() + 1) && isMonthDay(day, monthDay);
    case "CUSTOM": {
      const n = Math.max(1, rule.customInterval);
      if (rule.customUnit === "WEEK") return days.includes(weekday(day)) && weekIndex(day, rule.startDate) % n === 0;
      if (rule.customUnit === "MONTH") return monthsBetween(day, rule.startDate) % n === 0 && isMonthDay(day, monthDay);
      return Math.round((parse(day).getTime() - start.getTime()) / DAY_MS) % n === 0;
    }
  }
}

export type HolidayCheck = (day: string) => boolean;

function blocked(rule: ScheduleRule, day: string, isHoliday: HolidayCheck): boolean {
  const wd = weekday(day);
  return (rule.skipSaturday && wd === 6) || (rule.skipSunday && wd === 0) || isHoliday(day);
}

/** A base day moved past skipped weekend days and holidays — "o próximo dia útil". */
export function shiftToFreeDay(rule: ScheduleRule, day: string, isHoliday: HolidayCheck): string {
  let d = day;
  for (let i = 0; i < 30 && blocked(rule, d, isHoliday); i++) d = addDays(d, 1);
  return d;
}

/**
 * The next send strictly after `after` — null when the schedule has ended (its end date passed, or it already went out
 * `endAfter` times: `sentCount`).
 */
export function nextSend(rule: ScheduleRule, after: Date, isHoliday: HolidayCheck, sentCount = 0): Date | null {
  if (rule.endType === "AFTER" && rule.endAfter && sentCount >= rule.endAfter) return null;
  // A day moved by a holiday may land after `after` even though its base day is before it — start a little earlier.
  let day = addDays(localDay(after, rule.tzOffsetMinutes), -31);
  if (day < rule.startDate) day = rule.startDate;
  for (let i = 0; i < HORIZON_DAYS; i++, day = addDays(day, 1)) {
    if (rule.endType === "ON_DATE" && rule.endDate && day > rule.endDate) return null;
    if (!isBaseDay(rule, day)) continue;
    const instant = sendInstant(shiftToFreeDay(rule, day, isHoliday), rule.time, rule.tzOffsetMinutes);
    if (instant.getTime() > after.getTime()) return instant;
  }
  return null;
}

/** The send days within the next `days` days — for the "same day, same recipient" warning. */
export function sendDays(rule: ScheduleRule, from: Date, days: number, isHoliday: HolidayCheck, sentCount = 0): string[] {
  const out: string[] = [];
  let cursor = new Date(from.getTime() - 1);
  let count = sentCount;
  const limit = from.getTime() + days * DAY_MS;
  for (let i = 0; i < 400; i++) {
    const next = nextSend(rule, cursor, isHoliday, count);
    if (!next || next.getTime() > limit) break;
    const day = localDay(next, rule.tzOffsetMinutes);
    if (out[out.length - 1] !== day) out.push(day);
    cursor = next;
    count++;
  }
  return out;
}
