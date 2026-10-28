/**
 * Printing a document from the viewer, without leaving the app and without asking the
 * browser to open the file itself.
 *
 * The page the user sees can't just be printed — it is the whole app. Instead the
 * document is written into a hidden iframe that has nothing else in it, and only that
 * iframe is printed. Two rules come from the production Content-Security-Policy
 * (nginx.conf: `frame-src` limited to OpenStreetMap, `img-src 'self' data:`):
 *  - the iframe is `about:blank` filled with document.write — never a `blob:` or `data:`
 *    address, which the policy blocks as a frame;
 *  - pictures go in as `data:` addresses — `blob:` ones are blocked too.
 */

/** Printing is only offered where there is a mouse and, most likely, a printer — on a phone the viewer only downloads. */
export const PRINT_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";

export function canPrintHere(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PRINT_MEDIA_QUERY).matches;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface PrintPage {
  title: string;
  /** Body already made of safe pieces: escaped text, data: pictures, or the DOM docx-preview built. */
  body: string;
  /** What goes inside `@page { ... }` — margin, and the paper size when the document has its own. */
  page: string;
  css?: string;
}

/** The whole document for the hidden iframe. The title is what the print dialog (and "Save as PDF") call the job. */
export function buildPrintHtml({ title, body, page, css = "" }: PrintPage): string {
  return [
    "<!doctype html>",
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    `@page { ${page} }`,
    "html, body { margin: 0; padding: 0; background: #fff; color: #000; }",
    "* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }",
    css,
    "</style></head>",
    `<body>${body}</body></html>`,
  ].join("\n");
}

export function buildTextPrintHtml(title: string, text: string): string {
  return buildPrintHtml({
    title,
    page: "margin: 15mm",
    css: 'pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11pt/1.45 Consolas, "Courier New", monospace; }',
    body: `<pre>${escapeHtml(text)}</pre>`,
  });
}

/** One picture per page, as `data:` addresses. */
export function buildPdfPrintHtml(title: string, pages: string[]): string {
  for (const src of pages) {
    if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]*$/.test(src)) throw new Error("Imagem de página inválida");
  }
  return buildPrintHtml({
    title,
    page: "margin: 8mm",
    css: [
      ".page { break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid; }",
      ".page:last-child { break-after: auto; page-break-after: auto; }",
      // As big as fits on the sheet: the width of the page area, but never taller than 262 mm — what is left of a Letter
      // sheet after the 8 mm margins (A4 has more room). Wider than that, an A4 picture would spill onto a second sheet.
      ".page img { display: block; margin: 0 auto; width: auto; height: auto; max-width: 100%; max-height: 262mm; }",
    ].join("\n"),
    body: pages.map((src, index) => `<section class="page"><img src="${src}" alt="Página ${index + 1}"></section>`).join(""),
  });
}

/**
 * The document docx-preview drew in the viewer, moved into the print page. Each Word page is a
 * `section.docx` with its own margins as padding, so the paper takes the document's size and the
 * browser adds no margin of its own.
 */
export function buildWordPrintHtml(title: string, rendered: HTMLElement): string {
  const first = rendered.querySelector<HTMLElement>("section.docx");
  const size = first?.style.width && first.style.minHeight ? `size: ${first.style.width} ${first.style.minHeight}; ` : "";
  return buildPrintHtml({
    title,
    page: `${size}margin: 0`,
    css: [
      ".docx-wrapper { background: none !important; padding: 0 !important; display: block !important; }",
      ".docx-wrapper > section.docx { box-shadow: none !important; margin: 0 !important; break-after: page; page-break-after: always; }",
      ".docx-wrapper > section.docx:last-child { break-after: auto; page-break-after: auto; }",
    ].join("\n"),
    body: rendered.innerHTML,
  });
}

/** What of pdf.js's document the printing needs — a small shape, so it can be replaced in tests. */
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    render(options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<unknown> };
  }>;
}

export const PRINT_PDF_MAX_PAGES = 100;
// 1240 px across an A4 sheet is about 150 dpi: sharp on paper, and a page stays a few hundred KB as JPEG.
const PRINT_PDF_PAGE_WIDTH_PX = 1240;
const PRINT_PDF_JPEG_QUALITY = 0.92;

/**
 * Draws the pages of a PDF one at a time on a single canvas and keeps each as a JPEG `data:` address — a `blob:` or
 * `data:` PDF could not be shown in a frame under the production policy, so the pages are printed as pictures.
 */
export async function renderPdfPagesToImages(
  pdf: PdfDocumentLike,
  { maxPages = PRINT_PDF_MAX_PAGES, isCancelled }: { maxPages?: number; isCancelled?: () => boolean } = {}
): Promise<string[]> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("O navegador não conseguiu desenhar as páginas");
  const images: string[] = [];
  for (let number = 1; number <= Math.min(pdf.numPages, maxPages); number++) {
    if (isCancelled?.()) break;
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PRINT_PDF_PAGE_WIDTH_PX / base.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    images.push(canvas.toDataURL("image/jpeg", PRINT_PDF_JPEG_QUALITY));
  }
  return images;
}

/** Resolves once every picture of the document has loaded (or failed), or after `timeoutMs` — printing must not wait forever on one. */
export function waitForImages(doc: Document, timeoutMs = 15000): Promise<void> {
  const pending = Array.from(doc.images).filter((image) => !image.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const finish = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    for (const image of pending) {
      const done = () => {
        left -= 1;
        if (left === 0) finish();
      };
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
    }
  });
}

export interface PrintOptions {
  /** What opens the print dialog on the iframe's window. Tests replace it. */
  print?: (frameWindow: Window) => void;
  /** The iframe is removed this long after printing even if the browser never says it finished. */
  cleanupAfterMs?: number;
  imageTimeoutMs?: number;
}

const CLEANUP_AFTER_MS = 10 * 60 * 1000;

// Focus first: some browsers print the page that has the focus, not the frame print() was called on.
function openPrintDialog(frameWindow: Window): void {
  frameWindow.focus();
  frameWindow.print();
}

/** Writes `html` into a hidden iframe and opens the print dialog for it. The iframe goes away when the dialog closes. */
export async function printHtml(html: string, options: PrintOptions = {}): Promise<void> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = "Impressão";
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "1px", height: "1px", border: "0", opacity: "0", pointerEvents: "none" });
  document.body.appendChild(frame);

  const cleanup = () => frame.remove();
  try {
    const frameWindow = frame.contentWindow;
    const frameDocument = frame.contentDocument;
    if (!frameWindow || !frameDocument) throw new Error("Não foi possível preparar a impressão");
    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();
    await waitForImages(frameDocument, options.imageTimeoutMs);

    frameWindow.addEventListener("afterprint", cleanup, { once: true });
    window.setTimeout(cleanup, options.cleanupAfterMs ?? CLEANUP_AFTER_MS);
    (options.print ?? openPrintDialog)(frameWindow);
  } catch (error) {
    cleanup();
    throw error;
  }
}
