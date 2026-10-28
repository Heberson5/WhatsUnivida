import { describe, it, expect } from "vitest";
import { compareWithPrevious, describePeriod, formatMinutes, npsDelta, npsZone, percentOf } from "./dashboardMetrics";

// Thursday 8 Oct 2026, 17:42 local time.
const NOW = new Date(2026, 9, 8, 17, 42);

describe("describePeriod — o período por extenso, com os mesmos dias que a API conta", () => {
  it.each([
    [{ period: "today" as const }, "Hoje", "08/10/2026"],
    [{ period: "yesterday" as const }, "Ontem", "07/10/2026"],
    [{ period: "last7days" as const }, "Últimos 7 dias", "02/10 a 08/10/2026"],
    [{ period: "month" as const }, "Este mês", "outubro de 2026, até 08/10"],
    [{ period: "lastMonth" as const }, "Mês anterior", "setembro de 2026"],
    [{ period: "custom" as const, from: "2026-09-15", to: "2026-10-05" }, "Período personalizado", "15/09 a 05/10/2026"],
    [{ period: "custom" as const, from: "2025-12-20", to: "2026-01-10" }, "Período personalizado", "20/12/2025 a 10/01/2026"],
    [{ period: "all" as const }, "Todo o período", "desde o início do uso do sistema"],
  ])("%j", (period, name, dates) => {
    expect(describePeriod(period, NOW)).toEqual({ name, dates });
  });

  it("os 7 dias e o mês anterior atravessam a virada do ano", () => {
    expect(describePeriod({ period: "last7days" }, new Date(2027, 0, 3))).toEqual({ name: "Últimos 7 dias", dates: "28/12/2026 a 03/01/2027" });
    expect(describePeriod({ period: "lastMonth" }, new Date(2027, 0, 3)).dates).toBe("dezembro de 2026");
  });

  it("personalizado ainda sem as datas não inventa um intervalo", () => {
    expect(describePeriod({ period: "custom" }, NOW).dates).toBe("datas escolhidas no Dashboard");
  });
});

describe("npsZone — as zonas usuais do NPS, na escala de 0 a 100", () => {
  it.each([
    [100, "Zona de excelência"],
    [88, "Zona de excelência"],
    [87, "Zona de qualidade"],
    [75, "Zona de qualidade"],
    [74, "Zona de aperfeiçoamento"],
    [50, "Zona de aperfeiçoamento"],
    [49, "Zona crítica"],
    [0, "Zona crítica"],
  ])("NPS %i → %s", (nps, label) => {
    expect(npsZone(nps).label).toBe(label);
  });
});

describe("npsDelta — comparação com o período anterior", () => {
  it("diz quantos pontos subiu ou caiu", () => {
    expect(npsDelta(78, 72)).toEqual({ text: "▲ 6 pontos", tone: "up" });
    expect(npsDelta(70, 71)).toEqual({ text: "▼ 1 ponto", tone: "down" });
    expect(npsDelta(70, 70)).toEqual({ text: "= igual", tone: "same" });
    expect(npsDelta(70, null)).toBeNull();
  });
});

describe("números do Dashboard", () => {
  it("comparação com o período anterior: mais é bom, menos tempo também", () => {
    expect(compareWithPrevious(112, 100)).toEqual({ text: "12% vs período anterior", good: true, up: true });
    expect(compareWithPrevious(80, 100, true)).toEqual({ text: "20% vs período anterior", good: true, up: false });
    expect(compareWithPrevious(100, 100)).toEqual({ text: "igual ao período anterior", good: true, up: false });
    expect(compareWithPrevious(10, 0)).toBeNull();
    expect(compareWithPrevious(null, 10)).toBeNull();
  });

  it("minutos e porcentagens", () => {
    expect(formatMinutes(null)).toBe("-");
    expect(formatMinutes(2.6 * 60000)).toBe("3 min");
    expect(formatMinutes(42_400)).toBe("42 s");
    expect(formatMinutes(59_600)).toBe("1 min");
    expect(formatMinutes(61 * 60000)).toBe("1h 1min");
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(5, 0)).toBe(0);
  });
});
