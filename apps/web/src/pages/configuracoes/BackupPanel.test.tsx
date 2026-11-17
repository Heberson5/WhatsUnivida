import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { BackupPanel } from "./BackupPanel";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() },
  getApiErrorMessage: () => "Erro",
}));

const INFO = { version: "2.37.7", tables: 85, approximateRows: 700, filesBytes: 5 * 1024 * 1024, whatsappSessionsBytes: 1024, last: null };

function settings(over: Record<string, unknown> = {}) {
  return {
    drive: { configured: false, connected: false, clientId: null, accountEmail: null, connectedAt: null, lastError: null, redirectUri: "https://whatsimagem.sauberlich.com.br/api/settings/backup/google-drive/callback", folderName: "Backups — whatsimagem.sauberlich.com.br" },
    hasBackupPassword: false,
    auto: { enabled: false, keep: 7, includeFiles: true, includeSessions: false },
    lastBackupAt: null,
    lastBackupSize: null,
    lastError: null,
    running: false,
    backupHour: 3,
    freeSpaceMb: 20_000,
    minFreeSpaceMb: 1024,
    keepRange: { min: 1, max: 60 },
    ...over,
  };
}

function mockApi(s: ReturnType<typeof settings>, files: unknown[] = []) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === "/settings/backup/info") return Promise.resolve({ data: INFO }) as never;
    if (url === "/settings/backup/settings") return Promise.resolve({ data: s }) as never;
    if (url === "/settings/backup/drive/files") return Promise.resolve({ data: { connected: true, files } }) as never;
    return Promise.reject(new Error(url)) as never;
  });
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/configuracoes?secao=backup"]}>
        <BackupPanel />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Configurações › Backup", () => {
  beforeEach(() => {
    for (const fn of [api.get, api.post, api.put, api.patch]) vi.mocked(fn).mockReset();
  });

  it("sem Drive conectado e sem senha: mostra o endereço de redirecionamento e não deixa ligar o automático", async () => {
    mockApi(settings());
    renderPanel();
    expect(await screen.findByDisplayValue(/\/api\/settings\/backup\/google-drive\/callback$/)).toBeInTheDocument();
    expect(screen.getByText(/Ainda não configurado/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Fazer backup todo dia a partir das 03h/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Fazer backup no Drive agora/ })).toBeDisabled();
  });

  it("conectado e com senha: lista os backups do Drive e pede RESTAURAR antes de restaurar", async () => {
    mockApi(
      settings({ drive: { ...settings().drive, configured: true, connected: true, accountEmail: "dono@gmail.com", connectedAt: "2026-11-17T12:00:00Z" }, hasBackupPassword: true, auto: { enabled: true, keep: 7, includeFiles: true, includeSessions: false } }),
      [{ id: "f1", name: "backup-whatsimagem-20261117-0300.wabk", size: 2 * 1024 * 1024, createdTime: "2026-11-17T07:00:00Z" }]
    );
    renderPanel();
    expect(await screen.findByText("dono@gmail.com")).toBeInTheDocument();
    expect(screen.getByText(/“Backups — whatsimagem.sauberlich.com.br”/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Fazer backup todo dia/ })).toBeChecked();
    expect(await screen.findByText("backup-whatsimagem-20261117-0300.wabk")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    const dialog = within(screen.getByText(/Restaurar o backup de/).parentElement!);
    const confirmButton = dialog.getByRole("button", { name: "Restaurar" });
    expect(confirmButton).toBeDisabled();
    vi.mocked(api.post).mockResolvedValue({ data: { version: "2.37.7", createdAt: "2026-11-17T07:00:00Z", rows: 10, files: 1, restarting: false } } as never);
    fireEvent.change(dialog.getAllByRole("textbox").at(-1)!, { target: { value: "restaurar" } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/settings/backup/drive/files/f1/restore", { confirm: "restaurar" }, { timeout: 0 }));
  });

  it("baixar exige a senha do arquivo (duas vezes, iguais) e já leva as conexões (sessões do WhatsApp)", async () => {
    mockApi(settings());
    renderPanel();
    const button = await screen.findByRole("button", { name: /Baixar backup/ });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Senha do arquivo/), { target: { value: "senha-forte-1" } });
    fireEvent.change(screen.getAllByPlaceholderText("Repita a senha").at(-1)!, { target: { value: "senha-forte-2" } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getAllByPlaceholderText("Repita a senha").at(-1)!, { target: { value: "senha-forte-1" } });
    expect(button).toBeEnabled();
    vi.mocked(api.post).mockResolvedValue({ data: { url: "/api/settings/backup/download/abc" } } as never);
    fireEvent.click(button);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/settings/backup/download-ticket", { files: true, sessions: true, password: "senha-forte-1" }));
  });
});
