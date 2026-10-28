import { Router } from "express";
import { fillSendTags } from "../../lib/customer-tags";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { getConversationOrThrow, assertAgentCanAccessConversation } from "../conversations/conversations.service";
import { connectionScopeSchema } from "../../lib/connection-scope";
import { toQuickReplyDTO } from "./quick-replies.mapper";
import * as dataSources from "../data-sources/data-sources.service";
import * as service from "./quick-replies.service";
import { NO_REPLY_MEDIA, deleteReplyMediaFile as deleteReplyMediaFileQuietly, replyMediaLimits, replyMediaUpload, sendReplyMedia, storeReplyMedia } from "../../lib/reply-media";

export const quickRepliesRouter = Router();

quickRepliesRouter.use(requireAuth);

// Read-only, scoped to one conversation — powers the "/" picker in the
// composer. Deliberately NOT gated by RESPOSTAS_RAPIDAS_GERENCIAR: that
// permission controls who can *curate* the templates (Gestor/Admin, by
// default), not who can *use* them while attending a conversation — every
// agent already allowed into that conversation needs this. Same
// conversation-ownership check as messages.routes.ts's loadConversationForAgent.
quickRepliesRouter.get(
  "/conversation/:conversationId",
  asyncHandler(async (req, res) => {
    const conversation = await getConversationOrThrow(req.params.conversationId);
    if (req.auth!.role === "AGENT") assertAgentCanAccessConversation(conversation, req.auth!);
    // Quick replies are scoped to a WhatsApp connection only (see
    // QuickReply's doc comment in schema.prisma) — no Instagram/Messenger
    // equivalent yet, so an agent on one of those just sees an empty list
    // instead of the route crashing on a null connection id.
    if (!conversation.whatsappConnectionId) return res.json([]);
    const rows = (await service.listQuickRepliesForConnection(conversation.whatsappConnectionId)).map(toQuickReplyDTO);
    // Replies with {{dados.*}} only make sense with a usable data source: agents don't see them without one,
    // managers/admins do, marked unavailable. With one, the picker shows the text already filled.
    const { available } = await dataSources.availableTags(conversation);
    const visible = [];
    for (const reply of rows) {
      if (!dataSources.hasDataTags(reply.text)) visible.push(reply);
      else if (available) visible.push({ ...reply, filledText: (await dataSources.renderDataTags(conversation, reply.text, req.auth!.role)).text });
      else if (req.auth!.role !== "AGENT") visible.push({ ...reply, dataUnavailable: true });
    }
    // {{cliente}}, {{primeiro_nome}} and {{saudacao}} come already filled for this conversation's customer and this moment.
    const customer = conversation.contact.name ?? conversation.contact.phone ?? "";
    res.json(
      visible.map((reply) => {
        const text = reply.filledText ?? reply.text;
        const filled = fillSendTags(text, customer, conversation.contact.firstName);
        return filled === text ? reply : { ...reply, filledText: filled };
      })
    );
  })
);

/** What the attachment of a quick reply or closing message may be — shown before choosing the file. */
quickRepliesRouter.get("/media-limits", (_req, res) => {
  res.json(replyMediaLimits());
});

// The reply's attachment — for the form's preview and for the composer, which stages it when an agent picks the
// reply. Like the "/" picker above, open to anyone who attends, not only to who curates the replies.
quickRepliesRouter.get(
  "/:id/media",
  asyncHandler(async (req, res) => {
    sendReplyMedia(req, res, await service.getQuickReply(req.params.id));
  })
);

// Adding, replacing or removing it: Gestor and Administrador only (RESPOSTAS_MIDIA_GERENCIAR is never offered to Atendente).
const requireMediaPermission = [requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR), requirePermission(PERMISSION.RESPOSTAS_MIDIA_GERENCIAR)];

quickRepliesRouter.post(
  "/:id/media",
  ...requireMediaPermission,
  replyMediaUpload.single("file"),
  asyncHandler(async (req, res) => {
    await service.getQuickReply(req.params.id);
    const media = storeReplyMedia(req.file);
    const quickReply = await service.setQuickReplyMedia(req.params.id, media).catch((err) => {
      deleteReplyMediaFileQuietly(media.mediaStorageKey);
      throw err;
    });
    await writeAudit({
      userId: req.auth!.userId,
      action: "QUICK_REPLY_MEDIA_SET",
      entity: "QuickReply",
      entityId: quickReply.id,
      ipAddress: req.ip ?? null,
      metadata: { fileName: media.mediaFileName, mimeType: media.mediaMimeType, sizeBytes: media.mediaSizeBytes },
    });
    res.json(toQuickReplyDTO(quickReply));
  })
);

quickRepliesRouter.delete(
  "/:id/media",
  ...requireMediaPermission,
  asyncHandler(async (req, res) => {
    const quickReply = await service.setQuickReplyMedia(req.params.id, NO_REPLY_MEDIA);
    await writeAudit({ userId: req.auth!.userId, action: "QUICK_REPLY_MEDIA_REMOVED", entity: "QuickReply", entityId: quickReply.id, ipAddress: req.ip ?? null });
    res.json(toQuickReplyDTO(quickReply));
  })
);

quickRepliesRouter.get(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    const rows = await service.listQuickReplies();
    res.json(rows.map(toQuickReplyDTO));
  })
);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  shortcut: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^\/?[a-zA-Z0-9_-]+$/, "O atalho só pode ter letras, números, hífen e underline"),
  text: z.string().min(1).max(4096),
  connectionScope: connectionScopeSchema,
});

quickRepliesRouter.post(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_ADICIONAR),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const quickReply = await service.createQuickReply(input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "QUICK_REPLY_CREATED",
      entity: "QuickReply",
      entityId: quickReply.id,
      ipAddress: req.ip ?? null,
      metadata: { name: input.name, shortcut: quickReply.shortcut, connectionScope: input.connectionScope },
    });
    res.status(201).json(toQuickReplyDTO(quickReply));
  })
);

const updateSchema = createSchema.partial();

quickRepliesRouter.patch(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_EDITAR),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const quickReply = await service.updateQuickReply(req.params.id, input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "QUICK_REPLY_UPDATED",
      entity: "QuickReply",
      entityId: quickReply.id,
      ipAddress: req.ip ?? null,
      metadata: input,
    });
    res.json(toQuickReplyDTO(quickReply));
  })
);

quickRepliesRouter.delete(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_EXCLUIR),
  asyncHandler(async (req, res) => {
    await service.deleteQuickReply(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "QUICK_REPLY_DELETED", entity: "QuickReply", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);
