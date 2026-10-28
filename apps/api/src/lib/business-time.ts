import type { WorkSchedule } from "@prisma/client";
import { stateUtcOffsetMinutes, type WeekdayKey, type WorkScheduleDaysDTO, type WorkSchedulePartialHolidayDTO } from "@whatsatendende/types";
import { findApplicableHoliday } from "../modules/holidays/holidays.service";

/**
 * Time that only counts inside the connection's Horário de expediente — waiting in the queue, the first reply, the
 * attendance. A customer who writes at 17:58 when the day ends at 18:00 has waited 2 minutes at 8:00 the next morning,
 * not 14 hours. Holidays are closed all day (or the hours of a partial holiday). No schedule = 24 hours, as before.
 */

export type BusinessSchedule = Pick<WorkSchedule, "state" | "city" | "days" | "partialHolidays">;
export type HolidayLookup = (dateKey: string, state: string, city: string) => Promise<unknown>;

const DAY_MS = 86_400_000;
const WEEKDAY_BY_UTC_DAY: WeekdayKey[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** One lookup per day and place, for many intervals at once (a Dashboard, a report). */
export function cachedHolidayLookup(lookup: HolidayLookup = findApplicableHoliday): HolidayLookup {
  const cache = new Map<string, Promise<unknown>>();
  return (dateKey, state, city) => {
    const key = `${dateKey}|${state}|${city}`;
    if (!cache.has(key)) cache.set(key, lookup(dateKey, state, city));
    return cache.get(key)!;
  };
}

/** The open windows of one local day, in minutes from its midnight. */
async function openWindows(schedule: BusinessSchedule, dateKey: string, weekday: WeekdayKey, isHoliday: HolidayLookup): Promise<[number, number][]> {
  if (await isHoliday(dateKey, schedule.state, schedule.city)) {
    const partial = ((schedule.partialHolidays as unknown as WorkSchedulePartialHolidayDTO[]) ?? []).find((h) => h.date === dateKey);
    return partial ? [[minutesOf(partial.start), minutesOf(partial.end)]] : [];
  }
  const window = (schedule.days as WorkScheduleDaysDTO)[weekday];
  if (!window) return [];
  return window.allDay ? [[0, 1440]] : [[minutesOf(window.start), minutesOf(window.end)]];
}

/** Milliseconds between `start` and `end` that fall inside the schedule's open hours. */
export async function businessMs(
  schedule: BusinessSchedule | null | undefined,
  start: Date,
  end: Date,
  isHoliday: HolidayLookup = findApplicableHoliday
): Promise<number> {
  const from = start.getTime();
  const to = end.getTime();
  if (to <= from) return 0;
  if (!schedule) return to - from;
  const offsetMs = stateUtcOffsetMinutes(schedule.state) * 60_000;
  // Local midnight (as a UTC instant) of the day `start` falls in.
  let dayStart = Math.floor((from - offsetMs) / DAY_MS) * DAY_MS + offsetMs;
  let total = 0;
  while (dayStart < to) {
    const local = new Date(dayStart - offsetMs);
    const dateKey = local.toISOString().slice(0, 10);
    for (const [a, b] of await openWindows(schedule, dateKey, WEEKDAY_BY_UTC_DAY[local.getUTCDay()], isHoliday)) {
      total += Math.max(0, Math.min(dayStart + b * 60_000, to) - Math.max(dayStart + a * 60_000, from));
    }
    dayStart += DAY_MS;
  }
  return total;
}

/** The schedule a conversation follows: its WhatsApp or Meta connection's. */
export function conversationSchedule(c: { whatsappConnection?: { workSchedule?: BusinessSchedule | null } | null; metaConnection?: { workSchedule?: BusinessSchedule | null } | null }) {
  return c.whatsappConnection?.workSchedule ?? c.metaConnection?.workSchedule ?? null;
}
