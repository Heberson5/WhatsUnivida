import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildPdfPrintHtml,
  buildPrintHtml,
  buildTextPrintHtml,
  buildWordPrintHtml,
  canPrintHere,
  escapeHtml,
  printHtml,
  renderPdfPagesToImages,
  waitForImages,
  type PdfDocumentLike,
} from "./printDocument";

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("HTML do documento para imprimir", () => {
  it("escapa o texto e o título (nada do arquivo vira marcação)", () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
    const html = buildTextPrintHtml("<img src=x onerror=alert(1)>.txt", "linha <script>alert(1)</script>\nsegunda & última");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("segunda &amp; última");
  });

  it("texto: mantém as quebras de linha, quebra as linhas longas e deixa a margem para a impressora", () => {
    const html = buildTextPrintHtml("notas.txt", "um\ndois");
    expect(html).toContain("<title>notas.txt</title>");
    expect(html).toContain("<pre>um\ndois</pre>");
    expect(html).toContain("white-space: pre-wrap");
    expect(html).toContain("@page { margin: 15mm }");
  });

  it("PDF: uma figura por página, cada página em uma folha, sem folha em branco no fim", () => {
    const html = buildPdfPrintHtml("proposta.pdf", [JPEG, JPEG, JPEG]);
    expect(html.match(/<section class="page">/g)).toHaveLength(3);
    expect(html.match(/<img src="data:image\/jpeg;base64,/g)).toHaveLength(3);
    expect(html).toContain("page-break-after: always");
    expect(html).toContain(".page:last-child { break-after: auto; page-break-after: auto; }");
    // never taller than a sheet (Letter minus margins is the tightest): a taller picture would print on two sheets
    expect(html).toContain("max-height: 262mm");
    expect(html).toContain("max-width: 100%");
  });

  it("PDF: só aceita figuras em data: (blob:, http: e javascript: ficam de fora — a política de segurança bloqueia e não é para entrar nada de fora)", () => {
    for (const src of ["blob:http://x/1", "http://x/a.jpg", "javascript:alert(1)", 'data:image/jpeg;base64,AA"onerror="x']) {
      expect(() => buildPdfPrintHtml("a.pdf", [src])).toThrow("Imagem de página inválida");
    }
  });

  it("nenhum dos HTML usa blob: nem aponta para fora", () => {
    const rendered = document.createElement("div");
    rendered.innerHTML = '<div class="docx-wrapper"><section class="docx" style="width:595pt;min-height:842pt"><p>Olá</p></section></div>';
    for (const html of [buildTextPrintHtml("a.txt", "x"), buildPdfPrintHtml("a.pdf", [JPEG]), buildWordPrintHtml("a.docx", rendered)]) {
      expect(html).not.toContain("blob:");
      expect(html).not.toMatch(/(src|href)="https?:/);
    }
  });

  it("Word: leva o conteúdo desenhado, usa o tamanho da folha do documento e zera a margem (a margem já está no documento)", () => {
    const rendered = document.createElement("div");
    rendered.innerHTML =
      '<style>.docx p{margin:0}</style><div class="docx-wrapper"><section class="docx" style="width: 595.3pt; min-height: 841.9pt; padding: 72pt"><p>Primeira</p></section><section class="docx"><p>Segunda</p></section></div>';
    const html = buildWordPrintHtml("contrato.docx", rendered);
    expect(html).toContain("@page { size: 595.3pt 841.9pt; margin: 0 }");
    expect(html).toContain("<p>Primeira</p>");
    expect(html).toContain("<p>Segunda</p>");
    expect(html).toContain(".docx p{margin:0}");
    expect(html).toContain(".docx-wrapper { background: none !important");
    expect(html).toContain("box-shadow: none !important");
    expect(html).toContain("section.docx:last-child { break-after: auto");
  });

  it("Word: se o documento não informa o tamanho da folha, deixa a do navegador", () => {
    const rendered = document.createElement("div");
    rendered.innerHTML = "<p>solto</p>";
    expect(buildWordPrintHtml("a.docx", rendered)).toContain("@page { margin: 0 }");
  });

  it("buildPrintHtml monta um documento completo em português", () => {
    const html = buildPrintHtml({ title: "t", body: "<p>x</p>", page: "margin: 1mm" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<body><p>x</p></body>");
  });
});

describe("canPrintHere — imprimir só onde há mouse", () => {
  const stub = (matches: boolean | "missing") => {
    if (matches === "missing") vi.stubGlobal("matchMedia", undefined);
    else vi.stubGlobal("matchMedia", vi.fn(() => ({ matches })));
  };
  afterEach(() => vi.unstubAllGlobals());

  it("computador (mouse + passar o mouse): sim", () => {
    stub(true);
    expect(canPrintHere()).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith("(hover: hover) and (pointer: fine)");
  });
  it("celular/tablet (toque): não", () => {
    stub(false);
    expect(canPrintHere()).toBe(false);
  });
  it("navegador sem matchMedia: não imprime (só baixa)", () => {
    stub("missing");
    expect(canPrintHere()).toBe(false);
  });
});

describe("waitForImages", () => {
  function frameWithImages(...complete: boolean[]) {
    const images = complete.map((done) => {
      const image = document.createElement("img");
      Object.defineProperty(image, "complete", { value: done, configurable: true });
      return image;
    });
    return { images, doc: { images } as unknown as Document };
  }

  it("sem figuras, ou com todas prontas, segue na hora", async () => {
    await expect(waitForImages(frameWithImages().doc)).resolves.toBeUndefined();
    await expect(waitForImages(frameWithImages(true, true).doc)).resolves.toBeUndefined();
  });

  it("espera as que ainda carregam, e uma figura com erro não trava a impressão", async () => {
    const { images, doc } = frameWithImages(true, false, false);
    let finished = false;
    const waiting = waitForImages(doc).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    images[1].dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(finished).toBe(false);
    images[2].dispatchEvent(new Event("error"));
    await waiting;
    expect(finished).toBe(true);
  });

  it("desiste depois do limite de tempo", async () => {
    vi.useFakeTimers();
    const { doc } = frameWithImages(false);
    const waiting = waitForImages(doc, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("printHtml — iframe oculto", () => {
  it("escreve o documento num iframe about:blank (nunca blob:/data:), imprime só ele e o remove quando a janela de impressão fecha", async () => {
    const print = vi.fn();
    let frameWindow: Window | null = null;
    await printHtml(buildTextPrintHtml("notas.txt", "olá"), {
      print: (target) => {
        frameWindow = target;
        print(target.document.body.textContent, target.document.title);
      },
    });
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("src")).toBeNull(); // about:blank filled with document.write
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith("olá", "notas.txt");

    // The dialog closed: the browser says so with afterprint on the frame's window.
    frameWindow!.dispatchEvent(new Event("afterprint"));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("se o navegador nunca avisar que terminou, o iframe sai depois do limite", async () => {
    vi.useFakeTimers();
    await printHtml("<p>x</p>", { print: () => undefined, cleanupAfterMs: 1000 });
    expect(document.querySelector("iframe")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("se a impressão falhar, o iframe não fica para trás e o erro chega a quem chamou", async () => {
    await expect(
      printHtml("<p>x</p>", {
        print: () => {
          throw new Error("sem impressora");
        },
      })
    ).rejects.toThrow("sem impressora");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("espera as figuras da página antes de abrir a janela de impressão", async () => {
    const order: string[] = [];
    const html = buildPdfPrintHtml("a.pdf", [JPEG]);
    const printing = printHtml(html, {
      print: () => order.push("print"),
      imageTimeoutMs: 50,
    });
    order.push("started");
    await printing;
    expect(order).toEqual(["started", "print"]);
    expect(document.querySelector("iframe")?.contentDocument?.images).toHaveLength(1);
  });
});

describe("renderPdfPagesToImages", () => {
  function fakePdf(sizes: { width: number; height: number }[]) {
    const scales: number[] = [];
    const pdf: PdfDocumentLike = {
      numPages: sizes.length,
      getPage: async (number) => {
        const size = sizes[number - 1];
        return {
          getViewport: ({ scale }) => {
            scales.push(scale);
            return { width: size.width * scale, height: size.height * scale };
          },
          render: () => ({ promise: Promise.resolve() }),
        };
      },
    };
    return { pdf, scales };
  }

  function stubCanvas() {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D);
    return vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      return `${JPEG}#${this.width}x${this.height}`;
    });
  }

  it("uma imagem JPEG por página, sempre com a mesma largura (cerca de 150 dpi) seja qual for o tamanho da página", async () => {
    const toDataURL = stubCanvas();
    const { pdf } = fakePdf([
      { width: 595, height: 842 }, // A4
      { width: 612, height: 792 }, // Letter
    ]);
    const images = await renderPdfPagesToImages(pdf);
    expect(images).toHaveLength(2);
    expect(images[0].startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(images[0]).toContain("#1240x1755");
    expect(images[1]).toContain("#1240x1605");
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.92);
  });

  it("respeita o limite de páginas", async () => {
    stubCanvas();
    const { pdf } = fakePdf(Array.from({ length: 5 }, () => ({ width: 600, height: 800 })));
    expect(await renderPdfPagesToImages(pdf, { maxPages: 3 })).toHaveLength(3);
  });

  it("para quando a impressão é cancelada (o visualizador foi fechado)", async () => {
    stubCanvas();
    const { pdf } = fakePdf(Array.from({ length: 5 }, () => ({ width: 600, height: 800 })));
    let calls = 0;
    const images = await renderPdfPagesToImages(pdf, { isCancelled: () => ++calls > 2 });
    expect(images).toHaveLength(2);
  });

  it("sem canvas (navegador que não desenha), avisa em vez de imprimir página em branco", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(renderPdfPagesToImages(fakePdf([{ width: 600, height: 800 }]).pdf)).rejects.toThrow("não conseguiu desenhar");
  });
});
