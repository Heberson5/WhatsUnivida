import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PERMISSION, type PermissionMap } from "@whatsatendende/types";
import { NumerosTelefonePanel } from "./NumerosTelefonePanel";
import { useAuthStore } from "../../store/auth-store";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), patch: vi.fn() },
  getApiErrorMessage: () => "Não foi possível salvar",
}));

const STORED = { defaultCountryCodeEnabled: true, defaultCountryCode: "55", fixExtraNineEnabled: true };

function renderPanel(canEdit = true) {
  useAuthStore.setState({ permissions: { [PERMISSION.CONFIGURACOES_TELEFONE_EDITAR]: canEdit } as PermissionMap });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NumerosTelefonePanel />
    </QueryClientProvider>
  );
}

describe("Configurações › Números de telefone", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.patch).mockReset();
    vi.mocked(api.get).mockResolvedValue({ data: STORED } as never);
    vi.mocked(api.patch).mockImplementation((_url, body) => Promise.resolve({ data: body }) as never);
  });

  it("mostra o que está salvo: as duas opções ligadas e o DDI 55", async () => {
    renderPanel();
    expect(await screen.findByRole("switch", { name: /incluir o ddi padrão/i })).toBeChecked();
    expect(screen.getByRole("switch", { name: /corrigir o dígito 9/i })).toBeChecked();
    expect(screen.getByLabelText(/^ddi padrão/i)).toHaveValue("55");
    expect(screen.queryByText(/você tem alterações não salvas/i)).not.toBeInTheDocument();
  });

  it("testa um número com as opções do formulário, mesmo antes de salvar", async () => {
    renderPanel();
    await screen.findByRole("switch", { name: /incluir o ddi padrão/i });
    const example = screen.getByLabelText(/testar um número/i);

    fireEvent.change(example, { target: { value: "65999286623" } });
    expect(screen.getByText("+55 65 9928-6623")).toBeInTheDocument(); // 55 added, extra 9 dropped
    expect(screen.getByText(/tenta também/i)).toHaveTextContent("+55 65 99928-6623"); // the other form, if WhatsApp doesn't know the first

    fireEvent.click(screen.getByRole("switch", { name: /corrigir o dígito 9/i }));
    expect(screen.getByText("+55 65 99928-6623")).toBeInTheDocument(); // typed as it is
    expect(screen.queryByText(/tenta também/i)).not.toBeInTheDocument();
  });

  it("não mexe no número de SP, onde o WhatsApp mantém o 9", async () => {
    renderPanel();
    await screen.findByRole("switch", { name: /incluir o ddi padrão/i });
    fireEvent.change(screen.getByLabelText(/testar um número/i), { target: { value: "11 98765-4321" } });
    expect(screen.getByText("+55 11 98765-4321")).toBeInTheDocument();
    expect(screen.getByText(/tenta também/i)).toHaveTextContent("+55 11 8765-4321");
  });

  it("salva as alterações e some com o aviso de não salvo", async () => {
    renderPanel();
    await screen.findByRole("switch", { name: /incluir o ddi padrão/i });

    fireEvent.change(screen.getByLabelText(/^ddi padrão/i), { target: { value: "351" } });
    fireEvent.click(screen.getByRole("switch", { name: /corrigir o dígito 9/i }));
    expect(screen.getByText(/você tem alterações não salvas/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /salvar alterações/i }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/settings/phone", { defaultCountryCodeEnabled: true, defaultCountryCode: "351", fixExtraNineEnabled: false }));
    await waitFor(() => expect(screen.queryByText(/você tem alterações não salvas/i)).not.toBeInTheDocument());
  });

  it("só aceita números no DDI e não deixa salvar sem ele", async () => {
    renderPanel();
    await screen.findByRole("switch", { name: /incluir o ddi padrão/i });
    const ddi = screen.getByLabelText(/^ddi padrão/i);

    fireEvent.change(ddi, { target: { value: "5a5b" } });
    expect(ddi).toHaveValue("55");

    fireEvent.change(ddi, { target: { value: "" } });
    expect(screen.getByRole("button", { name: /salvar alterações/i })).toBeDisabled();
  });

  it("descarta as alterações", async () => {
    renderPanel();
    await screen.findByRole("switch", { name: /incluir o ddi padrão/i });
    fireEvent.click(screen.getByRole("switch", { name: /incluir o ddi padrão/i }));
    expect(screen.getByRole("switch", { name: /incluir o ddi padrão/i })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /descartar/i }));
    expect(screen.getByRole("switch", { name: /incluir o ddi padrão/i })).toBeChecked();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("sem permissão de editar, só mostra: nada muda e não há botão de salvar", async () => {
    renderPanel(false);
    const ddiSwitch = await screen.findByRole("switch", { name: /incluir o ddi padrão/i });
    expect(ddiSwitch).toBeDisabled();
    expect(screen.getByLabelText(/^ddi padrão/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /salvar alterações/i })).not.toBeInTheDocument();
  });
});
