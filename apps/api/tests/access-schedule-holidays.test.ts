import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import * as authService from "../src/modules/auth/auth.service";
import * as holidaysService from "../src/modules/holidays/holidays.service";
import { resolveAccessDecision, resolveLocalNow } from "../src/lib/access-schedule";
import { computeEasterSunday, computeMovableHolidays } from "../src/lib/easter";
import { resetDatabase, createTestUser } from "./helpers";

describe("access schedule + holiday blocking (login/refresh)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a blank accessSchedule never blocks login — see PROMPT: 24h sem bloqueio", async () => {
    await createTestUser({ email: "agent-open@test.dev", role: "AGENT" });
    const { user } = await authService.login("agent-open@test.dev", "Test@1234", null);
    expect(user.email).toBe("agent-open@test.dev");
  });

  it("blocks login outside today's configured weekday window", async () => {
    // Build a schedule where every weekday is closed right now (00:00-00:01,
    // effectively always in the past for any test run after midnight).
    const closedAllDay = { start: "00:00", end: "00:01" };
    await createTestUser({
      email: "agent-closed@test.dev",
      role: "AGENT",
      accessSchedule: { MON: closedAllDay, TUE: closedAllDay, WED: closedAllDay, THU: closedAllDay, FRI: closedAllDay, SAT: closedAllDay, SUN: closedAllDay },
    });
    await expect(authService.login("agent-closed@test.dev", "Test@1234", null)).rejects.toThrow(/permitido apenas das/i);
  });

  it("allows login when today's own weekday window covers right now, even with other days closed", async () => {
    const now = new Date();
    const { weekday } = resolveLocalNow(now, 0);
    const wideOpen = { start: "00:00", end: "23:59" };
    const closed = { start: "00:00", end: "00:01" };
    const schedule: Record<string, { start: string; end: string }> = {
      MON: closed, TUE: closed, WED: closed, THU: closed, FRI: closed, SAT: closed, SUN: closed,
    };
    schedule[weekday] = wideOpen;
    await createTestUser({ email: "agent-today-open@test.dev", role: "AGENT", accessSchedule: schedule });
    const { user } = await authService.login("agent-today-open@test.dev", "Test@1234", null);
    expect(user.email).toBe("agent-today-open@test.dev");
  });

  it("blocks login on a NATIONAL holiday for today, regardless of workState/workCity", async () => {
    await createTestUser({ email: "agent-holiday@test.dev", role: "AGENT" });
    const today = new Date();
    await prisma.holiday.create({
      data: { date: today, name: "Feriado de Teste", scope: "NATIONAL", source: "MANUAL", year: today.getFullYear() },
    });
    await expect(authService.login("agent-holiday@test.dev", "Test@1234", null)).rejects.toThrow(/feriado/i);
  });

  it("a STATE holiday only blocks a user whose workState matches", async () => {
    const today = new Date();
    await prisma.holiday.create({
      data: { date: today, name: "Feriado Estadual MT", scope: "STATE", state: "MT", source: "MANUAL", year: today.getFullYear() },
    });
    await createTestUser({ email: "agent-mt@test.dev", role: "AGENT", workState: "MT" });
    await createTestUser({ email: "agent-sp@test.dev", role: "AGENT", workState: "SP" });

    await expect(authService.login("agent-mt@test.dev", "Test@1234", null)).rejects.toThrow(/feriado/i);
    const { user } = await authService.login("agent-sp@test.dev", "Test@1234", null);
    expect(user.email).toBe("agent-sp@test.dev");
  });

  it("a MUNICIPAL holiday only blocks a user whose workState AND workCity both match", async () => {
    const today = new Date();
    await prisma.holiday.create({
      data: { date: today, name: "Aniversário de Cuiabá", scope: "MUNICIPAL", state: "MT", city: "Cuiabá", source: "MANUAL", year: today.getFullYear() },
    });
    await createTestUser({ email: "agent-cuiaba@test.dev", role: "AGENT", workState: "MT", workCity: "Cuiabá" });
    await createTestUser({ email: "agent-varzea@test.dev", role: "AGENT", workState: "MT", workCity: "Várzea Grande" });

    await expect(authService.login("agent-cuiaba@test.dev", "Test@1234", null)).rejects.toThrow(/feriado/i);
    const { user } = await authService.login("agent-varzea@test.dev", "Test@1234", null);
    expect(user.email).toBe("agent-varzea@test.dev");
  });

  it("ADMIN always bypasses both the schedule and holiday block — see PROMPT-driven safety valve against a full system lockout", async () => {
    const today = new Date();
    await prisma.holiday.create({
      data: { date: today, name: "Feriado de Teste", scope: "NATIONAL", source: "MANUAL", year: today.getFullYear() },
    });
    const closedAllDay = { start: "00:00", end: "00:01" };
    await createTestUser({
      email: "admin-bypass@test.dev",
      role: "ADMIN",
      accessSchedule: { MON: closedAllDay, TUE: closedAllDay, WED: closedAllDay, THU: closedAllDay, FRI: closedAllDay, SAT: closedAllDay, SUN: closedAllDay },
    });
    const { user } = await authService.login("admin-bypass@test.dev", "Test@1234", null);
    expect(user.email).toBe("admin-bypass@test.dev");
  });

  it("refresh() also enforces the window — a session can't outlive it by simply refreshing", async () => {
    await createTestUser({ email: "agent-refresh@test.dev", role: "AGENT" });
    const { refreshToken } = await authService.login("agent-refresh@test.dev", "Test@1234", null);

    const today = new Date();
    await prisma.holiday.create({
      data: { date: today, name: "Feriado de Teste", scope: "NATIONAL", source: "MANUAL", year: today.getFullYear() },
    });
    await expect(authService.refresh(refreshToken)).rejects.toThrow(/feriado/i);
  });
});

