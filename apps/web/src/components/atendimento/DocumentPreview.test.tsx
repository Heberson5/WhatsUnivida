import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { MessageAttachmentDTO } from "@whatsatendende/types";
import { DocumentAttachment, documentKind } from "./DocumentPreview";
import * as printDocument from "../../lib/printDocument";
import { toast } from "sonner";

vi.mock("../../lib/api", () => ({ withAuthToken: (url: string) => url }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("../../lib/printDocument", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/printDocument")>();
  return { ...actual, printHtml: vi.fn(async () => undefined), renderPdfPagesToImages: vi.fn() };
});

const renderAsync = vi.fn();
vi.mock("docx-preview", () => ({ renderAsync: (...args: unknown[]) => renderAsync(...args) }));

const pdfPage = () => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: () => ({ promise: Promise.resolve() }),
});
const fakePdf = { numPages: 2, getPage: async () => pdfPage() };
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(fakePdf) }) }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.js" }));

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const encoder = new TextEncoder();
const files = new Map<string, ArrayBuffer>();

function attachment(overrides: Partial<MessageAttachmentDTO>): MessageAttachmentDTO {
  return { id: "a1", fileName: "arquivo.bin", mimeType: "application/octet-stream", sizeBytes: 1024, url: "/api/messages/attachments/a1/download", kind: "DOCUMENT", ...overrides };
}
const txt = (overrides: Partial<MessageAttachmentDTO> = {}) => attachment({ fileName: "Anotações da reunião.txt", mimeType: "text/plain", url: "/files/notas.txt", ...overrides });
const docx = () =>
  attachment({ fileName: "Contrato.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", url: "/files/contrato.docx", sizeBytes: 40_000 });
const pdf = () => attachment({ fileName: "Proposta.pdf", mimeType: "application/pdf", url: "/files/proposta.pdf", sizeBytes: 90_000 });

function setDesktop(isDesktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: isDesktop && query === printDocument.PRINT_MEDIA_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })),
  );
}

