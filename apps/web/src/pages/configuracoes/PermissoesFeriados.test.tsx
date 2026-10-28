import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PERMISSION, type PermissionMap } from "@whatsatendende/types";
import { PermissionsPanel } from "./PermissionsPanel";
import { FeriadosPanel } from "./FeriadosPanel";
import { useAuthStore } from "../../store/auth-store";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: () => "Erro",
}));
vi.mock("../../components/common/ColumnViewMenu", () => ({ ColumnViewMenu: () => null }));
vi.mock("../../hooks/useColumnView", () => ({
  useColumnView: (screen: string) => ({
    visibleKeys: screen === "permissoes" ? ["permission", "ADMIN", "AGENT", "MANAGER"] : ["date", "name", "scope", "source", "repeat"],
  }),
}));

function renderWithQuery(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const definitions = [
  { key: "a.ver", group: "Atendimento", label: "Ver atendimento", description: "", editableRoles: ["AGENT", "MANAGER"], defaultAllowed: { AGENT: true, MANAGER: true } },
  { key: "r.ver", group: "Respostas", label: "Ver respostas", description: "", editableRoles: ["AGENT", "MANAGER"], defaultAllowed: { AGENT: false, MANAGER: true } },
];
const matrix = { ADMIN: { "a.ver": true, "r.ver": true }, AGENT: { "a.ver": true, "r.ver": false }, MANAGER: { "a.ver": true, "r.ver": true } };

describe("Configurações › Permissões: recolher e expandir", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.get).mockResolvedValue({ data: { definitions, matrix } } as never);
  });

  it("abre tudo expandido; a seta recolhe um menu e os botões recolhem e expandem todos", async () => {
    renderWithQuery(<PermissionsPanel />);
    expect(await screen.findByText("Ver atendimento")).toBeInTheDocument();
    expect(screen.getByText("Ver respostas")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Respostas" }));
    expect(screen.getByRole("button", { name: "Respostas" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Ver respostas")).not.toBeInTheDocument();
    expect(screen.getByText("Ver atendimento")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Recolher tudo" }));
    expect(screen.queryByText("Ver atendimento")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expandir tudo" }));
    expect(screen.getByText("Ver atendimento")).toBeInTheDocument();
    expect(screen.getByText("Ver respostas")).toBeInTheDocument();
  });
});

describe("Configurações › Feriados: editar e repetir todo ano", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.patch).mockReset();
    useAuthStore.setState({
      permissions: {
        [PERMISSION.CONFIGURACOES_FERIADOS_ADICIONAR]: true,
        [PERMISSION.CONFIGURACOES_FERIADOS_EDITAR]: true,
        [PERMISSION.CONFIGURACOES_FERIADOS_EXCLUIR]: true,
      } as PermissionMap,
    });
    vi.mocked(api.get).mockResolvedValue({
      data: [{ id: "h1", date: "2026-11-20", name: "Consciência Negra", scope: "NATIONAL", state: null, city: null, source: "MANUAL", recurringYearly: false }],
    } as never);
    vi.mocked(api.patch).mockResolvedValue({ data: {} } as never);
  });

  it("mostra a coluna Repete e salva a edição marcada como anual", async () => {
    renderWithQuery(<FeriadosPanel />);
    expect(await screen.findByText("Consciência Negra")).toBeInTheDocument();
    expect(screen.getByText("Repete")).toBeInTheDocument();
    expect(screen.getByText("Só este ano")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Editar Consciência Negra" }));
    expect(screen.getByText("Editar feriado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /repete todo ano/i }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/holidays/h1", expect.objectContaining({ name: "Consciência Negra", date: "2026-11-20", recurringYearly: true }))
    );
  });
});
