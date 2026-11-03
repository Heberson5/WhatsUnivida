import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { comparisonWindow } from "../src/lib/compare-period";
import { resolvePeriod } from "../src/lib/period";
import { resetDatabase } from "./helpers";

// Tangará da Serra (UTC-4): terça 03/11/2026 às 14:18. Segunda 02/11 é feriado; o expediente vai de segunda a sábado.
const TZ = 240;
const NOW = new Date("2026-11-03T18:18:00.000Z");
const window = async (period: "today" | "yesterday" | "month" | "last7days" | "lastMonth", connectionIds?: string[], now = NOW) => {
  const realNow = Date.now;
  Date.now = () => now.getTime();
  try {
    const { from, to } = resolvePeriod(period, undefined, undefined, TZ);
    return await comparisonWindow({ period, from, to, tzOffsetMinutes: TZ, connectionIds, now });
  } finally {
    Date.now = realNow;
  }
};

describe("Dashboard: com o que os cartões comparam", () => {
  let connectionId: string;

  beforeAll(async () => {
    await resetDatabase();
    const week = { start: "07:00", end: "18:00" };
    const schedule = await prisma.workSchedule.create({
      data: { name: "Seg a Sáb", state: "MT", city: "Tangará da Serra", days: { MON: week, TUE: week, WED: week, THU: week, FRI: week, SAT: { start: "07:00", end: "11:00" } }, closedMessage: "Fechado." },
    });
    connectionId = (await prisma.whatsAppConnection.create({ data: { name: "Comparação", status: "CONNECTED", workScheduleId: schedule.id } })).id;
    await prisma.holiday.deleteMany({ where: { date: new Date("2026-11-02") } });
    await prisma.holiday.create({ data: { date: new Date("2026-11-02"), name: "Finados", scope: "NATIONAL", source: "MANUAL", year: 2026 } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("hoje (terça, depois do feriado): a sexta anterior até a mesma hora, não o feriado nem o sábado", async () => {
    const w = await window("today", [connectionId]);
    expect(w.label).toBe("sex 30/10 até 14:18");
    expect(w.from.toISOString()).toBe("2026-10-30T04:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-10-30T18:18:00.000Z");
  });

  it("um sábado é comparado com o sábado anterior", async () => {
    const w = await window("today", [connectionId], new Date("2026-11-07T13:00:00.000Z"));
    expect(w.label).toBe("sáb 31/10 até 09:00");
  });

  it("ontem (feriado) é comparado com o dia útil de segunda a sexta antes dele, inteiro", async () => {
    const w = await window("yesterday", [connectionId]);
    expect(w.label).toBe("sex 30/10");
    expect(w.to.toISOString()).toBe("2026-10-31T03:59:59.999Z");
  });

  it("este mês: tantos dias úteis quanto os do mês até hoje, desde o começo do mês anterior", async () => {
    // Novembro até agora: domingo 01, feriado 02 e terça 03 — 1 dia útil. Outubro: quinta 01.
    expect((await window("month", [connectionId])).label).toBe("qui 01/10 até 14:18");
    // Na sexta 06/11 são 4 dias úteis (03, 04, 05 e 06): 01, 02, 03 (sábado) e 05/10.
    expect((await window("month", [connectionId], new Date("2026-11-06T15:00:00.000Z"))).label).toBe("01 a 05/10 até 11:00");
  });

  it("últimos 7 dias e mês anterior", async () => {
    expect((await window("last7days", [connectionId])).label).toBe("21 a 27/10 até 14:18");
    expect((await window("lastMonth", [connectionId])).label).toBe("setembro");
  });

  it("sem horário de expediente na conexão, todo dia conta", async () => {
    const plain = (await prisma.whatsAppConnection.create({ data: { name: "Sem expediente", status: "CONNECTED" } })).id;
    expect((await window("today", [plain])).label).toBe("seg 02/11 até 14:18");
  });
});
