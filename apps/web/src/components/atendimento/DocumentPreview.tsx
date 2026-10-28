import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Printer, X } from "lucide-react";
import { toast } from "sonner";
import type { MessageAttachmentDTO } from "@whatsatendende/types";
import { withAuthToken } from "../../lib/api";
import { decodeText } from "../../lib/textDecode";
import {
  buildPdfPrintHtml,
  buildTextPrintHtml,
  buildWordPrintHtml,
  canPrintHere,
  printHtml,
  PRINT_PDF_MAX_PAGES,
  renderPdfPagesToImages,
  type PdfDocumentLike,
} from "../../lib/printDocument";

type DocumentKind = "pdf" | "docx" | "doc" | "text" | "other";

// Bigger files still open normally — they just don't get a thumbnail drawn in the chat.
const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;
// A text is read whole into the page, so it gets a lower limit; a bigger one is a plain download card.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// The card shows the first lines of a text, in a small monospace font.
const TEXT_THUMBNAIL_LINES = 12;
const TEXT_THUMBNAIL_COLUMNS = 48;
const THUMBNAIL_WIDTH = 220;
// Width of a Word page (A4 at 96 dpi). The thumbnail shows only its left part,
// scaled down, so the text stays readable.
const WORD_PAGE_WIDTH = 816;
const WORD_VISIBLE_WIDTH = 540;

const KIND_STYLE: Record<DocumentKind, { label: string; badge: string }> = {
  pdf: { label: "PDF", badge: "bg-red-600 text-white" },
  docx: { label: "Word", badge: "bg-blue-600 text-white" },
  doc: { label: "Word", badge: "bg-blue-600 text-white" },
  text: { label: "TXT", badge: "bg-slate-600 text-white" },
  other: { label: "", badge: "bg-black/10" },
};

export function documentKind(att: Pick<MessageAttachmentDTO, "mimeType" | "fileName">): DocumentKind {
  const name = att.fileName.toLowerCase();
  if (att.mimeType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (att.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || name.endsWith(".docx")) return "docx";
  if (att.mimeType === "application/msword" || name.endsWith(".doc")) return "doc";
  if (att.mimeType === "text/plain" || name.endsWith(".txt")) return "text";
  return "other";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One import shared by every Word thumbnail and viewer (and by both runs of an effect — see WordThumbnail); a failed
// load is forgotten so the next attempt tries again.
let docxPreviewModule: Promise<typeof import("docx-preview")> | null = null;
function loadDocxPreview() {
  docxPreviewModule ??= import("docx-preview").catch((error) => {
    docxPreviewModule = null;
    throw error;
  });
  return docxPreviewModule;
}

async function loadBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(withAuthToken(url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** True once the element has scrolled into view — thumbnails are only built for messages the agent actually sees. */
function useInView<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  return [ref as React.RefObject<T>, seen];
}

/** First page of a PDF, drawn small. Reports the page count once known. */
function PdfThumbnail({ url, onPages }: { url: string; onPages: (pages: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
        const pdf = await pdfjs.getDocument({ data: await loadBytes(url) }).promise;
        if (cancelled) return;
        onPages(pdf.numPages);
        const page = await pdf.getPage(1);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (THUMBNAIL_WIDTH / base.width) * ratio });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext("2d");
        if (context) await page.render({ canvas, canvasContext: context, viewport }).promise;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (failed) return null;
  return <canvas ref={canvasRef} className="block w-full bg-white" aria-hidden="true" />;
}

const VIEWER_PAGE_WIDTH = 900;
// A very long PDF is drawn up to here (and printed up to here); the download button gets the rest.
const VIEWER_MAX_PAGES = PRINT_PDF_MAX_PAGES;

/** What the viewer hands to the Imprimir button once the document is loaded. */
type PrintSource = { kind: "pdf"; pdf: PdfDocumentLike } | { kind: "docx"; rendered: HTMLElement } | { kind: "text"; text: string };

interface ViewerContentProps {
  url: string;
  onReady: (source: PrintSource) => void;
  onError: () => void;
}

/** Every page of a PDF drawn one after another, so the viewer looks the same in any browser or in the installed app. */
function PdfPages({ url, onReady, onError }: ViewerContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
        const pdf = await pdfjs.getDocument({ data: await loadBytes(url) }).promise;
        const container = containerRef.current;
        if (!container || cancelled) return;
        setPages(pdf.numPages);
        onReady({ kind: "pdf", pdf: pdf as unknown as PdfDocumentLike });
        const ratio = window.devicePixelRatio || 1;
        for (let n = 1; n <= Math.min(pdf.numPages, VIEWER_MAX_PAGES) && !cancelled; n++) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const cssWidth = Math.min(VIEWER_PAGE_WIDTH, container.clientWidth || VIEWER_PAGE_WIDTH);
          const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "mx-auto mb-3 block max-w-full bg-white shadow";
          canvas.style.width = `${cssWidth}px`;
          container.appendChild(canvas);
          const context = canvas.getContext("2d");
          if (context) await page.render({ canvas, canvasContext: context, viewport }).promise;
        }
      } catch {
        if (!cancelled) onError();
      }
    })();
    const container = containerRef.current;
    return () => {
      cancelled = true;
      container?.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <>
      {pages > VIEWER_MAX_PAGES && <p className="mb-3 text-center text-xs text-white/70">Mostrando as primeiras {VIEWER_MAX_PAGES} páginas de {pages}. Baixe o arquivo para ver tudo.</p>}
      <div ref={containerRef} />
    </>
  );
}

