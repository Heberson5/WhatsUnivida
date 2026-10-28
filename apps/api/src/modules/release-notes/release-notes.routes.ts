import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { PERMISSION, RELEASE_NOTE_AREAS, type Permission, type ReleaseContent, type ReleaseNoteArea } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getPermissionsForRole } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { env } from "../../config/env";
import { Errors } from "../../lib/http-error";
import * as service from "./release-notes.service";

export const releaseNotesRouter = Router();

export const RELEASE_NOTE_UPLOAD_DIR = path.join(env.UPLOAD_DIR, "release-notes");
fs.mkdirSync(RELEASE_NOTE_UPLOAD_DIR, { recursive: true });

const IMAGE_MIME_TO_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!(file.mimetype in IMAGE_MIME_TO_EXT)) return cb(Errors.badRequest("Envie uma imagem PNG, JPG ou WebP"));
    cb(null, true);
  },
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

// Only screenshots of the system itself: the ones shipped with it, or the ones sent here.
const imageSrc = z
  .string()
  .regex(/^\/(notas-de-versao|uploads\/release-notes)\/[\w.-]+\.(webp|png|jpe?g)$/i, "Imagem inválida — envie a imagem pelo botão da nota");

const noteSchema = z
  .object({
    type: z.enum(["novo", "melhoria", "correcao"]),
    area: z.enum(Object.keys(RELEASE_NOTE_AREAS) as [ReleaseNoteArea, ...ReleaseNoteArea[]]),
    title: z.string().trim().min(1, "Toda nota precisa de um título").max(200),
    text: optionalText(4000),
    before: optionalText(1000),
    after: optionalText(1000),
    steps: z
      .array(z.string().trim().max(500))
      .max(20)
      .optional()
      .transform((steps) => {
        const filled = steps?.filter((s) => s !== "");
        return filled && filled.length > 0 ? filled : undefined;
      }),
    where: optionalText(300),
    images: z
      .array(z.object({ src: imageSrc, caption: z.string().trim().max(500), size: z.enum(["small", "tiny"]).optional() }))
      .max(10)
      .optional()
      .transform((images) => (images && images.length > 0 ? images : undefined)),
    requires: z.array(z.enum(Object.values(PERMISSION) as [Permission, ...Permission[]])).max(20).optional(),
    roles: z
      .array(z.enum(["ADMIN", "MANAGER", "AGENT"]))
      .max(3)
      .optional()
      .transform((roles) => (roles && roles.length > 0 ? roles : undefined)),
  })
  .refine((n) => Boolean(n.before) === Boolean(n.after), { message: "Preencha o Antes e o Agora juntos (ou nenhum dos dois)" });

export const releaseSchema = z.object({
  version: z.string().trim().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, "Use o número da versão no formato 2.3.0"),
  date: z.string().trim().min(1, "Informe a data").max(40),
  name: z.string().trim().min(1, "Dê um nome à versão").max(120),
  summary: z.string().trim().min(1, "Escreva o resumo da versão").max(1000),
  notes: z.array(noteSchema).min(1, "A versão precisa de pelo menos uma nota").max(80),
});

/** The release as sent by the editor — or a 400 that says what to fix, and in which note ("Nota 3: …"). */
function parseRelease(body: unknown): ReleaseContent {
  const result = releaseSchema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue.path[0] === "notes" && typeof issue.path[1] === "number" ? `Nota ${issue.path[1] + 1}: ` : "";
  throw Errors.badRequest(`${where}${issue.message}`, result.error.flatten());
}

releaseNotesRouter.use(requireAuth);

// The versions as this person sees them — only the notes about screens they can open.
releaseNotesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const permissions = await getPermissionsForRole(req.auth!.role);
    res.json(await service.listVisibleReleases(req.auth!.role, permissions));
  })
);

// Everything below is the editor of Configurações › Notas de versão — administrators only.
releaseNotesRouter.get(
  "/all",
  requireRole("ADMIN"),
  asyncHandler(async (_req, res) => {
    res.json(await service.listReleases());
  })
);

releaseNotesRouter.post(
  "/",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const release = await service.createRelease(parseRelease(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "RELEASE_NOTES_CREATED", entity: "ReleaseNoteVersion", entityId: release.id, ipAddress: req.ip ?? null, metadata: { version: release.version, notes: release.notes.length } });
    res.status(201).json(release);
  })
);

releaseNotesRouter.put(
  "/:id",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const release = await service.updateRelease(req.params.id, parseRelease(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "RELEASE_NOTES_UPDATED", entity: "ReleaseNoteVersion", entityId: release.id, ipAddress: req.ip ?? null, metadata: { version: release.version, notes: release.notes.length } });
    res.json(release);
  })
);

releaseNotesRouter.delete(
  "/:id",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const release = await service.deleteRelease(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "RELEASE_NOTES_DELETED", entity: "ReleaseNoteVersion", entityId: release.id, ipAddress: req.ip ?? null, metadata: { version: release.version } });
    res.status(204).end();
  })
);

releaseNotesRouter.post(
  "/images",
  requireRole("ADMIN"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhuma imagem enviada" });
    // The name comes from the validated type, never from the file sent.
    const fileName = `${randomUUID()}${IMAGE_MIME_TO_EXT[req.file.mimetype]}`;
    fs.writeFileSync(path.join(RELEASE_NOTE_UPLOAD_DIR, fileName), req.file.buffer);
    res.status(201).json({ src: `/uploads/release-notes/${fileName}` });
  })
);
