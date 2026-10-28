import type { WorkSchedule } from "@prisma/client";
import { z } from "zod";
import {
  WEEKDAY_KEYS,
  stateUtcOffsetMinutes,
  type WorkScheduleDTO,
  type WorkScheduleDaysDTO,
  type WorkScheduleHolidayDTO,
  type WorkSchedulePartialHolidayDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { resolveLocalNow } from "../../lib/access-schedule";
import { findApplicableHoliday } from "../holidays/holidays.service";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato HH:mm");

const windowSchema = z.union([
  z.object({ allDay: z.literal(true) }),
  z.object({ allDay: z.literal(false).optional(), start: hhmm, end: hhmm }).refine((w) => w.start < w.end, "O início deve ser antes do término"),
]);

export const workScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  state: z.string().length(2).toUpperCase(),
  city: z.string().trim().min(1).max(120),
  days: z
    .record(z.enum(WEEKDAY_KEYS), windowSchema)
    .refine((days) => Object.keys(days).length > 0, "Marque pelo menos um dia da semana"),
  partialHolidays: z
    .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: hhmm, end: hhmm }).refine((h) => h.start < h.end, "O início deve ser antes do término"))
    .max(100)
    .refine((list) => new Set(list.map((h) => h.date)).size === list.length, "Há um feriado repetido"),
  closedMessage: z.string().trim().min(1, "A mensagem de fora do expediente é obrigatória").max(1024),
});

export type WorkScheduleInput = z.infer<typeof workScheduleSchema>;

type Row = WorkSchedule & { whatsappConnections: { id: string; name: string }[]; metaConnections: { id: string; name: string }[] };

const connectionsInclude = {
  whatsappConnections: { select: { id: true, name: true } },
  metaConnections: { select: { id: true, name: true } },
};

