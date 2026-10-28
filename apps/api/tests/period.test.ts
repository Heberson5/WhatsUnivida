import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolvePeriod, optionalDateQueryParam } from "../src/lib/period";

// UTC-4 (Cuiabá/Tangará da Serra, MT) — Brazil has had no DST since 2019, so
// this is a fixed offset in minutes, matching JS Date#getTimezoneOffset().
const CUIABA_OFFSET_MINUTES = 240;

describe("resolvePeriod (browser-timezone-aware day boundaries)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps 'today' on the correct calendar day even when the server's own UTC clock has already rolled to tomorrow", () => {
    // 2026-08-21 23:30 in Cuiabá (UTC-4) is 2026-08-22 03:30 UTC — the
    // server's own (UTC) calendar day is already the 22nd.
    vi.setSystemTime(new Date("2026-08-22T03:30:00.000Z"));

    const { from, to } = resolvePeriod("today", undefined, undefined, CUIABA_OFFSET_MINUTES);

    // Expected local-midnight-to-midnight window, expressed back in UTC.
    expect(from.toISOString()).toBe("2026-08-21T04:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-22T03:59:59.999Z");
  });

  it("computes 'yesterday' relative to the client's calendar day, not the server's", () => {
    vi.setSystemTime(new Date("2026-08-22T03:30:00.000Z")); // 2026-08-21 23:30 local
    const { from, to } = resolvePeriod("yesterday", undefined, undefined, CUIABA_OFFSET_MINUTES);
    expect(from.toISOString()).toBe("2026-08-20T04:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-21T03:59:59.999Z");
  });

  it("resolves 'custom' from a plain YYYY-MM-DD pair to that exact local calendar day", () => {
    const from = new Date("2026-08-01"); // parsed as UTC midnight by z.coerce.date()
    const to = new Date("2026-08-05");
    const result = resolvePeriod("custom", from, to, CUIABA_OFFSET_MINUTES);
    expect(result.from.toISOString()).toBe("2026-08-01T04:00:00.000Z");
    expect(result.to.toISOString()).toBe("2026-08-06T03:59:59.999Z");
  });

  it("falls back to UTC (offset 0) when no offset is supplied, matching the previous behavior", () => {
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const { from, to } = resolvePeriod("today");
    expect(from.toISOString()).toBe("2026-08-21T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-21T23:59:59.999Z");
  });

  it("rolls 'lastMonth' across a year boundary correctly", () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    const { from, to } = resolvePeriod("lastMonth", undefined, undefined, CUIABA_OFFSET_MINUTES);
    expect(from.toISOString()).toBe("2025-12-01T04:00:00.000Z");
    expect(to.toISOString()).toBe("2026-01-01T03:59:59.999Z");
  });
});

describe("optionalDateQueryParam", () => {
  // Regression: the period-filter UI sends `from`/`to` as `""` (not simply
  // omitted) whenever the selected period isn't "custom". Plain
  // `z.coerce.date().optional()` rejected that empty string (`new Date("")`
  // is invalid), 400ing every dashboard/reports/oversight request the
  // moment a user touched the period or connection filter.
  it("treats an empty string the same as an absent value", () => {
    expect(optionalDateQueryParam.parse("")).toBeUndefined();
    expect(optionalDateQueryParam.parse(undefined)).toBeUndefined();
  });

  it("still parses a real date string", () => {
    const result = optionalDateQueryParam.parse("2026-08-01");
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("still rejects a genuinely invalid (non-empty) date string", () => {
    expect(() => optionalDateQueryParam.parse("not-a-date")).toThrow();
  });
});
