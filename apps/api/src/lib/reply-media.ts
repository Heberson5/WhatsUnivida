import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import type { Request, Response } from "express";
import { REPLY_MEDIA_CAPTION_MAX, replyMediaKind, type ReplyMediaDTO, type ReplyMediaLimitsDTO } from "@whatsatendende/types";
import { env } from "../config/env";
import { Errors } from "./http-error";

/**
 * The one image, video or PDF a quick reply or closing message can carry (Respostas). It goes out exactly as it was
 * uploaded — never compressed, so the quality is the one chosen — which is why it is held to what WhatsApp accepts
 * from the system: images 5 MB, videos 16 MB, documents 100 MB (capped by this server's own upload limit, since a
 * quick reply's file is sent through the same upload as any attachment).
 */
export function replyMediaLimits(): ReplyMediaLimitsDTO {
  return { imageMb: 5, videoMb: 16, documentMb: Math.min(100, env.UPLOAD_MAX_SIZE_MB) };
}

export interface ReplyMediaColumns {
  mediaStorageKey: string | null;
  mediaFileName: string | null;
  mediaMimeType: string | null;
  mediaSizeBytes: number | null;
}

export const NO_REPLY_MEDIA: ReplyMediaColumns = { mediaStorageKey: null, mediaFileName: null, mediaMimeType: null, mediaSizeBytes: null };

export function toReplyMediaDTO(row: ReplyMediaColumns): ReplyMediaDTO | null {
  if (!row.mediaStorageKey || !row.mediaFileName || !row.mediaMimeType) return null;
  return { fileName: row.mediaFileName, mimeType: row.mediaMimeType, sizeBytes: row.mediaSizeBytes ?? 0, kind: replyMediaKind(row.mediaMimeType) ?? "DOCUMENT" };
}

// Held in memory, then checked per kind before anything is written: the largest kind bounds the upload itself.
export const replyMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(...Object.values(replyMediaLimits())) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!replyMediaKind(file.mimetype)) return cb(Errors.badRequest("Escolha uma imagem (JPG, PNG ou WEBP), um vídeo (MP4) ou um PDF."));
    cb(null, true);
  },
});

/** Checks the uploaded file against its kind's limit and stores it — returns the columns to save on the row. */
export function storeReplyMedia(file: Express.Multer.File | undefined): ReplyMediaColumns {
  if (!file) throw Errors.badRequest("Nenhum arquivo enviado");
  const kind = replyMediaKind(file.mimetype);
  if (!kind) throw Errors.badRequest("Escolha uma imagem (JPG, PNG ou WEBP), um vídeo (MP4) ou um PDF.");
  const limits = replyMediaLimits();
  const limitMb = kind === "IMAGE" ? limits.imageMb : kind === "VIDEO" ? limits.videoMb : limits.documentMb;
  if (file.size > limitMb * 1024 * 1024) {
    const what = kind === "IMAGE" ? "imagem" : kind === "VIDEO" ? "vídeo" : "PDF";
    throw Errors.badRequest(`Pelo sistema, o WhatsApp aceita ${what} de até ${limitMb} MB. Reduza o arquivo antes de incluir.`);
  }
  const storageKey = `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`;
  fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), file.buffer);
  return { mediaStorageKey: storageKey, mediaFileName: file.originalname, mediaMimeType: file.mimetype, mediaSizeBytes: file.size };
}

/** With an attachment, the text goes along as its caption — which WhatsApp cuts past REPLY_MEDIA_CAPTION_MAX. */
export function assertCaptionFits(text: string, hasMedia: boolean): void {
  if (hasMedia && text.length > REPLY_MEDIA_CAPTION_MAX) {
    throw Errors.badRequest(`Com anexo, o texto vai como legenda e pode ter até ${REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres.`);
  }
}

/** Removes a file no row points to any more (replaced or removed). A file already gone is fine. */
export function deleteReplyMediaFile(storageKey: string | null | undefined): void {
  if (!storageKey) return;
  fs.rm(path.join(env.UPLOAD_DIR, storageKey), { force: true }, () => undefined);
}

/**
 * A copy of the attachment for one closing — the conversation keeps its own file, so replacing or removing the
 * attachment in Respostas later never breaks a message already scheduled or already in a conversation's history.
 */
export function copyReplyMediaFile(row: ReplyMediaColumns): HeldReplyMedia | null {
  const dto = toReplyMediaDTO(row);
  if (!dto || !row.mediaStorageKey) return null;
  const source = path.join(env.UPLOAD_DIR, row.mediaStorageKey);
  if (!fs.existsSync(source)) return null;
  const storageKey = `${randomUUID()}${path.extname(row.mediaStorageKey)}`;
  fs.copyFileSync(source, path.join(env.UPLOAD_DIR, storageKey));
  return { storageKey, fileName: dto.fileName, mimeType: dto.mimeType, sizeBytes: dto.sizeBytes };
}

export interface HeldReplyMedia {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** Streams a row's attachment back (the form's preview, or the composer staging a quick reply). */
export function sendReplyMedia(_req: Request, res: Response, row: ReplyMediaColumns): void {
  const dto = toReplyMediaDTO(row);
  if (!dto || !row.mediaStorageKey) throw Errors.notFound("Sem anexo");
  const filePath = path.join(env.UPLOAD_DIR, row.mediaStorageKey);
  if (!fs.existsSync(filePath)) throw Errors.notFound("Arquivo nao encontrado no armazenamento");
  res.setHeader("Content-Type", dto.mimeType);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(dto.fileName)}"`);
  res.sendFile(path.resolve(filePath));
}
