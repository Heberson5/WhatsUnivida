import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistenteSimulador } from "./AssistenteSimulador";
import { AssistenteDadosClientes } from "./AssistenteDadosClientes";
import { api } from "../../lib/api";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

function renderIt(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("Assistente Virtual: simulador e dados dos clientes", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it("simula e mostra cada passo e o que o assistente faria", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [{ id: "conn-1", name: "Central" }] });
    vi.mocked(api.post).mockResolvedValue({
      data: {
        steps: [
          { title: "Entendimento", status: "ok", detail: "Pedido: boleto (pelas palavras da mensagem)." },
          { title: "Dados dos clientes", status: "stop", detail: "Não dá para consultar: a fonte de dados está desativada." },
        ],
        outcome: "Pediria o CPF, avisaria o cliente e passaria para a equipe.",
      },
    });
    renderIt(<AssistenteSimulador />);
    await screen.findByRole("option", { name: "Central" });
    fireEvent.change(screen.getByPlaceholderText("000.000.000-00"), { target: { value: "529.982.247-25" } });
    fireEvent.click(screen.getByRole("button", { name: /Simular/ }));
    expect(await screen.findByText(/a fonte de dados está desativada/)).toBeTruthy();
    expect(screen.getByText(/Pediria o CPF, avisaria o cliente/)).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/settings/ai-assistant/simulate", { connectionId: "conn-1", message: "Quero o boleto", cpf: "529.982.247-25", when: "now" });
  });

  it("dados dos clientes: mostra o motivo quando não dá para consultar", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: [
        {
          connectionId: "conn-1",
          connectionName: "Univida TGS Atendimento",
          sourceName: "Planilha",
          status: "STALE",
          dataUpdatedAt: "2026-11-06T10:00:00.000Z",
          maxAgeHours: 24,
          closedNow: false,
          usableNow: false,
          staleToleranceHours: 72,
          reason: 'os dados da fonte "Planilha" passaram do prazo de atualização de 24 horas',
        },
      ],
    });
    renderIt(<AssistenteDadosClientes />);
    await waitFor(() => expect(screen.getByText("Univida TGS Atendimento")).toBeTruthy());
    expect(screen.getByText(/passaram do prazo de atualização de 24 horas/)).toBeTruthy();
    expect(screen.getByText(/até 72 horas além do prazo/)).toBeTruthy();
  });
});
