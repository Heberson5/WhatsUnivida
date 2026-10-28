import { describe, expect, it } from "vitest";
import type { BusinessClockDTO } from "@whatsatendende/types";
import { businessMinutesSince, waitPaused } from "./business-wait";

const weekday = { allDay: false, start: "08:00", end: "18:00" };
// São Paulo (UTC-3), Monday to Friday 08:00–18:00.
const clock: BusinessClockDTO = {
  state: "SP",
  days: { MON: weekday, TUE: weekday, WED: weekday, THU: weekday, FRI: weekday },
  partialHolidays: [],
  holidays: [],
};
const at = (iso: string) => new Date(iso).getTime();

describe("business wait", () => {
  it("counts only the Horário de expediente: 17:58 → 08:00 next day is 2 minutes", () => {
    // 2026-10-21 is a Wednesday.
    expect(businessMinutesSince(clock, "2026-10-21T17:58:00-03:00", at("2026-10-22T08:00:00-03:00"))).toBe(2);
  });

  it("skips the weekend and holidays", () => {
    // Friday 17:50 → Monday 08:10 = 10 + 10 minutes.
    expect(businessMinutesSince(clock, "2026-10-23T17:50:00-03:00", at("2026-10-26T08:10:00-03:00"))).toBe(20);
    expect(businessMinutesSince({ ...clock, holidays: ["2026-10-26"] }, "2026-10-23T17:50:00-03:00", at("2026-10-27T08:10:00-03:00"))).toBe(20);
  });

  it("counts the whole time without a schedule and says when the wait is paused", () => {
    expect(businessMinutesSince(null, "2026-10-21T17:58:00-03:00", at("2026-10-22T08:00:00-03:00"))).toBe(842);
    expect(waitPaused(clock, at("2026-10-21T20:00:00-03:00"))).toBe(true);
    expect(waitPaused(clock, at("2026-10-21T10:00:00-03:00"))).toBe(false);
    expect(waitPaused(null, at("2026-10-21T20:00:00-03:00"))).toBe(false);
  });
});
