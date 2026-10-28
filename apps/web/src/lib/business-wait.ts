import { formatDistance } from "date-fns";
import { ptBR } from "date-fns/locale";
import { businessMsBetween, isBusinessOpenAt, type BusinessClockDTO } from "@whatsatendende/types";

/**
 * Waits on screen ("na fila há", "sem resposta há") count only the connection's Horário de expediente —
 * a customer who wrote at 17:58 has waited 2 minutes at 8:00 the next morning. No schedule = 24 hours.
 */
export function businessMinutesSince(clock: BusinessClockDTO | null | undefined, iso: string, now: number) {
  return Math.floor(businessMsBetween(clock, new Date(iso).getTime(), now) / 60_000);
}

/** "5 minutos", "2 horas" — the business time since `iso`. */
export function businessWaitLabel(clock: BusinessClockDTO | null | undefined, iso: string, now: number) {
  return formatDistance(0, businessMsBetween(clock, new Date(iso).getTime(), now), { locale: ptBR });
}

/** The connection is closed right now, so the wait is on hold. */
export function waitPaused(clock: BusinessClockDTO | null | undefined, now: number) {
  return Boolean(clock) && !isBusinessOpenAt(clock, now);
}

export const PAUSED_LABEL = "⏸ fora do expediente";
