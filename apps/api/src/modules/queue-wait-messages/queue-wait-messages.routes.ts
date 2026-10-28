import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { connectionScopeSchema } from "../../lib/connection-scope";
import { NO_REPLY_MEDIA, deleteReplyMediaFile, replyMediaUpload, sendReplyMedia, storeReplyMedia } from "../../lib/reply-media";
import { toQueueWaitMessageDTO } from "./queue-wait-messages.mapper";
import * as service from "./queue-wait-messages.service";

export const queueWaitMessagesRouter = Router();

queueWaitMessagesRouter.use(requireAuth);
// Same audience as the other Respostas tabs.
queueWaitMessagesRouter.use(requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR));

queueWaitMessagesRouter.get(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_ESPERA_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json((await service.listQueueWaitMessages()).map(toQueueWaitMessageDTO));
  })
);

const bodySchema = z.object({
  // A day at most — longer than anyone stays in the queue.
  delayMinutes: z.number().int().min(1).max(1440),
  text: z.string().trim().min(1).max(4096),
  active: z.boolean(),
  connectionScope: connectionScopeSchema,
});

queueWaitMessagesRouter.post(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_ESPERA_ADICIONAR),
  asyncHandler(async (req, res) => {
    const input = bodySchema.parse(req.body);
    const row = await service.createQueueWaitMessage(input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "QUEUE_WAIT_MESSAGE_CREATED",
      entity: "QueueWaitMessage",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { delayMinutes: input.delayMinutes, active: input.active, connectionScope: input.connectionScope },
    });
    res.status(201).json(toQueueWaitMessageDTO(row));
  })
);

queueWaitMessagesRouter.patch(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_ESPERA_EDITAR),
  asyncHandler(async (req, res) => {
    const input = bodySchema.partial().parse(req.body);
    const row = await service.updateQueueWaitMessage(req.params.id, input);
    await writeAudit({ userId: req.auth!.userId, action: "QUEUE_WAIT_MESSAGE_UPDATED", entity: "QueueWaitMessage", entityId: row.id, ipAddress: req.ip ?? null, metadata: input });
    res.json(toQueueWaitMessageDTO(row));
  })
);

queueWaitMessagesRouter.post(
  "/:id/move",
  requirePermission(PERMISSION.RESPOSTAS_ESPERA_EDITAR),
  asyncHandler(async (req, res) => {
    const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
    const rows = await service.moveQueueWaitMessage(req.params.id, direction);
    await writeAudit({ userId: req.auth!.userId, action: "QUEUE_WAIT_MESSAGE_MOVED", entity: "QueueWaitMessage", entityId: req.params.id, ipAddress: req.ip ?? null, metadata: { direction } });
    res.json(rows.map(toQueueWaitMessageDTO));
  })
);

queueWaitMessagesRouter.delete(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_ESPERA_EXCLUIR),
  asyncHandler(async (req, res) => {
    await service.deleteQueueWaitMessage(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "QUEUE_WAIT_MESSAGE_DELETED", entity: "QueueWaitMessage", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

/** The attachment, for the form's preview. */
queueWaitMessagesRouter.get(
  "/:id/media",
  requirePermission(PERMISSION.RESPOSTAS_ESPERA_VISUALIZAR),
  asyncHandler(async (req, res) => {
    sendReplyMedia(req, res, await service.getQueueWaitMessage(req.params.id));
  })
);

// Adding, replacing or removing it: Gestor and Administrador only (RESPOSTAS_MIDIA_GERENCIAR is never offered to Atendente).
queueWaitMessagesRouter.post(
  "/:id/media",
  requirePermission(PERMISSION.RESPOSTAS_MIDIA_GERENCIAR),
  replyMediaUpload.single("file"),
  asyncHandler(async (req, res) => {
    await service.getQueueWaitMessage(req.params.id);
    const media = storeReplyMedia(req.file);
    const row = await service.setQueueWaitMessageMedia(req.params.id, media).catch((err) => {
      deleteReplyMediaFile(media.mediaStorageKey);
      throw err;
    });
    await writeAudit({
      userId: req.auth!.userId,
      action: "QUEUE_WAIT_MESSAGE_MEDIA_SET",
      entity: "QueueWaitMessage",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { fileName: media.mediaFileName, mimeType: media.mediaMimeType, sizeBytes: media.mediaSizeBytes },
    });
    res.json(toQueueWaitMessageDTO(row));
  })
);

queueWaitMessagesRouter.delete(
  "/:id/media",
  requirePermission(PERMISSION.RESPOSTAS_MIDIA_GERENCIAR),
  asyncHandler(async (req, res) => {
    const row = await service.setQueueWaitMessageMedia(req.params.id, NO_REPLY_MEDIA);
    await writeAudit({ userId: req.auth!.userId, action: "QUEUE_WAIT_MESSAGE_MEDIA_REMOVED", entity: "QueueWaitMessage", entityId: row.id, ipAddress: req.ip ?? null });
    res.json(toQueueWaitMessageDTO(row));
  })
);