describe("resolveAccessDecision (pure logic)", () => {
  it("treats a day missing from the schedule as unrestricted", () => {
    const now = new Date();
    const { weekday } = resolveLocalNow(now, 0);
    const otherDay = weekday === "MON" ? "TUE" : "MON";
    const decision = resolveAccessDecision(now, 0, { [otherDay]: { start: "00:00", end: "00:01" } }, null);
    expect(decision.allowed).toBe(true);
    expect(decision.minutesRemainingToday).toBeNull();
  });

  it("computes minutesRemainingToday correctly inside an active window", () => {
    const now = new Date();
    const { weekday, minutesOfDay } = resolveLocalNow(now, 0);
    const endMinutes = minutesOfDay + 15;
    const end = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
    const decision = resolveAccessDecision(now, 0, { [weekday]: { start: "00:00", end } }, null);
    expect(decision.allowed).toBe(true);
    expect(decision.minutesRemainingToday).toBe(15);
  });

  it("a holiday takes precedence and reports no minutesRemainingToday", () => {
    const decision = resolveAccessDecision(new Date(), 0, null, "Feriado X");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("HOLIDAY");
    expect(decision.minutesRemainingToday).toBeNull();
  });
});

describe("computeMovableHolidays (Easter/Computus)", () => {
  // Cross-checked against independently known-correct Gregorian Easter dates.
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
  ])("computes Easter Sunday %i correctly", (year, expected) => {
    expect(computeEasterSunday(year).toISOString().slice(0, 10)).toBe(expected);
  });

  it("derives Carnaval, Sexta-feira Santa and Corpus Christi relative to Easter", () => {
    const holidays = computeMovableHolidays(2026);
    const byName = Object.fromEntries(holidays.map((h) => [h.name, h.date.toISOString().slice(0, 10)]));
    expect(byName["Páscoa"]).toBe("2026-04-05");
    expect(byName["Sexta-feira Santa"]).toBe("2026-04-03");
    expect(byName["Carnaval"]).toBe("2026-02-17");
    expect(byName["Corpus Christi"]).toBe("2026-06-04");
  });
});

describe("holidays.service — auto-sync never touches manual rows or duplicates itself", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("re-running syncNationalHolidays for a year already synced is a no-op (per-year cursor)", async () => {
    const year = new Date().getFullYear();
    const first = await holidaysService.syncNationalHolidays(year);
    expect(first.skipped).toBe(false);
    expect(first.imported).toBeGreaterThan(0);

    const countAfterFirst = await prisma.holiday.count({ where: { scope: "NATIONAL", year } });
    const second = await holidaysService.syncNationalHolidays(year);
    expect(second.skipped).toBe(true);
    const countAfterSecond = await prisma.holiday.count({ where: { scope: "NATIONAL", year } });
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("a manual holiday with the same date/name as an auto-imported one is never deleted or merged away", async () => {
    const year = new Date().getFullYear();
    await prisma.holiday.create({
      data: { date: new Date(Date.UTC(year, 11, 25)), name: "Natal", scope: "NATIONAL", source: "MANUAL", year },
    });
    await holidaysService.syncNationalHolidays(year);

    const rows = await prisma.holiday.findMany({ where: { scope: "NATIONAL", year, name: "Natal" } });
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.source === "MANUAL")).toBe(true);
    expect(rows.some((r) => r.source === "AUTO")).toBe(true);
  });

  it("updateManualHoliday refuses to edit an AUTO-imported row directly", async () => {
    const year = new Date().getFullYear();
    await holidaysService.syncNationalHolidays(year);
    const auto = await prisma.holiday.findFirstOrThrow({ where: { source: "AUTO" } });
    await expect(holidaysService.updateManualHoliday(auto.id, { name: "Alterado" })).rejects.toThrow(/nao podem ser editados/i);
  });
});
