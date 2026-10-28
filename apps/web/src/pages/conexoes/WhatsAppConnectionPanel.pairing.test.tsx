import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PERMISSION, type PermissionMap } from "@whatsatendende/types";
import { WhatsAppConnectionPanel } from "./WhatsAppConnectionPanel";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getApiErrorMessage: () => "erro" }));
vi.mock("../../lib/socket", () => ({ getSocket: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./WorkScheduleSelect", () => ({ WorkScheduleSelect: () => null }));

const base = {
  id: "c1",
  name: "Loja Centro",
  color: "#F97316",
  connectionMode: "QRCODE" as const,
  groupsEnabled: false,
  groupsCount: 0,
  workScheduleId: null,
  deviceReplyTimeoutMinutes: 5,
  qrCodeDataUrl: null,
  connectedNumber: null,
  linkedNumber: null,
  lastConnectedAt: null,
  contactsSyncedAt: null,
  agentCount: 0,
};
const withCode = { ...base, state: "CODE_PENDING", pairingCode: "K7PQ-2M9X", pairingCodeExpiresAt: new Date(Date.now() + 45_000).toISOString(), pairingPhoneNumber: "5565988887777" };
// What a status read caught in the middle of WhatsApp's own reconnect used to bring: no code.
const midReconnect = { ...base, state: "CONNECTING", pairingCode: null, pairingCodeExpiresAt: null, pairingPhoneNumber: null };

let current: object[] = [withCode];

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <WhatsAppConnectionPanel />
      </QueryClientProvider>
    </MemoryRouter>
  );
  return client;
}

describe("Conexões: código de conexão pelo número", () => {
  beforeEach(() => {
    current = [withCode];
    vi.mocked(api.get).mockImplementation(((url: string) => Promise.resolve({ data: url === "/whatsapp/connections" ? current : [] })) as never);
    useAuthStore.setState({
      user: { role: "ADMIN" } as never,
      permissions: { [PERMISSION.CONEXOES_WHATSAPP_EDITAR]: true, [PERMISSION.CONEXOES_GERENCIAR]: true } as unknown as PermissionMap,
    });
  });

  it("mostra o código com o tempo de validade, e ele não some numa leitura no meio da reconexão", async () => {
    const client = renderPanel();
    expect(await screen.findByRole("text", { name: "Código K7PQ-2M9X" })).toBeInTheDocument();
    expect(screen.getByText(/Válido por mais/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar novo código" })).toBeInTheDocument();

    current = [midReconnect];
    await act(() => client.invalidateQueries({ queryKey: ["whatsapp-connections"] }));
    expect(screen.getByRole("text", { name: "Código K7PQ-2M9X" })).toBeInTheDocument();
    expect(screen.queryByText("Gerando...")).not.toBeInTheDocument();
  });

  it("um código novo entra direto no lugar do anterior", async () => {
    const client = renderPanel();
    await screen.findByRole("text", { name: "Código K7PQ-2M9X" });
    current = [{ ...withCode, pairingCode: "AB12-CD34", pairingCodeExpiresAt: new Date(Date.now() + 60_000).toISOString() }];
    await act(() => client.invalidateQueries({ queryKey: ["whatsapp-connections"] }));
    expect(await screen.findByRole("text", { name: "Código AB12-CD34" })).toBeInTheDocument();
  });

  it("se o WhatsApp encerra a tentativa, avisa e oferece gerar um novo código", async () => {
    const client = renderPanel();
    await screen.findByRole("text", { name: "Código K7PQ-2M9X" });
    current = [{ ...midReconnect, state: "DISCONNECTED" }];
    await act(() => client.invalidateQueries({ queryKey: ["whatsapp-connections"] }));
    expect(await screen.findByText(/O WhatsApp encerrou esta tentativa/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gerar novo código/ })).toBeInTheDocument();
  });
});
