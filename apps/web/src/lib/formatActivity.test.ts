import { describe, it, expect } from "vitest";
import { formatActivity } from "./formatActivity";

// Built from local-time parts so the tests don't depend on the machine's timezone.
const local = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute);
const now = local(2026, 10, 8, 15, 0);

describe("formatActivity", () => {
  it("says hoje and ontem with the time", () => {
    expect(formatActivity(local(2026, 10, 8, 14, 32), now)).toBe("hoje 14:32");
    expect(formatActivity(local(2026, 10, 8, 0, 5), now)).toBe("hoje 00:05");
    expect(formatActivity(local(2026, 10, 7, 18, 10), now)).toBe("ontem 18:10");
    expect(formatActivity(local(2026, 10, 7, 0, 0), now)).toBe("ontem 00:00");
  });

  it("uses day/month for older days of the same year", () => {
    expect(formatActivity(local(2026, 10, 6, 9, 12), now)).toBe("06/10 09:12");
    expect(formatActivity(local(2026, 1, 2, 23, 59), now)).toBe("02/01 23:59");
  });

  it("adds the year for another year", () => {
    expect(formatActivity(local(2025, 12, 31, 8, 0), now)).toBe("31/12/2025 08:00");
  });

  it("counts yesterday across a month and year boundary", () => {
    expect(formatActivity(local(2026, 9, 30, 20, 0), local(2026, 10, 1, 9, 0))).toBe("ontem 20:00");
    expect(formatActivity(local(2025, 12, 31, 20, 0), local(2026, 1, 1, 9, 0))).toBe("ontem 20:00");
  });

  it("accepts an ISO string", () => {
    expect(formatActivity(local(2026, 10, 8, 14, 32).toISOString(), now)).toBe("hoje 14:32");
  });
});
