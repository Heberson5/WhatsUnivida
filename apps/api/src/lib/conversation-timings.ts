import { businessMs, cachedHolidayLookup, conversationSchedule, type BusinessSchedule, type HolidayLookup } from "./business-time";

/**
 * The times a conversation is measured by — in the queue, to the first reply, in attendance — counting only the
 * connection's Horário de expediente (see business-time.ts). Each query that feeds them selects SCHEDULE_SELECT.
 */
export const SCHEDULE_SELECT = {
  whatsappConnection: { select: { workSchedule: true } },
  metaConnection: { select: { workSchedule: true } },
} as const;

type WithSchedule = {
  whatsappConnection?: { workSchedule?: BusinessSchedule | null } | null;
  metaConnection?: { workSchedule?: BusinessSchedule | null } | null;
};

/** Business milliseconds from `start` to `end` of this conversation (null when either is missing or end < start). */
export async function conversationSpanMs(
  c: WithSchedule,
  start: Date | null | undefined,
  end: Date | null | undefined,
  isHoliday: HolidayLookup = cachedHolidayLookup()
): Promise<number | null> {
  if (!start || !end || end.getTime() < start.getTime()) return null;
  return businessMs(conversationSchedule(c), start, end, isHoliday);
}

/**
 * "1ª resposta": from the current acceptance to the agent's first own reply. A reply from before that acceptance
 * belongs to someone who had the conversation earlier — never a negative time.
 */
export function firstResponseMs(
  c: WithSchedule & { acceptedAt: Date | null; firstResponseAt: Date | null },
  isHoliday: HolidayLookup = cachedHolidayLookup()
): Promise<number | null> {
  return conversationSpanMs(c, c.acceptedAt, c.firstResponseAt, isHoliday);
}

/** One span per conversation that has both ends, e.g. (c) => [c.acceptedAt, c.closedAt]. */
export async function spanDiffs<T extends WithSchedule>(
  conversations: T[],
  ends: (c: T) => [Date | null | undefined, Date | null | undefined],
  isHoliday: HolidayLookup = cachedHolidayLookup()
): Promise<number[]> {
  const spans = await Promise.all(conversations.map((c) => conversationSpanMs(c, ...ends(c), isHoliday)));
  return spans.filter((ms): ms is number => ms !== null);
}

/** The first-response times of the conversations that have one. */
export function firstResponseDiffs<T extends WithSchedule & { acceptedAt: Date | null; firstResponseAt: Date | null }>(
  conversations: T[],
  isHoliday: HolidayLookup = cachedHolidayLookup()
): Promise<number[]> {
  return spanDiffs(conversations, (c) => [c.acceptedAt, c.firstResponseAt], isHoliday);
}
