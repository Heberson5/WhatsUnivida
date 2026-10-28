import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PERMISSION, type QuickReplyDTO } from "@whatsatendende/types";
import { QuickReplyFormModal } from "./QuickReplyFormModal";
import { useAuthStore } from "../../store/auth-store";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() }, getApiErrorMessage: (e: unknown) => String(e) }));

const LIMITS = { imageMb: 5, videoMb: 16, documentMb: 30 };

function renderForm(canEditMedia: boolean, quickReply: QuickReplyDTO | null = null) {
  useAuthStore.setState({ permissions: { [PERMISSION.RESPOSTAS_MIDIA_GERENCIAR]: canEditMedia } as never });
  vi.mocked(api.get).mockImplementation(((url: string) =>
    Promise.resolve({ data: url === "/quick-replies/media-limits" ? LIMITS : String(url).endsWith("/media") ? new Blob(["x"]) : [] })) as never);
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <QuickReplyFormModal quickReply={quickReply} onClose={() => undefined} onSubmit={onSubmit} />
    </QueryClientProvider>
  );
  return onSubmit;
}

function fillRequired(text = "Segue o catálogo") {
  fireEvent.change(screen.getByPlaceholderText("Ex: Boas-vindas"), { target: { value: "Catálogo" } });
  fireEvent.change(screen.getByPlaceholderText("boasvindas"), { target: { value: "catalogo" } });
  fireEvent.change(screen.getByPlaceholderText("Texto que será inserido no campo de mensagem..."), { target: { value: text } });
  fireEvent.click(screen.getByRole("radio", { name: "Todas as conexões" }));
}

/** The limits come from the server — the file can be chosen once they are in. */
const limitsLoaded = () => screen.findByText(/até 30 MB/);

const pick = (file: File) => fireEvent.change(screen.getByTestId("reply-media-input"), { target: { files: [file] } });

const SAVED: QuickReplyDTO = {
  id: "qr-1",
  name: "Catálogo",
  shortcut: "catalogo",
  text: "Segue o catálogo",
  media: { fileName: "catalogo.pdf", mimeType: "application/pdf", sizeBytes: 2 * 1024 * 1024, kind: "DOCUMENT" },
  connectionScope: { allConnections: true, connections: [] },
  createdAt: "",
  updatedAt: "",
};

// jsdom has no object URLs (the previews use them).
URL.createObjectURL = vi.fn(() => "blob:preview");
URL.revokeObjectURL = vi.fn();

describe("Respostas rápidas: anexo de imagem, vídeo ou PDF", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("o gestor vê os limites do WhatsApp antes de escolher e salva com o anexo", async () => {
    const onSubmit = renderForm(true);
    expect(await screen.findByText(/sem compressão/)).toBeInTheDocument();
    await limitsLoaded();
    expect(screen.getByText(/até 16 MB/)).toBeInTheDocument();

    fillRequired();
    const file = new File(["png"], "catalogo.png", { type: "image/png" });
    pick(file);
    expect(await screen.findByText("catalogo.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toEqual({ kind: "set", file });
  });

  it("arquivo acima do limite é recusado com o aviso, sem comprimir", async () => {
    renderForm(true);
    await limitsLoaded();
    const big = new File(["x"], "video.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 17 * 1024 * 1024 });
    pick(big);
    expect(await screen.findByText(/o WhatsApp aceita vídeo de até 16 MB/)).toBeInTheDocument();
    expect(screen.queryByText("video.mp4")).not.toBeInTheDocument();
  });

  it("com anexo, o texto acima de 1.024 caracteres não salva", async () => {
    const onSubmit = renderForm(true);
    await limitsLoaded();
    fillRequired("x".repeat(1100));
    pick(new File(["png"], "a.png", { type: "image/png" }));
    await screen.findByText("a.png");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText(/pode ter até 1\.024 caracteres/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("quem não pode incluir mídia vê o anexo salvo, mas não troca nem remove", async () => {
    renderForm(false, SAVED);
    expect(await screen.findByText("catalogo.pdf")).toBeInTheDocument();
    expect(screen.getByText(/Só o Administrador e o Gestor/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trocar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remover anexo" })).not.toBeInTheDocument();
  });

  it("sem anexo salvo, quem não pode incluir mídia nem vê o campo", () => {
    renderForm(false);
    expect(screen.queryByText("Anexo (opcional)")).not.toBeInTheDocument();
  });
});
