import type { AccessSchedule, WeekdayKey } from "@whatsatendende/types";

// Same fixed-offset approach as lib/period.ts's dayBoundsUTC/localNowParts —
// this API runs with no TZ set (UTC container), so "what weekday/time is it
// right now for this person" has to be computed from the offset their own
// browser reports (Date.prototype.getTimezoneOffset()), not the server's
// clock. Brazil has had no DST since 2019, so a fixed offset is exact.
const WEEKDAY_ORDER: WeekdayKey[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface LocalNow {
  weekday: WeekdayKey;
  /** Minutes since local midnight, e.g. 08:30 -> 510. */
  minutesOfDay: number;
  /** YYYY-MM-DD in the caller's local calendar day — what "today" means for holiday matching. */
  dateKey: string;
}

export function resolveLocalNow(now: Date, tzOffsetMinutes: number): LocalNow {
  const local = new Date(now.getTime() - tzOffsetMinutes * 60_000);
  const weekday = WEEKDAY_ORDER[local.getUTCDay()];
  const minutesOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  const dateKey = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
  return { weekday, minutesOfDay, dateKey };
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: "OUTSIDE_SCHEDULE" | "HOLIDAY";
  message?: string;
  /** Minutes left in today's allowed window — null when there's no window today (unrestricted, or the day has no window at all). Drives the 20/10/1-minute warnings. */
  minutesRemainingToday: number | null;
}

/**
 * Pure decision function — see PROMPT: "Caso o campo de horário esteja em
 * branco, será considerado 24h (sem bloqueio)... pode variar, portanto
 * precisa ser por cada dia da semana". A day missing from `schedule` (or
 * `schedule` itself null) means unrestricted for that day. `schedule` is
 * checked before the holiday, matching the order the reason is most useful
 * to show — either blocks equally, so order has no real effect beyond which
 * message wins when, in principle, both apply on the same day.
 */
export function resolveAccessDecision(
  now: Date,
  tzOffsetMinutes: number,
  schedule: AccessSchedule | null | undefined,
  holidayName: string | null
): AccessDecision {
  if (holidayName) {
    return { allowed: false, reason: "HOLIDAY", message: `Acesso bloqueado: hoje é feriado (${holidayName}).`, minutesRemainingToday: null };
  }

  const window = schedule?.[resolveLocalNow(now, tzOffsetMinutes).weekday];
  if (!window) return { allowed: true, minutesRemainingToday: null };

  const { minutesOfDay } = resolveLocalNow(now, tzOffsetMinutes);
  const startMinutes = parseHHMM(window.start);
  const endMinutes = parseHHMM(window.end);
  if (minutesOfDay < startMinutes || minutesOfDay >= endMinutes) {
    return {
      allowed: false,
      reason: "OUTSIDE_SCHEDULE",
      message: `Acesso permitido apenas das ${window.start} às ${window.end} hoje.`,
      minutesRemainingToday: null,
    };
  }
  return { allowed: true, minutesRemainingToday: endMinutes - minutesOfDay };
}
