import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { connectionScopeSchema } from "../../lib/connection-scope";
import { toClosingMessageDTO } from "./closing-messages.mapper";
import * as service from "./closing-messages.service";
import { NO_REPLY_MEDIA, deleteReplyMediaFile, replyMediaUpload, sendReplyMedia, storeReplyMedia } from "../../lib/reply-media";

export const closingMessagesRouter = Router();

closingMessagesRouter.use(requireAuth);
// Same audience as respostas rápidas — see PROMPT: "O menu de Respostas,
// deverá estar habilitado nas permissões para o administrador e gestor."
closingMessagesRouter.use(requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR));

closingMessagesRouter.get(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_ENCERRAMENTO_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    const rows = await service.listClosingMessages();
    res.json(rows.map(toClosingMessageDTO));
  })
);

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  text: z.string().min(1).max(4096),
  active: z.boolean(),
  // Left out by an older client: with the name, as always.
  showSenderName: z.boolean().default(true),
  userIds: z.array(z.string().uuid()),
  connectionScope: connectionScopeSchema,
});

closingMessagesRouter.post(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_ENCERRAMENTO_ADICIONAR),
  asyncHandler(async (req, res) => {
    const input = bodySchema.parse(req.body);
    const row = await service.createClosingMessage(input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CLOSING_MESSAGE_CREATED",
      entity: "ClosingMessage",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { name: input.name, active: input.active, userIds: input.userIds, connectionScope: input.connectionScope },
    });
    res.status(201).json(toClosingMessageDTO(row));
  })
);

const updateSchema = bodySchema.partial();

closingMessagesRouter.patch(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_ENCERRAMENTO_EDITAR),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const row = await service.updateClosingMessage(req.params.id, input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CLOSING_MESSAGE_UPDATED",
      entity: "ClosingMessage",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: input,
    });
    res.json(toClosingMessageDTO(row));
  })
);

closingMessagesRouter.delete(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_ENCERRAMENTO_EXCLUIR),
  asyncHandler(async (req, res) => {
    await service.deleteClosingMessage(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "CLOSING_MESSAGE_DELETED", entity: "ClosingMessage", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

/** The attachment, for the form's preview. */
closingMessagesRouter.get(
  "/:id/media",
  requirePermission(PERMISSION.RESPOSTAS_ENCERRAMENTO_VISUALIZAR),
  asyncHandler(async (req, res) => {
    sendReplyMedia(req, res, await service.getClosingMessage(req.params.id));
  })
);

// Adding, replacing or removing it: Gestor and Administrador only (RESPOSTAS_MIDIA_GERENCIAR is never offered to Atendente).
closingMessagesRouter.post(
  "/:id/media",
  requirePermission(PERMISSION.RESPOSTAS_MIDIA_GERENCIAR),
  replyMediaUpload.single("file"),
  asyncHandler(async (req, res) => {
    await service.getClosingMessage(req.params.id);
    const media = storeReplyMedia(req.file);
    const row = await service.setClosingMessageMedia(req.params.id, media).catch((err) => {
      deleteReplyMediaFile(media.mediaStorageKey);
      throw err;
    });
    await writeAudit({
      userId: req.auth!.userId,
      action: "CLOSING_MESSAGE_MEDIA_SET",
      entity: "ClosingMessage",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { fileName: media.mediaFileName, mimeType: media.mediaMimeType, sizeBytes: media.mediaSizeBytes },
    });
    res.json(toClosingMessageDTO(row));
  })
);

closingMessagesRouter.delete(
  "/:id/media",
  requirePermission(PERMISSION.RESPOSTAS_MIDIA_GERENCIAR),
  asyncHandler(async (req, res) => {
    const row = await service.setClosingMessageMedia(req.params.id, NO_REPLY_MEDIA);
    await writeAudit({ userId: req.auth!.userId, action: "CLOSING_MESSAGE_MEDIA_REMOVED", entity: "ClosingMessage", entityId: row.id, ipAddress: req.ip ?? null });
    res.json(toClosingMessageDTO(row));
  })
);
