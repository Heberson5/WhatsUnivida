import { describe, it, expect } from "vitest";
import { localDay, nextSend, sendDays, type ScheduleRule } from "../src/modules/report-schedules/schedule-dates";
import { nextDay, occursOn } from "../src/modules/announcements/announcement-days";

const TZ = 240; // UTC-4, Cuiabá
const noHoliday = () => false;

function rule(partial: Partial<ScheduleRule>): ScheduleRule {
  return {
    frequency: "DAILY",
    time: "08:00",
    tzOffsetMinutes: TZ,
    startDate: "2026-11-02",
    weekdays: [],
    monthDay: null,
    month: null,
    customInterval: 1,
    customUnit: "DAY",
    endType: "NEVER",
    endAfter: null,
    endDate: null,
    skipSaturday: false,
    skipSunday: false,
    ...partial,
  };
}

/** 08:00 in Cuiabá of `day` is 12:00 UTC. */
const at = (day: string, hhmm = "12:00") => new Date(`${day}T${hhmm}:00.000Z`);
const days = (r: ScheduleRule, n = 10) => sendDays(r, at("2026-11-01", "00:00"), 800, noHoliday).slice(0, n);

describe("agendamento da apresentação — datas de envio", () => {
  it("envia no horário escolhido, no fuso de quem agendou", () => {
    const next = nextSend(rule({}), at("2026-11-01", "00:00"), noHoliday);
    expect(next?.toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(localDay(next!, TZ)).toBe("2026-11-02");
  });

  it("diário que pula sábado e domingo: o fim de semana vai para segunda, uma vez só", () => {
    // 2026-11-06 is a Friday.
    expect(days(rule({ startDate: "2026-11-05", skipSaturday: true, skipSunday: true }), 4)).toEqual(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"]);
  });

  it("pular só o domingo: o sábado continua", () => {
    expect(days(rule({ startDate: "2026-11-06", skipSunday: true }), 3)).toEqual(["2026-11-06", "2026-11-07", "2026-11-09"]);
  });

  it("feriado do cadastro passa para o próximo dia livre", () => {
    // Monday 2026-11-02 (Finados) is a holiday: the weekly Monday send goes on Tuesday.
    const isHoliday = (d: string) => d === "2026-11-02";
    const r = rule({ frequency: "WEEKLY", weekdays: [1] });
    expect(sendDays(r, at("2026-11-01", "00:00"), 15, isHoliday)).toEqual(["2026-11-03", "2026-11-09"]);
  });

  it("feriado na sexta com fim de semana pulado vai para segunda", () => {
    const isHoliday = (d: string) => d === "2026-11-20";
    const r = rule({ frequency: "WEEKLY", weekdays: [5], startDate: "2026-11-20", skipSaturday: true, skipSunday: true });
    expect(sendDays(r, at("2026-11-19"), 5, isHoliday)).toEqual(["2026-11-23"]);
  });

  it("semanal em vários dias da semana", () => {
    expect(days(rule({ frequency: "WEEKLY", weekdays: [1, 3, 5] }), 4)).toEqual(["2026-11-02", "2026-11-04", "2026-11-06", "2026-11-09"]);
  });

  it("quinzenal: semana sim, semana não, a partir do início", () => {
    expect(days(rule({ frequency: "BIWEEKLY" }), 3)).toEqual(["2026-11-02", "2026-11-16", "2026-11-30"]);
  });

  it("mensal no dia 31 cai no último dia dos meses mais curtos", () => {
    expect(days(rule({ frequency: "MONTHLY", startDate: "2026-11-01", monthDay: 31 }), 4)).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  });

  it("anual no mês e dia escolhidos", () => {
    expect(days(rule({ frequency: "YEARLY", startDate: "2026-11-01", month: 1, monthDay: 5 }), 2)).toEqual(["2027-01-05", "2028-01-05"]);
  });

  it("personalizado: a cada 3 dias, a cada 2 semanas na terça, a cada 2 meses no dia 10", () => {
    expect(days(rule({ frequency: "CUSTOM", customInterval: 3, customUnit: "DAY" }), 3)).toEqual(["2026-11-02", "2026-11-05", "2026-11-08"]);
    expect(days(rule({ frequency: "CUSTOM", customInterval: 2, customUnit: "WEEK", weekdays: [2] }), 2)).toEqual(["2026-11-03", "2026-11-17"]);
    expect(days(rule({ frequency: "CUSTOM", customInterval: 2, customUnit: "MONTH", monthDay: 10, startDate: "2026-11-01" }), 2)).toEqual(["2026-11-10", "2027-01-10"]);
  });

  it("termina após X envios ou numa data", () => {
    expect(nextSend(rule({ endType: "AFTER", endAfter: 3 }), at("2026-11-01"), noHoliday, 3)).toBeNull();
    expect(nextSend(rule({ endType: "AFTER", endAfter: 3 }), at("2026-11-01"), noHoliday, 2)).not.toBeNull();
    expect(days(rule({ endType: "ON_DATE", endDate: "2026-11-04" }))).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
  });

  it("depois de enviar, o próximo é o seguinte, nunca o mesmo de novo", () => {
    const r = rule({});
    const sent = nextSend(r, at("2026-11-01", "00:00"), noHoliday)!;
    expect(nextSend(r, sent, noHoliday)?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
  });
});

describe("avisos do Pop Up — dias em que aparecem", () => {
  const base = { startDate: "2026-11-02", endDate: "2026-12-31" };

  it("1 vez por semana: no mesmo dia da semana do início", () => {
    const weekly = { ...base, recurrence: "WEEKLY" as const };
    expect(occursOn(weekly, "2026-11-09")).toBe(true);
    expect(occursOn(weekly, "2026-11-10")).toBe(false);
    expect(nextDay(weekly, "2026-11-03")).toBe("2026-11-09");
  });

  it("1 vez por mês: no dia do início, ou no último dia de um mês mais curto", () => {
    const monthly = { startDate: "2027-01-31", endDate: null, recurrence: "MONTHLY" as const };
    expect(occursOn(monthly, "2027-02-28")).toBe(true);
    expect(occursOn(monthly, "2027-03-31")).toBe(true);
    expect(occursOn(monthly, "2027-03-30")).toBe(false);
  });

  it("só no dia de início, e nada depois da data de término", () => {
    expect(occursOn({ ...base, recurrence: "ONCE" }, "2026-11-02")).toBe(true);
    expect(occursOn({ ...base, recurrence: "ONCE" }, "2026-11-03")).toBe(false);
    expect(occursOn({ ...base, recurrence: "DAILY" }, "2027-01-01")).toBe(false);
    expect(nextDay({ ...base, recurrence: "DAILY" }, "2027-01-01")).toBeNull();
  });
});
