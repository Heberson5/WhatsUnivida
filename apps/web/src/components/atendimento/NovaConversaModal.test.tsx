import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PhoneLookupDTO } from "@whatsatendende/types";
import { NovaConversaModal } from "./NovaConversaModal";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn() },
  getApiErrorMessage: () => "Não foi possível iniciar",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SETTINGS_ON = { defaultCountryCodeEnabled: true, defaultCountryCode: "55", fixExtraNineEnabled: true };
const SETTINGS_OFF = { defaultCountryCodeEnabled: false, defaultCountryCode: "55", fixExtraNineEnabled: false };

type Lookup = Pick<PhoneLookupDTO, "exists" | "phone" | "normalizedPhone"> & Partial<PhoneLookupDTO>;

function givenApi(settings: object, partial: Lookup | "falha") {
  const lookup: PhoneLookupDTO | "falha" = partial === "falha" ? partial : { unverifiable: false, checkedByConnectionName: null, ...partial };
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/settings/phone") return Promise.resolve({ data: settings }) as never;
    if (url.endsWith("/lookup-number")) return lookup === "falha" ? (Promise.reject(new Error("fora do ar")) as never) : (Promise.resolve({ data: lookup }) as never);
    return Promise.resolve({ data: [] }) as never; // device contacts
  });
  vi.mocked(api.post).mockResolvedValue({ data: { id: "conversa-1" } } as never);
}

async function openNovoNumero() {
  const onStarted = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NovaConversaModal fixedConnectionId="conexao-1" onClose={() => undefined} onStarted={onStarted} />
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Novo número" }));
  return { onStarted, phoneInput: await screen.findByLabelText(/^número/i) };
}

describe("Nova conversa › Novo número", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it("não pede o DDI e avisa qual será usado", async () => {
    givenApi(SETTINGS_ON, { exists: true, phone: "556599286623", normalizedPhone: "556599286623" });
    const { phoneInput } = await openNovoNumero();
    expect(await screen.findByText("Número (DDI opcional)")).toBeInTheDocument();
    expect(await screen.findByText("Sem o DDI, usamos +55.")).toBeInTheDocument();
    expect(phoneInput).toHaveAttribute("placeholder", "65 99999-9999");
  });

  it("mostra o número que será usado e que foi confirmado no WhatsApp, e inicia com o que foi digitado", async () => {
    givenApi(SETTINGS_ON, { exists: true, phone: "556599286623", normalizedPhone: "556599286623" });
    const { phoneInput, onStarted } = await openNovoNumero();

    await screen.findByText("Número (DDI opcional)"); // settings loaded
    fireEvent.change(phoneInput, { target: { value: "65999286623" } });
    expect(await screen.findByText("Número com WhatsApp.")).toBeInTheDocument();
    expect(screen.getByText("+55 65 9928-6623")).toBeInTheDocument(); // "Será usado": 55 added, the extra 9 dropped

    fireEvent.click(screen.getByRole("button", { name: /iniciar conversa/i }));
    // The server applies the same rules and is the one that decides — the screen sends what was typed.
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/conversations/start", { connectionId: "conexao-1", phone: "65999286623", name: null }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it("mostra a forma com o 9 quando é a que o WhatsApp confirmou", async () => {
    givenApi(SETTINGS_ON, { exists: true, phone: "5565999286623", normalizedPhone: "556599286623" });
    const { phoneInput } = await openNovoNumero();
    fireEvent.change(phoneInput, { target: { value: "65999286623" } });
    expect(await screen.findByText("Número com WhatsApp.")).toBeInTheDocument();
    expect(screen.getByText("+55 65 99928-6623")).toBeInTheDocument();
  });

  it("diz qual número foi conferido quando ele não está no WhatsApp, e não deixa iniciar", async () => {
    givenApi(SETTINGS_ON, { exists: false, phone: null, normalizedPhone: "556599286623" });
    const { phoneInput } = await openNovoNumero();
    fireEvent.change(phoneInput, { target: { value: "65999286623" } });
    expect(await screen.findByText(/não está no whatsapp \(conferido: \+55 65 9928-6623\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iniciar conversa/i })).toBeDisabled();
  });

  it("bloqueia quando o WhatsApp não pôde ser consultado, e deixa tentar de novo", async () => {
    givenApi(SETTINGS_ON, { exists: null, phone: null, normalizedPhone: "556599286623" });
    const { phoneInput } = await openNovoNumero();
    fireEvent.change(phoneInput, { target: { value: "65999286623" } });
    expect(await screen.findByText("Não foi possível verificar o número agora.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iniciar conversa/i })).toBeDisabled();
  });

  it("API Oficial: mostra a conexão de QR Code que verificou", async () => {
    givenApi(SETTINGS_ON, { exists: true, phone: "556599286623", normalizedPhone: "556599286623", checkedByConnectionName: "Suporte" });
    const { phoneInput } = await openNovoNumero();
    fireEvent.change(phoneInput, { target: { value: "65999286623" } });
    expect(await screen.findByText("Número com WhatsApp (verificado pela conexão Suporte).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iniciar conversa/i })).toBeEnabled();
  });

  it("API Oficial sem conexão de QR Code: deixa iniciar sem verificação, com aviso", async () => {
    givenApi(SETTINGS_ON, { exists: null, phone: null, normalizedPhone: "556599286623", unverifiable: true });
    const { phoneInput } = await openNovoNumero();
    fireEvent.change(phoneInput, { target: { value: "65999286623" } });
    expect(await screen.findByText(/Não há conexão de QR Code conectada/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iniciar conversa/i })).toBeEnabled();
  });

  it("com o DDI padrão desligado, volta a pedir o número completo", async () => {
    givenApi(SETTINGS_OFF, { exists: true, phone: "5511999999999", normalizedPhone: "5511999999999" });
    const { phoneInput } = await openNovoNumero();
    expect(await screen.findByText("Número (com DDI e DDD)")).toBeInTheDocument();
    expect(phoneInput).toHaveAttribute("placeholder", "5511999999999");
    expect(screen.queryByText(/sem o ddi, usamos/i)).not.toBeInTheDocument();
  });
});
