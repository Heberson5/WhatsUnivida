import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ContactListItemDTO, UserDTO } from "@whatsatendende/types";
import ContatosPage from "./ContatosPage";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() }, getApiErrorMessage: () => "Erro" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const marina: ContactListItemDTO = {
  id: "c1",
  name: "Marina Alves",
  phone: "5565999990001",
  channel: "WHATSAPP",
  connectionName: "Suporte",
  whatsappConnectionId: "suporte",
  contractNumber: null,
  contracts: [],
  firstName: null,
  tags: [],
  conversationCount: 3,
  firstConversationAt: "2026-09-01T10:00:00.000Z",
  lastInteractionAt: "2026-10-08T10:00:00.000Z",
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/contatos"]}>
        <Routes>
          <Route path="/contatos" element={<ContatosPage />} />
          <Route path="/atendimento" element={<p>Tela do Atendimento</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Contatos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: "a1", role: "AGENT" } as UserDTO, permissions: { "contatos.acessar": true, "atendimento.acessar": true } as never });
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/contacts") return Promise.resolve({ data: { items: [marina], total: 1 } }) as never;
      return Promise.resolve({ data: [] }) as never;
    });
    vi.mocked(api.post).mockResolvedValue({ data: { id: "conv-9" } } as never);
  });

  it("cada coluna ordena pelo tipo do dado: texto de A a Z primeiro, números e datas do maior para o menor", async () => {
    renderPage();
    await screen.findByText("Marina Alves");
    const sortOf = () => (vi.mocked(api.get).mock.calls.filter(([url]) => url === "/contacts").at(-1)![1] as { params: { sort: string; dir: string } }).params;
    expect(sortOf()).toMatchObject({ sort: "lastInteractionAt", dir: "desc" });

    fireEvent.click(screen.getByRole("button", { name: "Nome" }));
    await waitFor(() => expect(sortOf()).toMatchObject({ sort: "name", dir: "asc" }));
    expect(screen.getByRole("columnheader", { name: "Nome" })).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: "Nome" }));
    await waitFor(() => expect(sortOf()).toMatchObject({ sort: "name", dir: "desc" }));

    fireEvent.click(screen.getByRole("button", { name: "Conversas" }));
    await waitFor(() => expect(sortOf()).toMatchObject({ sort: "conversations", dir: "desc" }));
    fireEvent.click(screen.getByRole("button", { name: "Primeiro contato" }));
    await waitFor(() => expect(sortOf()).toMatchObject({ sort: "firstConversationAt", dir: "desc" }));
  });

  it("o atendente inicia a conversa pela lista e vai direto para o Atendimento", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Iniciar conversa com Marina Alves" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/conversations/start", { phone: "5565999990001", name: "Marina Alves", connectionId: undefined }));
    expect(await screen.findByText("Tela do Atendimento")).toBeInTheDocument();
    // An attendant doesn't load the connection list (they only see their own).
    expect(api.get).not.toHaveBeenCalledWith("/whatsapp/connections");
  });
});
