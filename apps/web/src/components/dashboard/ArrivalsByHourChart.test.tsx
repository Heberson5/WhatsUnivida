import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ArrivalsByHourDTO } from "@whatsatendende/types";
import { ArrivalsByHourChart } from "./ArrivalsByHourChart";

// recharts' ResponsiveContainer needs it; jsdom has none.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const data: ArrivalsByHourDTO = {
  hours: Array.from({ length: 24 }, (_, hour) => ({ hour, inside: hour === 10 ? 3 : 0, outside: hour === 5 ? 8 : 0, onlineAvg: 0, days: 1 })),
  summary: { withActivity: 20, openedByCustomer: 11, startedByTeam: 4, fromEarlierDays: 5 },
};

function renderChart(onOpenInGestao = vi.fn()) {
  render(
    <ArrivalsByHourChart
      data={data}
      isLoading={false}
      isToday={false}
      primaryColor="#0097B4"
      initialRange={{ start: 8, end: 20 }}
      onSaveDefaultRange={() => undefined}
      onOpenInGestao={onOpenInGestao}
    />
  );
  return onOpenInGestao;
}

describe("Dashboard › Conversas que chegam ao longo do dia", () => {
  it("explica a diferença para a Gestão e abre a lista das abertas pelo cliente", () => {
    const open = renderChart();
    expect(screen.getByTestId("arrivals-breakdown")).toHaveTextContent(
      "De 20 conversas com movimento no período (as que a Gestão lista): 11 abertas pelo cliente · 4 iniciadas pela equipe · 5 vindas de dias anteriores"
    );
    fireEvent.click(screen.getByRole("button", { name: "11 abertas pelo cliente" }));
    expect(open).toHaveBeenCalledWith(null);
  });

  it("avisa das conversas nas horas escondidas e mostra todas as horas", () => {
    renderChart();
    expect(screen.getByText(/8 conversas chegaram fora das horas mostradas \(05h\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar todas as horas" }));
    expect(screen.queryByText(/fora das horas mostradas/)).not.toBeInTheDocument();
  });
});