/** The start of a .docx, rendered at page size and scaled down into the card. */
function WordThumbnail({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { renderAsync } = await loadDocxPreview();
        // Drawn in a scratch element and moved into the card only if this run is still the current one. The app runs
        // inside React.StrictMode, which mounts every effect twice (the file was downloaded twice, in the production
        // build too); drawing straight into the card let the first run wipe what the second had drawn — about one
        // thumbnail in six came out empty.
        const scratch = document.createElement("div");
        await renderAsync(await loadBytes(url), scratch, undefined, { inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: true, useBase64URL: true });
        if (!cancelled) containerRef.current?.replaceChildren(...scratch.childNodes);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) return null;
  return (
    <div className="relative h-[150px] w-full overflow-hidden bg-white" aria-hidden="true">
      <div ref={containerRef} className="pointer-events-none absolute start-0 top-0 origin-top-left text-black" style={{ width: WORD_PAGE_WIDTH, transform: `scale(${THUMBNAIL_WIDTH / WORD_VISIBLE_WIDTH})` }} />
    </div>
  );
}

/** A Word document rendered in place. Pictures are `data:` addresses — the production policy blocks the `blob:` ones docx-preview makes by default. */
function WordPages({ url, onReady, onError }: ViewerContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { renderAsync } = await loadDocxPreview();
        // Same as the thumbnail: only the current run puts its result in the viewer.
        const scratch = document.createElement("div");
        await renderAsync(await loadBytes(url), scratch, undefined, { useBase64URL: true });
        const container = containerRef.current;
        if (cancelled || !container) return;
        container.replaceChildren(...scratch.childNodes);
        onReady({ kind: "docx", rendered: container });
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return <div ref={containerRef} className="mx-auto w-fit max-w-full overflow-auto rounded bg-white text-black" />;
}

/** A .txt shown as a sheet of monospace text. */
function TextSheet({ url, onReady, onError }: ViewerContentProps) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const decoded = decodeText(await loadBytes(url)).text;
        if (cancelled) return;
        setText(decoded);
        onReady({ kind: "text", text: decoded });
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (text === null) return null;
  return (
    <pre className="mx-auto w-full max-w-[900px] whitespace-pre-wrap break-words rounded bg-white p-6 font-mono text-sm leading-relaxed text-black shadow">
      {text || <span className="text-black/50">(arquivo vazio)</span>}
    </pre>
  );
}

