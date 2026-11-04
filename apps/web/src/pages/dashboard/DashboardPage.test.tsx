import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PERMISSION, type PermissionMap } from "@whatsatendende/types";
import DashboardPage from "./DashboardPage";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { exportDashboardHtml, exportDashboardPptx } from "../../lib/exportDashboardPptx";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(), patch: vi.fn() }, getApiErrorMessage: () => "erro" }));
vi.mock("../../lib/exportDashboardPptx", () => ({ exportDashboardPptx: vi.fn(async () => undefined), exportDashboardHtml: vi.fn(async () => undefined) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// The charts themselves are not under test here.
vi.mock("../../components/dashboard/TeamCards", () => ({ TeamNowCard: () => null, AgentsTable: () => null }));
vi.mock("../../components/dashboard/DistributionChartCard", () => ({ DistributionChartCard: () => null }));
vi.mock("../../components/dashboard/SeriesChartCard", () => ({ SeriesChartCard: () => null }));
vi.mock("../../components/dashboard/WordCloudCard", () => ({ WordCloudCard: () => null }));
vi.mock("../../components/dashboard/SatisfactionCard", () => ({ SatisfactionCard: () => null }));
vi.mock("../../components/dashboard/PresenceByHourChart", () => ({ PresenceByHourChart: () => null }));
vi.mock("../../components/dashboard/ArrivalsByHourChart", () => ({ ArrivalsByHourChart: () => null }));

const DASHBOARD = {
  conversations: { received: 10, unique: 8, inProgress: 2, closed: 7, closedNoReturn: 1, waiting: 1 },
  messages: { received: 40, sent: 50, total: 90 },
  timings: { avgAcceptMs: 60000, avgFirstResponseMs: 120000, avgHandlingMs: 600000, avgClosingMs: 700000 },
  perAgent: [],
  users: { online: 1, active: 2, total: 3 },
  previous: { received: 9, unique: 7, closed: 6, messagesTotal: 80, avgFirstResponseMs: 150000 },
};

function renderAs(role: "ADMIN" | "MANAGER" | "AGENT") {
  vi.mocked(api.get).mockImplementation(((url: string) => {
    if (url === "/dashboard") return Promise.resolve({ data: DASHBOARD });
    if (url === "/whatsapp/connections") return Promise.resolve({ data: [{ id: "c1", name: "Suporte" }, { id: "c2", name: "Vendas" }] });
    if (url === "/agents") return Promise.resolve({ data: [{ id: "u1", displayName: "Ana" }] });
    if (url === "/settings/export-branding") return Promise.resolve({ data: { companyName: "Empresa Demo", primaryColor: "#0097B4", logoUrl: null } });
    return Promise.resolve({ data: null });
  }) as never);
  useAuthStore.setState({ user: { role } as never, permissions: { [PERMISSION.DASHBOARD_ACESSAR]: true } as unknown as PermissionMap });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Dashboard: apresentação para a diretoria", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(exportDashboardPptx).mockClear();
    vi.mocked(exportDashboardHtml).mockClear();
  });

  it.each(["ADMIN", "MANAGER"] as const)("%s vê o botão e baixa a apresentação com o período e os filtros da tela", async (role) => {
    renderAs(role);
    const button = await screen.findByRole("button", { name: /^Apresentação$/ });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: /PowerPoint \(\.pptx\)/ }));
    await waitFor(() => expect(exportDashboardPptx).toHaveBeenCalledTimes(1));
    expect(vi.mocked(exportDashboardPptx).mock.calls[0][0]).toMatchObject({
      period: { period: "today" },
      scopeLabel: "Todas as conexões · todos os atendentes",
      data: DASHBOARD,
      branding: { companyName: "Empresa Demo" },
    });
    // The same presentation as an HTML page, from the same menu.
    fireEvent.click(await screen.findByRole("button", { name: /^Apresentação$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Página HTML \(\.html\)/ }));
    await waitFor(() => expect(exportDashboardHtml).toHaveBeenCalledTimes(1));
    expect(vi.mocked(exportDashboardHtml).mock.calls[0][0]).toMatchObject({ period: { period: "today" }, data: DASHBOARD });
  });

  it("um atendente que recebeu acesso ao Dashboard não vê o botão", async () => {
    renderAs("AGENT");
    await screen.findByText("Conversas recebidas");
    expect(screen.queryByRole("button", { name: /^Apresentação$/ })).not.toBeInTheDocument();
  });
});