beforeEach(() => {
  files.clear();
  vi.mocked(printDocument.printHtml).mockClear().mockResolvedValue(undefined);
  vi.mocked(printDocument.renderPdfPagesToImages).mockReset().mockResolvedValue([JPEG, JPEG]);
  vi.mocked(toast.error).mockClear();
  renderAsync.mockReset().mockImplementation(async (_data: unknown, container: HTMLElement) => {
    container.innerHTML = '<div class="docx-wrapper"><section class="docx" style="width: 595.3pt; min-height: 841.9pt"><p>Cláusula primeira</p></section></div>';
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = files.get(url);
      return body ? { ok: true, status: 200, arrayBuffer: async () => body } : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }),
  );
  // Every card is "on screen" at once.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  setDesktop(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Sends a key to the page and lets everything it started (printing is async) run to its end — a "not printed" check needs that. */
async function pressAndSettle(event: KeyboardEvent) {
  await act(async () => {
    document.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function openViewer(att: MessageAttachmentDTO) {
  render(<DocumentAttachment att={att} />);
  fireEvent.click(await screen.findByRole("button", { name: `Visualizar ${att.fileName}` }));
  return screen.getByRole("dialog", { name: att.fileName });
}

describe("documentKind", () => {
  it.each([
    ["Proposta.pdf", "application/pdf", "pdf"],
    ["sem-extensao", "application/pdf", "pdf"],
    ["Contrato.DOCX", "application/octet-stream", "docx"],
    ["Contrato.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["Antigo.doc", "application/msword", "doc"],
    ["Anotações.txt", "text/plain", "text"],
    ["LEIA-ME.TXT", "application/octet-stream", "text"],
    ["sem-extensao", "text/plain", "text"],
    ["dados.csv", "text/csv", "other"],
    ["planilha.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "other"],
    ["foto.png", "image/png", "other"],
  ])("%s (%s) é %s", (fileName, mimeType, expected) => {
    expect(documentKind({ fileName, mimeType })).toBe(expected);
  });
});

describe("cartão de um arquivo de texto (.txt)", () => {
  it("mostra o selo TXT, o tamanho e as primeiras linhas do arquivo", async () => {
    files.set("/files/notas.txt", encoder.encode("Primeira linha\nSegunda — com acento: ação\n").buffer as ArrayBuffer);
    render(<DocumentAttachment att={txt({ sizeBytes: 2048 })} />);
    const card = await screen.findByRole("button", { name: "Visualizar Anotações da reunião.txt" });
    expect(within(card).getByText("TXT")).toBeInTheDocument();
    expect(within(card).getByText(/2 KB/)).toBeInTheDocument();
    await waitFor(() => expect(card.textContent).toContain("Segunda — com acento: ação"));
  });

  it("na miniatura mostra só o começo: 12 linhas de até 48 colunas", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `linha ${i + 1} ${"x".repeat(80)}`);
    files.set("/files/notas.txt", encoder.encode(lines.join("\n")).buffer as ArrayBuffer);
    render(<DocumentAttachment att={txt()} />);
    const card = await screen.findByRole("button", { name: /Visualizar/ });
    await waitFor(() => expect(card.querySelector("pre")).not.toBeNull());
    const shown = card.querySelector("pre")!.textContent!.split("\n");
    expect(shown).toHaveLength(12);
    expect(shown[0]).toBe(`linha 1 ${"x".repeat(40)}`);
    expect(shown[0]).toHaveLength(48);
  });

  it("um texto de mais de 2 MB não abre no visualizador: é só um cartão de baixar", () => {
    render(<DocumentAttachment att={txt({ sizeBytes: 2 * 1024 * 1024 + 1 })} />);
    expect(screen.queryByRole("button", { name: /Visualizar/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/files/notas.txt");
  });

  it("um .doc antigo continua só para baixar", () => {
    render(<DocumentAttachment att={attachment({ fileName: "Antigo.doc", mimeType: "application/msword", url: "/files/antigo.doc" })} />);
    expect(screen.queryByRole("button", { name: /Visualizar/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });
});

describe("visualizador de texto", () => {
  beforeEach(() => {
    files.set("/files/notas.txt", encoder.encode("Olá, mundo\nSegunda linha — acentuação <b>não é marcação</b>").buffer as ArrayBuffer);
  });

  it("mostra o texto inteiro, sem interpretar marcação, com Imprimir, Baixar e Fechar", async () => {
    const dialog = await openViewer(txt());
    await waitFor(() => expect(within(dialog).getByText(/Segunda linha — acentuação <b>não é marcação<\/b>/)).toBeInTheDocument());
    expect(dialog.querySelector("pre b")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeEnabled();
    expect(within(dialog).getByRole("link", { name: "Baixar" })).toHaveAttribute("download", "Anotações da reunião.txt");
    expect(within(dialog).getByRole("button", { name: "Fechar" })).toBeInTheDocument();
  });

  it("Imprimir só fica disponível depois que o arquivo carregou", async () => {
    const dialog = await openViewer(txt());
    expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeDisabled();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeEnabled());
  });

  it("Imprimir manda o texto para o iframe de impressão, com o nome do arquivo como título", async () => {
    const dialog = await openViewer(txt());
    const button = await within(dialog).findByRole("button", { name: "Imprimir" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(printDocument.printHtml).toHaveBeenCalledTimes(1));
    const html = vi.mocked(printDocument.printHtml).mock.calls[0][0];
    expect(html).toContain("<title>Anotações da reunião.txt</title>");
    expect(html).toContain("Olá, mundo\nSegunda linha — acentuação &lt;b&gt;não é marcação&lt;/b&gt;");
  });

  it("Ctrl+P imprime o documento (e não a tela do sistema por trás)", async () => {
    const dialog = await openViewer(txt());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeEnabled());
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(printDocument.printHtml).toHaveBeenCalledTimes(1));
  });

  it("Cmd+P (Mac) também", async () => {
    const dialog = await openViewer(txt());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeEnabled());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "P", metaKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(printDocument.printHtml).toHaveBeenCalledTimes(1));
  });

  it("Ctrl+P antes de o arquivo carregar não imprime a tela do sistema nem uma folha vazia", async () => {
    const dialog = await openViewer(txt());
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true });
    await pressAndSettle(event);
    expect(event.defaultPrevented).toBe(true);
    expect(printDocument.printHtml).not.toHaveBeenCalled();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeEnabled()); // let the file finish loading
    expect(printDocument.printHtml).not.toHaveBeenCalled();
  });

  it("Esc fecha o visualizador", async () => {
    const dialog = await openViewer(txt());
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("um arquivo que não dá para ler mostra o aviso e deixa só o baixar", async () => {
    files.delete("/files/notas.txt");
    const dialog = await openViewer(txt());
    await waitFor(() => expect(within(dialog).getByText("Não foi possível mostrar este arquivo. Use o botão de baixar.")).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeDisabled();
    expect(within(dialog).getByRole("link", { name: "Baixar" })).toBeInTheDocument();
  });

  it("um arquivo que não é texto de verdade (figura com nome .txt) também mostra o aviso", async () => {
    files.set("/files/notas.txt", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).buffer);
    const dialog = await openViewer(txt());
    await waitFor(() => expect(within(dialog).getByText("Não foi possível mostrar este arquivo. Use o botão de baixar.")).toBeInTheDocument());
  });

  it("se a impressão falhar, avisa e libera o botão de novo", async () => {
    vi.mocked(printDocument.printHtml).mockRejectedValueOnce(new Error("sem impressora"));
    const dialog = await openViewer(txt());
    const button = await within(dialog).findByRole("button", { name: "Imprimir" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível preparar a impressão. Use o botão de baixar."));
    await waitFor(() => expect(button).toBeEnabled());
  });
});

describe("no celular (sem mouse) só baixa", () => {
  beforeEach(() => {
    setDesktop(false);
    files.set("/files/notas.txt", encoder.encode("Olá").buffer as ArrayBuffer);
  });

  it("o visualizador não tem o botão Imprimir, mas tem Baixar e Fechar", async () => {
    const dialog = await openViewer(txt());
    await waitFor(() => expect(within(dialog).getByText("Olá")).toBeInTheDocument());
    expect(within(dialog).queryByRole("button", { name: "Imprimir" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Baixar" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Fechar" })).toBeInTheDocument();
  });

  it("Ctrl+P (teclado externo) não abre impressão nenhuma", async () => {
    const dialog = await openViewer(txt());
    await waitFor(() => expect(within(dialog).getByText("Olá")).toBeInTheDocument());
    await pressAndSettle(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(printDocument.printHtml).not.toHaveBeenCalled();
  });
});

describe("Word (.docx)", () => {
  beforeEach(() => {
    files.set("/files/contrato.docx", new ArrayBuffer(8));
  });

  it("as figuras do documento são pedidas como data: (blob: é bloqueado pela política de segurança), no visualizador e na miniatura", async () => {
    render(<DocumentAttachment att={docx()} />);
    await waitFor(() => expect(renderAsync).toHaveBeenCalled()); // the thumbnail
    expect(renderAsync.mock.calls[0][3]).toMatchObject({ useBase64URL: true });

    fireEvent.click(screen.getByRole("button", { name: "Visualizar Contrato.docx" }));
    await waitFor(() => expect(renderAsync).toHaveBeenCalledTimes(2));
    expect(renderAsync.mock.calls[1][3]).toEqual({ useBase64URL: true });
  });

  it("Imprimir leva o documento desenhado, no tamanho da folha dele", async () => {
    const dialog = await openViewer(docx());
    const button = await within(dialog).findByRole("button", { name: "Imprimir" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(printDocument.printHtml).toHaveBeenCalledTimes(1));
    const html = vi.mocked(printDocument.printHtml).mock.calls[0][0];
    expect(html).toContain("<title>Contrato.docx</title>");
    expect(html).toContain("<p>Cláusula primeira</p>");
    expect(html).toContain("@page { size: 595.3pt 841.9pt; margin: 0 }");
  });

  describe("React roda cada efeito duas vezes ao montar (StrictMode): o que a primeira execução faz não pode apagar o da segunda", () => {
    // The first call to renderAsync is slow, the second fast — so the first one finishes last.
    function slowThenFast() {
      let call = 0;
      renderAsync.mockImplementation(
        (_data: unknown, container: HTMLElement) =>
          new Promise((resolve) => {
            const mine = (call += 1);
            setTimeout(() => {
              container.innerHTML = `<div class="docx-wrapper"><section class="docx" style="width: 595.3pt; min-height: 841.9pt"><p>chamada ${mine}</p></section></div>`;
              resolve(undefined);
            }, mine === 1 ? 80 : 5);
          }),
      );
    }

    it("miniatura", async () => {
      slowThenFast();
      render(
        <StrictMode>
          <DocumentAttachment att={docx()} />
        </StrictMode>,
      );
      const card = await screen.findByRole("button", { name: "Visualizar Contrato.docx" });
      await waitFor(() => expect(card.textContent).toContain("chamada 2"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150)); // the slow, cancelled first call finishes now
      });
      expect(card.textContent).toContain("chamada 2");
      expect(card.textContent).not.toContain("chamada 1");
      expect(card.querySelectorAll("section.docx")).toHaveLength(1);
    });

    it("visualizador e impressão", async () => {
      slowThenFast();
      render(
        <StrictMode>
          <DocumentAttachment att={docx()} />
        </StrictMode>,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Visualizar Contrato.docx" }));
      const dialog = screen.getByRole("dialog", { name: "Contrato.docx" });
      const button = await within(dialog).findByRole("button", { name: "Imprimir" });
      await waitFor(() => expect(button).toBeEnabled());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(within(dialog).queryByText("Não foi possível mostrar este documento. Use o botão de baixar.")).not.toBeInTheDocument();
      expect(dialog.querySelectorAll("section.docx")).toHaveLength(1);
      fireEvent.click(button);
      await waitFor(() => expect(printDocument.printHtml).toHaveBeenCalledTimes(1));
      const html = vi.mocked(printDocument.printHtml).mock.calls[0][0];
      expect((html.match(/<section class="docx"/g) ?? []).length).toBe(1);
      // the card drew twice (calls 1 and 2), then the viewer twice (3 and 4): the viewer keeps the last one only
      expect(renderAsync).toHaveBeenCalledTimes(4);
      expect(html).toContain("<p>chamada 4</p>");
      expect(html).not.toContain("chamada 3");
    });
  });

  it("um Word que não abre mostra o aviso", async () => {
    renderAsync.mockRejectedValue(new Error("arquivo corrompido"));
    const dialog = await openViewer(docx());
    await waitFor(() => expect(within(dialog).getByText("Não foi possível mostrar este documento. Use o botão de baixar.")).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Imprimir" })).toBeDisabled();
  });
});

describe("PDF", () => {
  beforeEach(() => {
    files.set("/files/proposta.pdf", new ArrayBuffer(8));
  });

  it("Imprimir desenha as páginas como imagens e manda as imagens para o iframe de impressão", async () => {
    const dialog = await openViewer(pdf());
    const button = await within(dialog).findByRole("button", { name: "Imprimir" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(printDocument.printHtml).toHaveBeenCalledTimes(1));
    expect(printDocument.renderPdfPagesToImages).toHaveBeenCalledWith(fakePdf, expect.objectContaining({ maxPages: 100 }));
    const html = vi.mocked(printDocument.printHtml).mock.calls[0][0];
    expect(html).toContain("<title>Proposta.pdf</title>");
    expect(html.match(/<img src="data:image\/jpeg;base64,/g)).toHaveLength(2);
  });

  it("enquanto prepara as páginas o botão avisa e não deixa clicar duas vezes", async () => {
    let finish: (pages: string[]) => void = () => undefined;
    vi.mocked(printDocument.renderPdfPagesToImages).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const dialog = await openViewer(pdf());
    const button = await within(dialog).findByRole("button", { name: "Imprimir" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent("Preparando...");
    fireEvent.click(button);
    await act(async () => finish([JPEG]));
    await waitFor(() => expect(printDocument.printHtml).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("se o visualizador for fechado enquanto as páginas são preparadas, nada é impresso", async () => {
    let finish: (pages: string[]) => void = () => undefined;
    vi.mocked(printDocument.renderPdfPagesToImages).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const dialog = await openViewer(pdf());
    const button = await within(dialog).findByRole("button", { name: "Imprimir" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => finish([JPEG]));
    expect(printDocument.printHtml).not.toHaveBeenCalled();
  });

  it("um PDF que não abre mostra o aviso específico de PDF", async () => {
    files.delete("/files/proposta.pdf");
    const dialog = await openViewer(pdf());
    await waitFor(() => expect(within(dialog).getByText("Não foi possível mostrar este PDF. Use o botão de baixar.")).toBeInTheDocument());
  });
});