/** The first lines of a .txt, small, inside the card. Nothing is drawn if the file can't be read. */
function TextThumbnail({ url }: { url: string }) {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadBytes(url)
      .then((bytes) => {
        if (cancelled) return;
        const lines = decodeText(bytes).text.split("\n").slice(0, TEXT_THUMBNAIL_LINES);
        setPreview(lines.map((line) => line.slice(0, TEXT_THUMBNAIL_COLUMNS)).join("\n"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (preview === null) return null;
  return (
    <pre className="h-[150px] overflow-hidden whitespace-pre-wrap break-words bg-white p-2 font-mono text-[9px] leading-snug text-black" aria-hidden="true">
      {preview}
    </pre>
  );
}

const ERROR_TEXT: Record<DocumentKind, string> = {
  pdf: "Não foi possível mostrar este PDF. Use o botão de baixar.",
  docx: "Não foi possível mostrar este documento. Use o botão de baixar.",
  doc: "Não foi possível mostrar este documento. Use o botão de baixar.",
  text: "Não foi possível mostrar este arquivo. Use o botão de baixar.",
  other: "Não foi possível mostrar este arquivo. Use o botão de baixar.",
};

async function buildPrintHtmlFor(title: string, source: PrintSource, isCancelled: () => boolean): Promise<string> {
  if (source.kind === "text") return buildTextPrintHtml(title, source.text);
  if (source.kind === "docx") return buildWordPrintHtml(title, source.rendered);
  return buildPdfPrintHtml(title, await renderPdfPagesToImages(source.pdf, { maxPages: VIEWER_MAX_PAGES, isCancelled }));
}

/** Full-size viewer — the PDF pages, the Word document or the text, drawn in place, with Imprimir (computer only), Baixar and Fechar. */
function DocumentViewer({ att, kind, onClose }: { att: MessageAttachmentDTO; kind: DocumentKind; onClose: () => void }) {
  const [source, setSource] = useState<PrintSource | null>(null);
  const [error, setError] = useState(false);
  const [printing, setPrinting] = useState(false);
  // Decided once, when the viewer opens: a phone has no mouse and only gets the download button.
  const printAvailable = useMemo(() => canPrintHere(), []);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
    };
  }, []);

  const print = useCallback(async () => {
    if (!source || printing) return;
    setPrinting(true);
    try {
      const html = await buildPrintHtmlFor(att.fileName, source, () => closedRef.current);
      if (!closedRef.current) await printHtml(html);
    } catch {
      toast.error("Não foi possível preparar a impressão. Use o botão de baixar.");
    } finally {
      setPrinting(false);
    }
  }, [att.fileName, printing, source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        // Left alone, the browser would print the whole app that is behind the viewer.
        e.preventDefault();
        if (printAvailable) void print();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, print, printAvailable]);

  const content = { url: att.url, onReady: setSource, onError: () => setError(true) };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90" onClick={onClose} role="dialog" aria-modal="true" aria-label={att.fileName}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <p className="min-w-0 truncate text-sm">{att.fileName}</p>
        <div className="flex shrink-0 items-center gap-2">
          {printAvailable && (
            <button
              type="button"
              onClick={() => void print()}
              disabled={!source || printing}
              className="focus-ring inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
              aria-label="Imprimir"
              aria-busy={printing}
              title="Imprimir (Ctrl+P)"
            >
              <Printer className="h-4 w-4" />
              <span>{printing ? "Preparando..." : "Imprimir"}</span>
            </button>
          )}
          <a href={withAuthToken(att.url)} download={att.fileName} className="focus-ring rounded-full p-2 hover:bg-white/10" aria-label="Baixar">
            <Download className="h-4 w-4" />
          </a>
          <button onClick={onClose} className="focus-ring rounded-full p-2 hover:bg-white/10" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4" onClick={(e) => e.stopPropagation()}>
        {error ? (
          <p className="mt-10 text-center text-sm text-white/80">{ERROR_TEXT[kind]}</p>
        ) : (
          <>
            {!source && <p className="mt-10 text-center text-sm text-white/70">Carregando...</p>}
            {kind === "pdf" ? <PdfPages {...content} /> : kind === "text" ? <TextSheet {...content} /> : <WordPages {...content} />}
          </>
        )}
      </div>
    </div>
  );
}

/** A document in a message: PDFs, Word files and texts (.txt) get a preview and open in a viewer; anything else is a plain download card. */
export function DocumentAttachment({ att }: { att: MessageAttachmentDTO }) {
  const kind = documentKind(att);
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<number | null>(null);
  const [cardRef, inView] = useInView<HTMLButtonElement>();
  const previewable = ((kind === "pdf" || kind === "docx") && att.sizeBytes <= MAX_PREVIEW_BYTES) || (kind === "text" && att.sizeBytes <= MAX_TEXT_BYTES);
  const style = KIND_STYLE[kind];

  const details = (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${kind === "other" ? style.badge : "bg-black/10"}`}>
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{att.fileName}</p>
        <p className="text-xs opacity-75">
          {style.label && <span className={`me-1.5 rounded px-1 py-px text-[10px] font-bold ${style.badge}`}>{style.label}</span>}
          {pages ? `${pages} ${pages === 1 ? "página" : "páginas"} · ` : ""}
          {formatBytes(att.sizeBytes)}
        </p>
      </div>
    </div>
  );

  if (!previewable) {
    return (
      <a href={withAuthToken(att.url)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-black/10 bg-black/5 hover:bg-black/10">
        {details}
      </a>
    );
  }

  return (
    <>
      <button
        ref={cardRef}
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring block w-[220px] max-w-full overflow-hidden rounded border border-black/10 bg-black/5 text-left hover:bg-black/10"
        aria-label={`Visualizar ${att.fileName}`}
      >
        {inView && (
          <div className="max-h-[150px] overflow-hidden border-b border-black/10">
            {kind === "pdf" ? <PdfThumbnail url={att.url} onPages={setPages} /> : kind === "text" ? <TextThumbnail url={att.url} /> : <WordThumbnail url={att.url} />}
          </div>
        )}
        {details}
      </button>
      {open && <DocumentViewer att={att} kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}
