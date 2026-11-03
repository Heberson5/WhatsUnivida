import type { WorkSchedule } from "@prisma/client";
import type { WorkScheduleDaysDTO, WorkSchedulePartialHolidayDTO } from "@whatsatendende/types";
import { prisma } from "./prisma";
import { cachedHolidayLookup, type HolidayLookup } from "./business-time";
import type { PeriodKey } from "./period";

/** What the Dashboard's cards compare with: the window and how the card names it ("sex 30/10 até 14:18"). */
export interface ComparisonWindow {
  from: Date;
  to: Date;
  label: string;
}

type Schedule = Pick<WorkSchedule, "state" | "city" | "days" | "partialHolidays">;

const DAY_MS = 86_400_000;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
// How far back a business day of the same kind is looked for before settling for any business day.
const LOOKBACK_DAYS = 60;
const two = (n: number) => String(n).padStart(2, "0");

/**
 * Days are counted in the viewer's calendar: day n is the local day that starts at n × 24h after the epoch, local
 * time. Brazil has no daylight saving, so the fixed offset the browser sends is exact.
 */
class Calendar {
  private readonly holidays: HolidayLookup = cachedHolidayLookup();
  constructor(
    private readonly tzOffsetMinutes: number,
    private readonly schedules: Schedule[]
  ) {}

  dayOf(instant: Date): number {
    return Math.floor((instant.getTime() - this.tzOffsetMinutes * 60_000) / DAY_MS);
  }
  start(day: number): Date {
    return new Date(day * DAY_MS + this.tzOffsetMinutes * 60_000);
  }
  weekday(day: number): number {
    return new Date(day * DAY_MS).getUTCDay();
  }
  dateKey(day: number): string {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
  }
  ddmm(day: number): string {
    const d = new Date(day * DAY_MS);
    return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}`;
  }

  /**
   * A day someone works: a weekday in the Horário de expediente of at least one of the connections, not a holiday of
   * its state or city (a partial holiday counts). No connection with a schedule: every day.
   */
  async isBusinessDay(day: number): Promise<boolean> {
    if (this.schedules.length === 0) return true;
    const key = this.dateKey(day);
    const weekday = WEEKDAYS[this.weekday(day)];
    for (const schedule of this.schedules) {
      if (await this.holidays(key, schedule.state, schedule.city)) {
        if ((schedule.partialHolidays as unknown as WorkSchedulePartialHolidayDTO[]).some((h) => h.date === key)) return true;
        continue;
      }
      if ((schedule.days as WorkScheduleDaysDTO)[weekday]) return true;
    }
    return false;
  }

  /** Saturday, Sunday or Monday to Friday — a Saturday is compared with a Saturday (often a shorter day). */
  private kind(day: number): number {
    const w = this.weekday(day);
    return w === 0 || w === 6 ? w : 1;
  }

  /** The last business day before `day` of the same kind; else the last business day; else the day before. */
  async previousBusinessDay(day: number): Promise<number> {
    let any: number | null = null;
    for (let d = day - 1; d >= day - LOOKBACK_DAYS; d--) {
      if (!(await this.isBusinessDay(d))) continue;
      if (this.kind(d) === this.kind(day)) return d;
      any ??= d;
    }
    return any ?? day - 1;
  }
}

/** The connections' schedules — every connection's when none is chosen. */
async function schedulesOf(connectionIds?: string[]): Promise<Schedule[]> {
  const rows = await prisma.whatsAppConnection.findMany({
    where: connectionIds === undefined ? {} : { id: { in: connectionIds } },
    select: { workSchedule: { select: { state: true, city: true, days: true, partialHolidays: true } } },
  });
  return rows.flatMap((r) => (r.workSchedule ? [r.workSchedule] : []));
}

/**
 * What the period is compared with — business days, as the Horário de expediente and the Feriados say, and only up
 * to the current time while the period includes today (a day that is still going is never compared with a whole one):
 *  - Hoje / Ontem: the last business day of the same kind before it (a Monday after a holiday Friday... a Saturday with
 *    the Saturday before);
 *  - Este mês: as many business days from the start of the month before;
 *  - Últimos 7 dias: the 7 days before; Mês anterior: the whole month before it; Personalizado: as many days right before.
 */
export async function comparisonWindow(input: {
  period: PeriodKey;
  from: Date;
  to: Date;
  tzOffsetMinutes: number;
  connectionIds?: string[];
  now?: Date;
}): Promise<ComparisonWindow> {
  const now = input.now ?? new Date();
  const cal = new Calendar(input.tzOffsetMinutes, await schedulesOf(input.connectionIds));
  const today = cal.dayOf(now);
  const fromDay = cal.dayOf(input.from);
  const toDay = cal.dayOf(input.to);
  const includesToday = toDay >= today;
  const intoToday = now.getTime() - cal.start(today).getTime();
  const local = new Date(now.getTime() - input.tzOffsetMinutes * 60_000);
  const until = ` até ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
  // The window from the start of `first` to the end of `last` — or, cut, to the current time of day on `last`.
  const span = (first: number, last: number, cut: boolean) => ({
    from: cal.start(first),
    to: cut ? new Date(cal.start(last).getTime() + intoToday) : new Date(cal.start(last + 1).getTime() - 1),
  });
  const dayLabel = (day: number, cut: boolean) => `${WEEKDAY_SHORT[cal.weekday(day)]} ${cal.ddmm(day)}${cut ? until : ""}`;
  const rangeLabel = (first: number, last: number, cut: boolean) =>
    first === last ? dayLabel(first, cut) : `${cal.ddmm(first).slice(0, 2)}${cal.ddmm(first).slice(3) === cal.ddmm(last).slice(3) ? "" : cal.ddmm(first).slice(2)} a ${cal.ddmm(last)}${cut ? until : ""}`;

  switch (input.period) {
    case "today":
    case "yesterday": {
      const base = input.period === "today" ? today : today - 1;
      const day = await cal.previousBusinessDay(base);
      const cut = input.period === "today";
      return { ...span(day, day, cut), label: dayLabel(day, cut) };
    }
    case "last7days": {
      const first = fromDay - 7;
      const last = toDay - 7;
      return { ...span(first, last, includesToday), label: rangeLabel(first, last, includesToday) };
    }
    case "month": {
      const start = new Date(fromDay * DAY_MS);
      const prevFirst = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1) / DAY_MS;
      const prevLast = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0) / DAY_MS;
      let businessDays = 0;
      for (let d = fromDay; d <= toDay; d++) if (await cal.isBusinessDay(d)) businessDays++;
      // Today is cut at the current time only when it is one of the business days counted.
      const cut = includesToday && (await cal.isBusinessDay(today));
      let last = Math.min(prevFirst + (toDay - fromDay), prevLast);
      if (businessDays > 0) {
        let counted = 0;
        for (let d = prevFirst; d <= prevLast; d++) {
          if (!(await cal.isBusinessDay(d))) continue;
          last = d;
          if (++counted === businessDays) break;
        }
      }
      return { ...span(prevFirst, last, cut), label: rangeLabel(prevFirst, last, cut) };
    }
    case "lastMonth": {
      const start = new Date(fromDay * DAY_MS);
      const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1) / DAY_MS;
      return { ...span(first, fromDay - 1, false), label: MONTHS[new Date(first * DAY_MS).getUTCMonth()] };
    }
    case "custom": {
      const length = toDay - fromDay + 1;
      return { ...span(fromDay - length, fromDay - 1, false), label: rangeLabel(fromDay - length, fromDay - 1, false) };
    }
  }
}
