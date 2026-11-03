import type { Response } from "express";

// Types the browser shows without running anything: pictures, video, audio, PDF and plain text open on the screen.
const INLINE = /^(image\/(jpeg|png|webp|gif|bmp)|video\/.+|audio\/.+|application\/pdf|text\/plain)$/;

/**
 * The headers for a file someone sent in a conversation. Anything outside the safe list (an .svg, .html, .exe...) is
 * only ever downloaded: opened in the browser, on this site's own address, a file like that could run code with the
 * signed-in person's access. See PROMPT: "não pode ser permitido abrir por segurança".
 */
export function setConversationFileHeaders(res: Response, mimeType: string, fileName: string): void {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  const name = encodeURIComponent(fileName);
  if (INLINE.test(mime)) {
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    return;
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"; filename*=UTF-8''${name}`);
  res.setHeader("Content-Security-Policy", "sandbox");
}
