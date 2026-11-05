import type { Response } from "express";

/**
 * A Content-Disposition value that keeps the file's real name, accents included: `filename*` (RFC 5987/6266) carries
 * it in UTF-8 for every current browser, and `filename` a plain-ASCII version ("Manutencao.xlsx") for anything older.
 * Putting the percent-encoded name in plain `filename` — as before — made a saved file come out as
 * "Manuten%C3%A7%C3%A3o.pdf".
 */
export function contentDisposition(type: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Types the browser shows without running anything: pictures, video, audio, PDF and plain text open on the screen.
const INLINE = /^(image\/(jpeg|png|webp|gif|bmp)|video\/.+|audio\/.+|application\/pdf|text\/plain)$/;

/**
 * The headers for a file someone sent in a conversation. Anything outside the safe list (an .svg, .html, .exe...) is
 * only ever downloaded: opened in the browser, on this site's own address, a file like that could run code with the
 * signed-in person's access. See PROMPT: "não pode ser permitido abrir por segurança".
 */
export function setConversationFileHeaders(res: Response, mimeType: string, fileName: string): void {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  if (INLINE.test(mime)) {
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", contentDisposition("inline", fileName));
    return;
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition("attachment", fileName));
  res.setHeader("Content-Security-Policy", "sandbox");
}
