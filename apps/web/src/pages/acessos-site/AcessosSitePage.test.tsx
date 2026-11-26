import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AcessosSitePage, { formatDuration } from "./AcessosSitePage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn() },
  getApiErrorMessage: () => "Erro",
}));
// The charts need a real layout (ResizeObserver): here only their titles matter.
vi.mock("../../components/dashboard/SeriesChartCard", () => ({ SeriesChartCard: ({ title }: { title: string }) => <div>{title}</div> }));
vi.mock("../../components/dashboard/DistributionChartCard", () => ({ DistributionChartCard: ({ title }: { title: string }) => <div>{title}</div> }));
vi.mock("../../hooks/useBranding", () => ({ useBranding: () => ({ data: { primaryColor: "#0097B4", secondaryColor: "#FFE450" } }) }));

const SUMMARY = {
  sites: ["whatsatendente.sauberlich.com.br", "www.sauberlich.com.br"],
  totals: { visits: 120, visitors: 80, newVisitors: 50, avgDurationSeconds: 95, bounceRate: 0.25, loginRate: 0.6 },
  previous: { visits: 100, visitors: 70, avgDurationSeconds: 80 },
  byDay: [{ day: "2026-11-25", visits: 60, visitors: 40 }, { day: "2026-11-26", visits: 60, visitors: 40 }],
  byHour: Array(24).fill(5),
  byWeekday: Array(7).fill(10),
  pages: [{ path: "/login", visits: 100, avgDurationSeconds: 90 }],
  referrers: [{ key: "google.com", visits: 70 }],
  campaigns: [],
  devices: [{ key: "Celular", visits: 70 }],
  browsers: [{ key: "Chrome", visits: 60 }],
  systems: [{ key: "Android", visits: 50 }],
  places: [{ key: "Cuiabá, Mato Grosso, Brasil", visits: 40 }],
};
const LIVE = {
  now: 1,
  visits: [{ id: "v1", site: "www.sauberlich.com.br", path: "/", referrer: null, campaign: "natal · instagram", device: "Celular", browser: "Safari", os: "iOS", place: "Cuiabá, Mato Grosso, Brasil", startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), durationSeconds: 42, loggedIn: false, returning: true }],
};

describe("Acessos ao site", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/site-analytics/summary") return Promise.resolve({ data: SUMMARY }) as never;
      if (url === "/site-analytics/live") return Promise.resolve({ data: LIVE }) as never;
      if (url === "/site-analytics/visits") return Promise.resolve({ data: { total: 1, page: 1, pageSize: 50, visits: LIVE.visits } }) as never;
      if (url === "/site-analytics/settings") return Promise.resolve({ data: { retentionDays: 365 } }) as never;
      return Promise.reject(new Error(url)) as never;
    });
  });

  it("formata o tempo na página", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(95)).toBe("1 min 35 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(7500)).toBe("2 h 05 min");
  });

  it("mostra os números do período, quem está no site agora e o código para outros sites", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AcessosSitePage />
      </QueryClientProvider>
    );
    expect(await screen.findByText("120")).toBeInTheDocument();
    expect(screen.getByText("Tempo médio na página")).toBeInTheDocument();
    expect(screen.getByText("Visitas por dia")).toBeInTheDocument();
    expect(screen.getByText("Aparelhos")).toBeInTheDocument();
    expect(screen.getByText("1 min 35 s")).toBeInTheDocument();
    expect(screen.getByText("Entraram no sistema")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(await screen.findByText(/No site agora \(1\)/)).toBeInTheDocument();
    expect(screen.getAllByText("natal · instagram").length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Site" })).toBeInTheDocument();
    expect((screen.getByLabelText("Código de acompanhamento") as HTMLInputElement).value).toBe(`<script async src="${window.location.origin}/api/public/site/tracker.js"></script>`);
  });
});
