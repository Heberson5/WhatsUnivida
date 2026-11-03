/**
 * How a file goes to WhatsApp, by its type: only what WhatsApp itself plays or shows inline goes as a picture, a video or
 * an audio. Everything else (an .svg, a .heic, a .mov, a .rar, an .exe...) goes as a document, the way WhatsApp Web does —
 * sent as an image, a type WhatsApp can't draw arrives broken.
 */
export type WhatsAppMediaKind = "image" | "video" | "audio" | "document";

const IMAGE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO = new Set(["video/mp4", "video/3gpp"]);
const AUDIO = new Set(["audio/mpeg", "audio/ogg", "audio/mp4", "audio/aac", "audio/amr", "audio/webm"]);

export function whatsappMediaKind(mimeType: string): WhatsAppMediaKind {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  if (IMAGE.has(mime)) return "image";
  if (VIDEO.has(mime)) return "video";
  if (AUDIO.has(mime)) return "audio";
  return "document";
}
