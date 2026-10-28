import type { WorkSchedule } from "@prisma/client";
import type { BusinessClockDTO, ConversationListItemDTO, WorkScheduleDaysDTO, WorkSchedulePartialHolidayDTO } from "@whatsatendende/types";
import { prisma } from "./prisma";

const DAY_MS = 86_400_000;
// How far back the waits on screen can reach (older ones are long gone from the queue and "sem resposta").
const LOOKBACK_DAYS = 60;

/** The holiday days (YYYY-MM-DD) of a schedule's place between two dates — repeating ones included. */
async function holidayDays(schedule: WorkSchedule, from: Date, to: Date): Promise<string[]> {
  const place = { OR: [{ scope: "NATIONAL" as const }, { scope: "STATE" as const, state: schedule.state }, { scope: "MUNICIPAL" as const, state: schedule.state, city: schedule.city }] };
  const [dated, yearly] = await Promise.all([
    prisma.holiday.findMany({ where: { date: { gte: from, lte: to }, ...place }, select: { date: true } }),
    prisma.holiday.findMany({ where: { recurringYearly: true, ...place }, select: { monthDay: true } }),
  ]);
  const days = new Set(dated.map((h) => h.date.toISOString().slice(0, 10)));
  for (const h of yearly) {
    for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year++) days.add(`${year}-${h.monthDay}`);
  }
  return [...days].sort();
}

/**
 * Gives each conversation of a list its connection's Horário de expediente (businessClock), so the screen counts
 * "na fila há" and "sem resposta há" only while it is open. One query per connection, not per conversation.
 */
export async function attachBusinessClocks<T extends ConversationListItemDTO>(items: T[], now = new Date()): Promise<T[]> {
  if (items.length === 0) return items;
  const whatsappIds = [...new Set(items.filter((c) => c.channel === "WHATSAPP").map((c) => c.whatsappConnectionId))];
  const metaIds = [...new Set(items.filter((c) => c.channel !== "WHATSAPP").map((c) => c.whatsappConnectionId))];
  const [whatsapp, meta] = await Promise.all([
    whatsappIds.length ? prisma.whatsAppConnection.findMany({ where: { id: { in: whatsappIds } }, select: { id: true, workSchedule: true } }) : [],
    metaIds.length ? prisma.metaConnection.findMany({ where: { id: { in: metaIds } }, select: { id: true, workSchedule: true } }) : [],
  ]);
  const scheduleOf = new Map<string, WorkSchedule | null>([...whatsapp, ...meta].map((c) => [c.id, c.workSchedule]));

  const from = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const to = new Date(now.getTime() + 2 * DAY_MS);
  const clocks = new Map<string, BusinessClockDTO>();
  for (const schedule of new Set([...scheduleOf.values()].filter((s): s is WorkSchedule => Boolean(s)))) {
    clocks.set(schedule.id, {
      state: schedule.state,
      days: schedule.days as WorkScheduleDaysDTO,
      partialHolidays: (schedule.partialHolidays as unknown as WorkSchedulePartialHolidayDTO[]) ?? [],
      holidays: await holidayDays(schedule, from, to),
    });
  }
  return items.map((c) => {
    const schedule = scheduleOf.get(c.whatsappConnectionId);
    return { ...c, businessClock: schedule ? (clocks.get(schedule.id) ?? null) : null };
  });
}
