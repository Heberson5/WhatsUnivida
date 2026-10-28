import { z } from "zod";

export type PeriodKey = "today" | "yesterday" | "last7days" | "month" | "lastMonth" | "custom";

/**
 * Query-string date param that's optional in practice but arrives as an
 * empty string (not simply absent) whenever a caller sends `from=&to=` —
 * e.g. a period-filter UI that only fills these in for period="custom"
 * but still includes the keys for every other period. Plain
 * `z.coerce.date().optional()` rejects `""` (`new Date("")` is invalid),
 * which used to 400 the whole request for every non-custom period.
 */
export const optionalDateQueryParam = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.date().optional()
);

// Day boundaries ("hoje", "este mês", ...) must be computed in the browser's
// local calendar day, not the server's — this API runs in a Docker container
// with no TZ set (UTC), so a user in Tangará da Serra (UTC-4) clicking "Hoje"
// in the evening was getting a "today" that had already rolled into the
// container's tomorrow. The frontend sends its own UTC offset in minutes
// (JS `Date.prototype.getTimezoneOffset()`, e.g. 240 for UTC-4) with every
// request; Brazil has had no DST since 2019, so a fixed offset — no IANA
// timezone database needed — is exact.
function dayBoundsUTC(year: number, month: number, date: number, tzOffsetMinutes: number): { start: Date; end: Date } {
  const offsetMs = tzOffsetMinutes * 60_000;
  return {
    start: new Date(Date.UTC(year, month, date, 0, 0, 0, 0) + offsetMs),
    end: new Date(Date.UTC(year, month, date, 23, 59, 59, 999) + offsetMs),
  };
}

/** The real UTC instant `now`, read back out as the client's local calendar Y/M/D. */
function localNowParts(tzOffsetMinutes: number): { year: number; month: number; date: number } {
  const local = new Date(Date.now() - tzOffsetMinutes * 60_000);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), date: local.getUTCDate() };
}

export function resolvePeriod(period: PeriodKey, from?: Date, to?: Date, tzOffsetMinutes = 0): { from: Date; to: Date } {
  const now = localNowParts(tzOffsetMinutes);

  switch (period) {
    case "today": {
      const { start, end } = dayBoundsUTC(now.year, now.month, now.date, tzOffsetMinutes);
      return { from: start, to: end };
    }
    case "yesterday": {
      const { start, end } = dayBoundsUTC(now.year, now.month, now.date - 1, tzOffsetMinutes);
      return { from: start, to: end };
    }
    case "last7days": {
      const { start } = dayBoundsUTC(now.year, now.month, now.date - 6, tzOffsetMinutes);
      const { end } = dayBoundsUTC(now.year, now.month, now.date, tzOffsetMinutes);
      return { from: start, to: end };
    }
    case "month": {
      const { start } = dayBoundsUTC(now.year, now.month, 1, tzOffsetMinutes);
      const { end } = dayBoundsUTC(now.year, now.month, now.date, tzOffsetMinutes);
      return { from: start, to: end };
    }
    case "lastMonth": {
      const { start } = dayBoundsUTC(now.year, now.month - 1, 1, tzOffsetMinutes);
      // Day 0 of this month === the last day of the previous month.
      const { end } = dayBoundsUTC(now.year, now.month, 0, tzOffsetMinutes);
      return { from: start, to: end };
    }
    case "custom": {
      if (!from || !to) throw new Error("custom period requires from and to");
      // `from`/`to` arrive parsed from a plain "YYYY-MM-DD" <input type=date>
      // value, which JS parses as UTC midnight — so its UTC getters already
      // hand back exactly the calendar day the user picked, unambiguously.
      const { start } = dayBoundsUTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), tzOffsetMinutes);
      const { end } = dayBoundsUTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), tzOffsetMinutes);
      return { from: start, to: end };
    }
  }
}
