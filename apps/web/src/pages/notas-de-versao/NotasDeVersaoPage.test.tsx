import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReleaseDTO, UserDTO } from "@whatsatendende/types";
import NotasDeVersaoPage from "./NotasDeVersaoPage";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(), patch: vi.fn() } }));

const RELEASES: ReleaseDTO[] = [
  { id: "b", version: "2.3.0", date: "09 out 2026", name: "Cadastro das notas", summary: "Notas editáveis.", notes: [{ type: "novo", area: "geral", title: "Notas de versão editáveis" }] },
  { id: "a", version: "2.2.0", date: "08 out 2026", name: "Apresentação", summary: "PowerPoint.", notes: [{ type: "melhoria", area: "dashboard", title: "Apresentação nova", before: "Simples", after: "Bonita" }] },
];

function renderPage() {
  vi.mocked(api.get).mockResolvedValue({ data: RELEASES } as never);
  vi.mocked(api.patch).mockResolvedValue({ data: {} } as never);
  useAuthStore.setState({ user: { id: "u1", role: "AGENT", releaseNotesSeenVersion: "2.2.0" } as UserDTO });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NotasDeVersaoPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Notas de versão (página)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mostra a versão atual vinda do servidor e marca como vista", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Cadastro das notas" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/release-notes");
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/profile/release-notes-seen", { version: "2.3.0" }));
  });

  it("escolher outra versão mostra as notas dela, com Antes e Agora", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /2\.2\.0/ }));
    expect(screen.getByRole("heading", { name: "Apresentação nova" })).toBeInTheDocument();
    expect(screen.getByText("Antes")).toBeInTheDocument();
    expect(screen.getByText("Agora")).toBeInTheDocument();
  });
});
