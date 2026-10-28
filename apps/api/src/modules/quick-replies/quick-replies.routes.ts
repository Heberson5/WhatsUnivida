import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsunivida/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { getConversationOrThrow, assertAgentCanAccessConversation } from "../conversations/conversations.service";
import { toQuickReplyDTO } from "./quick-replies.mapper";
import * as service from "./quick-replies.service";

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
    const rows = await service.listQuickRepliesForConnection(conversation.whatsappConnectionId);
    res.json(rows.map(toQuickReplyDTO));
  })
);

quickRepliesRouter.use(requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR));

quickRepliesRouter.get(
  "/",
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
  whatsappConnectionId: z.string().uuid(),
});

quickRepliesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const quickReply = await service.createQuickReply(input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "QUICK_REPLY_CREATED",
      entity: "QuickReply",
      entityId: quickReply.id,
      ipAddress: req.ip ?? null,
      metadata: { name: input.name, shortcut: quickReply.shortcut, whatsappConnectionId: input.whatsappConnectionId },
    });
    res.status(201).json(toQuickReplyDTO(quickReply));
  })
);

const updateSchema = createSchema.partial();

quickRepliesRouter.patch(
  "/:id",
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
  asyncHandler(async (req, res) => {
    await service.deleteQuickReply(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "QUICK_REPLY_DELETED", entity: "QuickReply", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);
