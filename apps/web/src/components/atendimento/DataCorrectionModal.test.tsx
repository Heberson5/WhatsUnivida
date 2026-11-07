import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DataCorrectionModal } from "./DataCorrectionModal";
import { api } from "../../lib/api";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

const correction = {
  id: "c1",
  createdAt: "2026-11-07T12:00:00.000Z",
  cpf: "***.982.247-**",
  clientName: "Maria Aparecida da Silva",
  registeredAddress: "Rua das Flores, 100, Centro",
  informedName: "Maria da Silva",
  informedAddress: "Avenida Brasil, 2000",
  contactPhone: "5565988887777",
  registeredPhones: "5565999991111",
  resolvedAt: null,
  resolvedByName: null,
};

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DataCorrectionModal conversationId="conv-1" />
    </QueryClientProvider>
  );
}

describe("Pop-up de cadastro desatualizado", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it("mostra o que o cliente informou e o que está no cadastro", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [correction] });
    renderModal();
    expect(await screen.findByText("Cadastro desatualizado")).toBeTruthy();
    expect(screen.getByText("Avenida Brasil, 2000")).toBeTruthy();
    expect(screen.getByText("Rua das Flores, 100, Centro")).toBeTruthy();
    expect(screen.getByText(/não está no cadastro deste CPF/)).toBeTruthy();
  });

  it("Cadastro já atualizado registra quem e quando (no servidor) e o aviso some", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [correction] }).mockResolvedValue({ data: [] });
    vi.mocked(api.post).mockResolvedValue({ data: { ...correction, resolvedAt: "2026-11-07T13:00:00.000Z", resolvedByName: "Ana" } });
    renderModal();
    fireEvent.click(await screen.findByText("Cadastro já atualizado"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/conversations/conv-1/data-corrections/c1/resolve"));
    await waitFor(() => expect(screen.queryByText("Cadastro desatualizado")).toBeNull());
  });

  it("Lembrar depois só fecha nesta conversa — o cadastro continua pendente", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [correction] });
    renderModal();
    fireEvent.click(await screen.findByText("Lembrar depois"));
    await waitFor(() => expect(screen.queryByText("Cadastro desatualizado")).toBeNull());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("sem pendência, nada aparece", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    renderModal();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText("Cadastro desatualizado")).toBeNull();
  });
});
