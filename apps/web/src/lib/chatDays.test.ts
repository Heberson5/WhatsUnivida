import { describe, it, expect } from "vitest";
import { dayLabel, groupByDay } from "./chatDays";

// Built from local-time parts so the tests don't depend on the machine's timezone.
const local = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute);

describe("dayLabel", () => {
  // Wednesday, 7 Oct 2026
  const today = local(2026, 10, 7, 0, 0);

  it("calls the current day Hoje and the one before Ontem, at any hour", () => {
    expect(dayLabel(local(2026, 10, 7, 0, 0), today)).toBe("Hoje");
    expect(dayLabel(local(2026, 10, 7, 23, 59), today)).toBe("Hoje");
    expect(dayLabel(local(2026, 10, 6, 23, 59), today)).toBe("Ontem");
    expect(dayLabel(local(2026, 10, 6, 0, 0), today)).toBe("Ontem");
  });

  it("uses the weekday name for the 5 days before Ontem", () => {
    expect(dayLabel(local(2026, 10, 5), today)).toBe("Segunda-feira");
    expect(dayLabel(local(2026, 10, 4), today)).toBe("Domingo");
    expect(dayLabel(local(2026, 10, 3), today)).toBe("Sábado");
    expect(dayLabel(local(2026, 10, 2), today)).toBe("Sexta-feira");
    expect(dayLabel(local(2026, 10, 1), today)).toBe("Quinta-feira");
  });

  it("switches to the full date at 7 days, when the weekday would repeat today's", () => {
    expect(dayLabel(local(2026, 9, 30), today)).toBe("30/09/2026");
    expect(dayLabel(local(2026, 9, 25), today)).toBe("25/09/2026");
    expect(dayLabel(local(2025, 1, 3), today)).toBe("03/01/2025");
  });

  it("counts calendar days across a month and a year boundary", () => {
    const newYear = local(2026, 1, 2, 0, 0);
    expect(dayLabel(local(2026, 1, 1), newYear)).toBe("Ontem");
    expect(dayLabel(local(2025, 12, 31), newYear)).toBe("Quarta-feira");
    expect(dayLabel(local(2025, 12, 27), newYear)).toBe("Sábado"); // 6 days back: the last one still named by weekday
    expect(dayLabel(local(2025, 12, 26), newYear)).toBe("26/12/2025"); // 7 days back
    expect(dayLabel(local(2025, 12, 25), newYear)).toBe("25/12/2025");
  });

  it("never labels a timestamp slightly in the future (clock skew) as anything but Hoje", () => {
    expect(dayLabel(local(2026, 10, 8, 0, 5), today)).toBe("Hoje");
  });

  it("accepts a timestamp in milliseconds", () => {
    expect(dayLabel(local(2026, 10, 6).getTime(), today)).toBe("Ontem");
  });
});

describe("groupByDay", () => {
  const entry = (id: string, date: Date) => ({ id, at: date.getTime() });

  it("returns nothing for an empty thread", () => {
    expect(groupByDay([])).toEqual([]);
  });

  it("makes one group per calendar day, keeping the order", () => {
    const entries = [
      entry("a", local(2026, 10, 5, 9, 12)),
      entry("b", local(2026, 10, 5, 9, 14)),
      entry("c", local(2026, 10, 6, 16, 40)),
      entry("d", local(2026, 10, 7, 8, 31)),
      entry("e", local(2026, 10, 7, 8, 35)),
    ];
    const groups = groupByDay(entries);
    expect(groups.map((g) => g.key)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([["a", "b"], ["c"], ["d", "e"]]);
    expect(groups[0].at).toBe(entries[0].at);
    expect(groups[2].at).toBe(entries[3].at);
  });

  it("starts a new day exactly at local midnight", () => {
    const groups = groupByDay([entry("late", local(2026, 10, 6, 23, 59)), entry("early", local(2026, 10, 7, 0, 0))]);
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([["late"], ["early"]]);
  });

  it("keeps an out-of-order entry with the day it follows instead of repeating a day", () => {
    // e.g. a note stamped 23:59 on the 6th that is listed after a message from the 7th
    const groups = groupByDay([entry("m1", local(2026, 10, 6, 20, 0)), entry("m2", local(2026, 10, 7, 0, 5)), entry("late-note", local(2026, 10, 6, 23, 59)), entry("m3", local(2026, 10, 7, 0, 10))]);
    expect(groups.map((g) => g.key)).toEqual(["2026-10-06", "2026-10-07"]);
    expect(groups[1].entries.map((e) => e.id)).toEqual(["m2", "late-note", "m3"]);
  });

  it("uses the first entry of each day for the day's own time", () => {
    const groups = groupByDay([entry("a", local(2026, 10, 6, 8, 0)), entry("b", local(2026, 10, 6, 22, 0))]);
    expect(groups).toHaveLength(1);
    expect(groups[0].at).toBe(local(2026, 10, 6, 8, 0).getTime());
  });
});
