import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReleaseDTO, UserDTO } from "@whatsatendende/types";
import { WhatsNewModal } from "./WhatsNewModal";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(), patch: vi.fn() } }));

const RELEASES: ReleaseDTO[] = [
  { id: "c", version: "2.2.1", date: "09 out 2026", name: "Logoff por inatividade", summary: "Logoff.", notes: [{ type: "correcao", area: "geral", title: "Logoff volta a funcionar", text: "Sessão parada é encerrada." }] },
  { id: "b", version: "2.1.9", date: "08 out 2026", name: "Abrir arquivos", summary: "PDF.", notes: [{ type: "melhoria", area: "atendimento", title: "Imprimir PDF", text: "Botão Imprimir." }] },
  { id: "a", version: "2.1.1", date: "06 out 2026", name: "Já vista", summary: "Antiga.", notes: [{ type: "novo", area: "geral", title: "Novidade antiga", text: "Já vista." }] },
];

function renderModal(seen: string | null) {
  vi.mocked(api.get).mockResolvedValue({ data: RELEASES } as never);
  vi.mocked(api.patch).mockResolvedValue({ data: {} } as never);
  useAuthStore.setState({ user: { id: "u1", role: "AGENT", releaseNotesSeenVersion: seen } as UserDTO });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <WhatsNewModal />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("O que há de novo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("quem volta depois de várias versões vê as novidades de todas elas, e fechar marca a mais nova como vista", async () => {
    renderModal("2.1.1");
    expect(await screen.findByRole("heading", { name: "O que há de novo desde a sua última visita" })).toBeInTheDocument();
    expect(screen.getByText("Versões 2.1.9 a 2.2.1")).toBeInTheDocument();
    expect(screen.getByText("Logoff volta a funcionar")).toBeInTheDocument();
    expect(screen.getByText("Imprimir PDF")).toBeInTheDocument();
    expect(screen.queryByText("Novidade antiga")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" })[0]);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/profile/release-notes-seen", { version: "2.2.1" }));
  });

  it("com uma versão nova só, mostra o nome dela", async () => {
    renderModal("2.1.9");
    expect(await screen.findByRole("heading", { name: "O que há de novo: Logoff por inatividade" })).toBeInTheDocument();
    expect(screen.queryByText("Imprimir PDF")).not.toBeInTheDocument();
  });

  it("quem nunca abriu as notas vê só a versão atual, não o histórico inteiro", async () => {
    renderModal(null);
    expect(await screen.findByRole("heading", { name: "O que há de novo: Logoff por inatividade" })).toBeInTheDocument();
    expect(screen.queryByText("Novidade antiga")).not.toBeInTheDocument();
  });
});