export function toWorkScheduleDTO(row: Row): WorkScheduleDTO {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    city: row.city,
    days: row.days as WorkScheduleDaysDTO,
    partialHolidays: row.partialHolidays as unknown as WorkSchedulePartialHolidayDTO[],
    closedMessage: row.closedMessage,
    connections: [...row.whatsappConnections, ...row.metaConnections],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listWorkSchedules(): Promise<WorkScheduleDTO[]> {
  const rows = await prisma.workSchedule.findMany({ orderBy: { name: "asc" }, include: connectionsInclude });
  return rows.map(toWorkScheduleDTO);
}

export function listWorkScheduleOptions() {
  return prisma.workSchedule.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

async function getRow(id: string): Promise<Row> {
  const row = await prisma.workSchedule.findUnique({ where: { id }, include: connectionsInclude });
  if (!row) throw Errors.notFound("Horário de expediente não encontrado");
  return row;
}

export async function createWorkSchedule(input: WorkScheduleInput): Promise<WorkScheduleDTO> {
  const row = await prisma.workSchedule.create({ data: input, include: connectionsInclude });
  return toWorkScheduleDTO(row);
}

export async function updateWorkSchedule(id: string, input: Partial<WorkScheduleInput>): Promise<WorkScheduleDTO> {
  await getRow(id);
  const row = await prisma.workSchedule.update({ where: { id }, data: input, include: connectionsInclude });
  return toWorkScheduleDTO(row);
}

export async function deleteWorkSchedule(id: string): Promise<void> {
  const row = await getRow(id);
  const inUse = [...row.whatsappConnections, ...row.metaConnections];
  if (inUse.length > 0) {
    throw Errors.conflict(`Este horário está em uso pelas conexões: ${inUse.map((c) => c.name).join(", ")}. Escolha outro horário nelas antes de excluir.`);
  }
  const nodes = await prisma.flowNode.findMany({ where: { type: "BUSINESS_HOURS", data: { path: ["workScheduleId"], equals: id } }, select: { flow: { select: { name: true } } } });
  if (nodes.length > 0) {
    const names = [...new Set(nodes.map((n) => n.flow.name))];
    throw Errors.conflict(`Este horário está em uso pelos fluxos: ${names.join(", ")}. Escolha outro horário no nó de horário antes de excluir.`);
  }
  await prisma.workSchedule.delete({ where: { id } });
}

/** Throws 422-style when `id` isn't a registered schedule — used when a connection picks one. */
export async function assertWorkScheduleExists(id: string): Promise<void> {
  await getRow(id);
}

function toMinutes(hhmmValue: string): number {
  const [h, m] = hhmmValue.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Whether the schedule is open at `now`. The state sets the time zone; a holiday that applies to its state/city is closed all day,
 * except a date listed in `partialHolidays`; any other day follows the weekday window (missing = closed, allDay = open 24h).
 */
export async function isWorkScheduleOpen(
  schedule: Pick<WorkSchedule, "state" | "city" | "days" | "partialHolidays">,
  now: Date = new Date(),
  // Checking many moments at once (e.g. the Dashboard's arrivals by hour) passes a cached lookup.
  isHoliday: (dateKey: string, state: string, city: string) => Promise<unknown> = findApplicableHoliday
): Promise<boolean> {
  const local = resolveLocalNow(now, stateUtcOffsetMinutes(schedule.state));
  const inside = (start: string, end: string) => local.minutesOfDay >= toMinutes(start) && local.minutesOfDay < toMinutes(end);

  if (await isHoliday(local.dateKey, schedule.state, schedule.city)) {
    const partial = (schedule.partialHolidays as unknown as WorkSchedulePartialHolidayDTO[]).find((h) => h.date === local.dateKey);
    return partial ? inside(partial.start, partial.end) : false;
  }
  const window = (schedule.days as WorkScheduleDaysDTO)[local.weekday];
  if (!window) return false;
  return window.allDay ? true : inside(window.start, window.end);
}

/** The holidays (national, the state's and the city's) from today through the end of next year — what "feriado parcial" is picked from. */
export async function listApplicableHolidays(state: string, city: string): Promise<WorkScheduleHolidayDTO[]> {
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const to = new Date(Date.UTC(today.getUTCFullYear() + 1, 11, 31));
  const place = { OR: [{ scope: "NATIONAL" as const }, { scope: "STATE" as const, state }, { scope: "MUNICIPAL" as const, state, city }] };
  const [rows, yearly] = await Promise.all([
    prisma.holiday.findMany({ where: { date: { gte: from, lte: to }, recurringYearly: false, ...place }, orderBy: [{ date: "asc" }, { name: "asc" }] }),
    prisma.holiday.findMany({ where: { recurringYearly: true, ...place } }),
  ]);
  const listed = rows.map((h) => ({ date: h.date.toISOString().slice(0, 10), name: h.name }));
  // Repeating every year: this year's and next year's occurrence, when inside the window.
  for (const h of yearly) {
    for (const year of [from.getUTCFullYear(), from.getUTCFullYear() + 1]) {
      const date = `${year}-${h.monthDay}`;
      if (date >= from.toISOString().slice(0, 10) && date <= to.toISOString().slice(0, 10)) listed.push({ date, name: h.name });
    }
  }
  return listed.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * Closed-hours notice for a connection: the message to send when the connection follows a schedule that is closed right now, else null
 * (no schedule chosen = open 24 hours, nothing to send).
 */
export async function getClosedMessageForConnection(channel: "WHATSAPP" | "INSTAGRAM" | "MESSENGER", connectionId: string, now: Date = new Date()): Promise<string | null> {
  const schedule = await getConnectionSchedule(channel, connectionId);
  if (!schedule) return null;
  return (await isWorkScheduleOpen(schedule, now)) ? null : schedule.closedMessage;
}

export async function getConnectionSchedule(channel: "WHATSAPP" | "INSTAGRAM" | "MESSENGER", connectionId: string): Promise<WorkSchedule | null> {
  const select = { workSchedule: true } as const;
  const row =
    channel === "WHATSAPP"
      ? await prisma.whatsAppConnection.findUnique({ where: { id: connectionId }, select })
      : await prisma.metaConnection.findUnique({ where: { id: connectionId }, select });
  return row?.workSchedule ?? null;
}
