import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ContactListItemDTO, UserDTO } from "@whatsatendende/types";
import { NovaConversaModal } from "./NovaConversaModal";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() }, getApiErrorMessage: () => "Erro" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const contact = (over: Partial<ContactListItemDTO>): ContactListItemDTO => ({
  id: "c1",
  name: "Marina Alves",
  phone: "5565999990001",
  channel: "WHATSAPP",
  connectionName: "Vendas",
  whatsappConnectionId: "vendas",
  contractNumber: null,
  contracts: [],
  firstName: null,
  tags: [],
  conversationCount: 2,
  firstConversationAt: "2026-10-01T10:00:00.000Z",
  lastInteractionAt: "2026-10-08T10:00:00.000Z",
  ...over,
});

function renderModal(fixedConnectionId: string | null) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NovaConversaModal fixedConnectionId={fixedConnectionId} onClose={() => undefined} onStarted={() => undefined} />
    </QueryClientProvider>
  );
}

describe("Nova conversa › buscar nos contatos digitando", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: "u1", role: "ADMIN" } as UserDTO, permissions: { "contatos.acessar": true } as never });
    vi.mocked(api.get).mockImplementation((url: string, config?: { params?: unknown }) => {
      const search = (config?.params as { search?: string } | undefined)?.search;
      if (url === "/contacts") return Promise.resolve({ data: { items: search ? [contact({})] : [], total: 1 } }) as never;
      if (url === "/settings/phone") return Promise.resolve({ data: { defaultCountryCodeEnabled: true, defaultCountryCode: "55", fixExtraNineEnabled: true } }) as never;
      return Promise.resolve({ data: [{ id: "vendas", name: "Vendas" }] }) as never;
    });
    vi.mocked(api.post).mockResolvedValue({ data: { id: "conv-1" } } as never);
  });

  it("acha o contato do sistema antes de escolher a conexão e inicia pela conexão dele", async () => {
    renderModal(null);
    fireEvent.change(screen.getByLabelText("Buscar contato por nome ou número"), { target: { value: "mar" } });
    fireEvent.click(await screen.findByRole("button", { name: /Marina Alves/ }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/conversations/start", { connectionId: "vendas", phone: "5565999990001", name: "Marina Alves" })
    );
    expect(api.get).toHaveBeenCalledWith("/contacts", expect.objectContaining({ params: expect.objectContaining({ search: "mar" }) }));
  });

  it("um número digitado que não está nos contatos pode ser iniciado direto", async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === "/contacts") return Promise.resolve({ data: { items: [], total: 0 } }) as never;
      if (url === "/settings/phone") return Promise.resolve({ data: { defaultCountryCodeEnabled: true, defaultCountryCode: "55", fixExtraNineEnabled: true } }) as never;
      return Promise.resolve({ data: [] }) as never;
    });
    renderModal("suporte");
    fireEvent.change(screen.getByLabelText("Buscar contato por nome ou número"), { target: { value: "65 98888-7777" } });
    fireEvent.click(await screen.findByRole("button", { name: /Iniciar conversa com/ }));
    expect(screen.getByDisplayValue("65 98888-7777")).toBeInTheDocument();
  });
});
