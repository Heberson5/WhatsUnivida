import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import { toMessageTemplateDTO } from "./message-templates.mapper";
import * as service from "./message-templates.service";

export const messageTemplatesRouter = Router();
messageTemplatesRouter.use(requireAuth);
// Same umbrella as every other Respostas tab — see PROMPT: "O menu de
// Respostas, deverá estar habilitado nas permissões para o administrador e
// gestor."
messageTemplatesRouter.use(requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR));

const listQuerySchema = z.object({
  whatsappConnectionId: z.string().uuid().optional(),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).optional(),
  status: z.enum(["DRAFT", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]).optional(),
});

messageTemplatesRouter.get(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_TEMPLATES_VISUALIZAR),
  asyncHandler(async (req, res) => {
    const filter = listQuerySchema.parse(req.query);
    const rows = await service.listTemplates(filter);
    res.json(rows.map(toMessageTemplateDTO));
  })
);

// Meta's real per-type limits — see PROMPT's own follow-up on attaching
// imagem/vídeo/documento: Imagem (JPG/PNG) até 5MB, Vídeo (MP4) até 16MB,
// Documento (PDF) até 100MB. Multer is capped at the largest (document);
// the tighter image/video limits are enforced in the handler below, where
// headerType is known.
const MAX_HEADER_SAMPLE_BYTES = 100 * 1024 * 1024;
const HEADER_SAMPLE_LIMITS: Record<string, { mimeTypes: string[]; maxBytes: number }> = {
  IMAGE: { mimeTypes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024 },
  VIDEO: { mimeTypes: ["video/mp4"], maxBytes: 16 * 1024 * 1024 },
  DOCUMENT: { mimeTypes: ["application/pdf"], maxBytes: 100 * 1024 * 1024 },
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_HEADER_SAMPLE_BYTES } });

const buttonSchema = z.union([
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().min(1).max(25) }),
  z.object({ type: z.literal("URL"), text: z.string().min(1).max(25), url: z.string().url() }),
  z.object({ type: z.literal("PHONE_NUMBER"), text: z.string().min(1).max(25), phoneNumber: z.string().min(8).max(20) }),
]);

const createBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, "Use apenas letras minusculas, numeros e _"),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
  language: z.string().trim().min(2).max(10),
  headerType: z.enum(["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"]),
  headerText: z.string().trim().max(60).optional(),
  bodyText: z.string().trim().min(1).max(1024),
  footerText: z.string().trim().max(60).optional(),
  buttons: z.array(buttonSchema).max(3).optional(),
  whatsappConnectionId: z.string().uuid(),
});

messageTemplatesRouter.post(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_TEMPLATES_ADICIONAR),
  upload.single("headerSample"),
  asyncHandler(async (req, res) => {
    // multipart/form-data arrives as strings — buttons is sent JSON-encoded.
    const raw = { ...req.body, buttons: req.body.buttons ? JSON.parse(req.body.buttons) : undefined };
    const input = createBodySchema.parse(raw);

    if (input.headerType === "IMAGE" || input.headerType === "VIDEO" || input.headerType === "DOCUMENT") {
      if (!req.file) throw Errors.badRequest("Envie o arquivo de amostra para este tipo de cabecalho");
      const limit = HEADER_SAMPLE_LIMITS[input.headerType];
      if (!limit.mimeTypes.includes(req.file.mimetype)) throw Errors.badRequest(`Tipo de arquivo nao permitido para ${input.headerType}`);
      if (req.file.size > limit.maxBytes) throw Errors.badRequest(`Arquivo maior que o limite de ${Math.round(limit.maxBytes / 1024 / 1024)}MB`);
    }

    const row = await service.createTemplate(
      input,
      req.file ? { buffer: req.file.buffer, originalname: req.file.originalname, mimetype: req.file.mimetype } : undefined
    );
    await writeAudit({
      userId: req.auth!.userId,
      action: "MESSAGE_TEMPLATE_CREATED",
      entity: "MessageTemplate",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { name: input.name, category: input.category, whatsappConnectionId: input.whatsappConnectionId },
    });
    res.status(201).json(toMessageTemplateDTO(row));
  })
);

messageTemplatesRouter.delete(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_TEMPLATES_EXCLUIR),
  asyncHandler(async (req, res) => {
    await service.deleteTemplate(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "MESSAGE_TEMPLATE_DELETED", entity: "MessageTemplate", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);
