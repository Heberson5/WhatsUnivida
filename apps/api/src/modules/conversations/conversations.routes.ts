import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsunivida/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { parseListParam } from "../../lib/parse-list-param";
import { optionalDateQueryParam } from "../../lib/period";
import { resolveAllowedConnectionIds, canManagerAccessConnection } from "../../lib/connection-access";
import { toConversationListItemDTO } from "./conversations.mapper";
import * as service from "./conversations.service";
import { realtimeEvents } from "../../realtime/realtime";
import { syncReadReceiptToDevice } from "../whatsapp/whatsapp.service";

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

// Anyone who can attend conversations at all — see PROMPT: "o gestor e
// administrador também devem ter o menu de atendimentos e poderão atender e
// receber transferências". Configurable per role in Configurações >
// Permissões; defaults (AGENT/MANAGER true, ADMIN always true) reproduce
// what used to be the hardcoded ATTENDANCE_ROLES check.
const requireAttendanceAccess = requirePermission(PERMISSION.ATENDIMENTO_ACESSAR);

// Queue: an AGENT only ever sees their own WhatsApp connection's queue.
// MANAGER/ADMIN have no fixed connection, so they see every connection's
// queue combined by default, optionally narrowed with ?connectionId=.
// Never reveals a message preview (mapper enforces this).
conversationsRouter.get(
  "/queue",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const agent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { whatsappConnectionId: true } });
    let connectionIds = agent?.whatsappConnectionId ? [agent.whatsappConnectionId] : parseListParam(req.query.connectionId as string | string[] | undefined);
    if (req.auth!.role === "AGENT" && !agent?.whatsappConnectionId) return res.json([]); // agent not assigned to a connection yet — nothing to queue from
    // A MANAGER only ever receives conversations from a connection they
    // created themselves or were explicitly granted — see PROMPT: "também
    // poderão receber novas conversas de quais conexões" (canReceiveConversations).
    if (req.auth!.role === "MANAGER") {
      connectionIds = await resolveAllowedConnectionIds(req.auth!, connectionIds, "receive");
    }
    const conversations = await service.listQueue(connectionIds);
    res.json(conversations.map((c) => toConversationListItemDTO(c, false)));
  })
);

conversationsRouter.get(
  "/mine",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversations = await service.listMyConversations(req.auth!.userId);
    res.json(conversations.map((c) => toConversationListItemDTO(c, true)));
  })
);

const startSchema = z.object({
  connectionId: z.string().uuid().optional(),
  phone: z.string().trim().min(8).max(20),
  name: z.string().trim().max(200).nullable().optional(),
});
// Starting a new conversation from a device contact — see PROMPT: "adicionar
// uma nova conversa através dos contatos salvos no celular de cada
// instância". An AGENT always starts on their own connection; MANAGER/ADMIN
// must say which connection since they have none of their own.
conversationsRouter.post(
  "/start",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const { connectionId, phone, name } = startSchema.parse(req.body);
    let targetConnectionId = connectionId;
    if (req.auth!.role === "AGENT") {
      const agent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { whatsappConnectionId: true } });
      if (!agent?.whatsappConnectionId) throw Errors.badRequest("Voce nao esta vinculado a nenhuma conexao de WhatsApp");
      targetConnectionId = agent.whatsappConnectionId;
    } else if (!targetConnectionId) {
      throw Errors.badRequest("Selecione a conexao de WhatsApp");
    }
    if (req.auth!.role === "MANAGER" && !(await canManagerAccessConnection(req.auth!.userId, targetConnectionId, "receive"))) {
      throw Errors.forbidden("Voce nao tem permissao para receber conversas desta conexao");
    }
    const conversation = await service.startConversation(targetConnectionId, phone, name ?? null, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_STARTED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null, metadata: { connectionId: targetConnectionId, phone } });
    realtimeEvents.conversationAccepted(conversation.id, conversation.whatsappConnectionId, req.auth!.userId);
    res.status(201).json(toConversationListItemDTO(conversation, true));
  })
);

// Oversight: full cross-connection visibility for MANAGER/ADMIN, read-only —
// distinct from their "/queue" and "/mine" above, which only ever show
// conversations they can actually act on (their own, or unassigned).
const oversightQuerySchema = z.object({
  from: optionalDateQueryParam,
  to: optionalDateQueryParam,
  agentId: z.string().uuid().optional(),
  status: z.enum(["NEW", "WAITING", "IN_PROGRESS", "TRANSFERRED", "CLOSED", "ABANDONED", "HANDLED_EXTERNALLY"]).optional(),
  q: z.string().optional(),
  // Repeated query param (?connectionId=a&connectionId=b) or comma-separated; empty/absent = all connections.
  connectionId: z.union([z.string(), z.array(z.string())]).optional(),
});
conversationsRouter.get(
  "/oversight",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  asyncHandler(async (req, res) => {
    const filters = oversightQuerySchema.parse(req.query);
    let connectionIds = parseListParam(filters.connectionId);
    if (req.auth!.role === "MANAGER") {
      connectionIds = await resolveAllowedConnectionIds(req.auth!, connectionIds, "manage");
    }
    const conversations = await service.listAllConversations({
      from: filters.from,
      to: filters.to,
      agentId: filters.agentId,
      status: filters.status,
      contactSearch: filters.q,
      connectionIds,
    });
    res.json(conversations.map((c) => toConversationListItemDTO(c, true)));
  })
);

conversationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const conversation = await service.getConversationOrThrow(req.params.id);
    if (req.auth!.role === "AGENT") {
      service.assertAgentCanAccessConversation(conversation, req.auth!);
    }
    // MANAGER/ADMIN fall through: read access granted, but this GET route
    // never permits mutation — reply/transfer/close routes independently
    // re-check assertAgentCanAccessConversation below.
    res.json(toConversationListItemDTO(conversation, true));
  })
);

conversationsRouter.post(
  "/:id/accept",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    if (req.auth!.role === "MANAGER") {
      const target = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { whatsappConnectionId: true } });
      if (target && !(await canManagerAccessConnection(req.auth!.userId, target.whatsappConnectionId, "receive"))) {
        throw Errors.forbidden("Voce nao tem permissao para receber conversas desta conexao");
      }
    }
    const conversation = await service.acceptConversation(req.params.id, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_ACCEPTED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null });
    realtimeEvents.conversationAccepted(conversation.id, conversation.whatsappConnectionId, req.auth!.userId);
    res.json(toConversationListItemDTO(conversation, true));
  })
);

const transferSchema = z.object({ toAgentId: z.string().uuid(), note: z.string().max(500).optional() });
conversationsRouter.post(
  "/:id/transfer",
  requireAttendanceAccess,
  requirePermission(PERMISSION.ATENDIMENTO_TRANSFERIR),
  asyncHandler(async (req, res) => {
    const existing = await service.getConversationOrThrow(req.params.id);
    service.assertAgentCanAccessConversation(existing, req.auth!);
    const { toAgentId, note } = transferSchema.parse(req.body);
    const conversation = await service.transferConversation(req.params.id, req.auth!.userId, toAgentId, req.auth!.userId, note);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_TRANSFERRED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null, metadata: { toAgentId, note, offlineAtTransfer: conversation.pendingTransferDeadline !== null } });
    realtimeEvents.conversationTransferred(conversation.id, req.auth!.userId, toAgentId);
    res.json(toConversationListItemDTO(conversation, true));
  })
);

conversationsRouter.post(
  "/:id/read",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    // Started before markConversationRead (which bumps assignedAgentReadAt)
    // so it still reads the pre-update unread cutoff; not awaited — it's a
    // real round trip to WhatsApp's servers (errors logged internally), and
    // the agent's own "mark read" click shouldn't wait on that.
    void syncReadReceiptToDevice(req.params.id);
    await service.markConversationRead(req.params.id, req.auth!.userId);
    res.status(204).end();
  })
);

const mergeSchema = z.object({ intoConversationId: z.string().uuid() });
conversationsRouter.post(
  "/:id/merge",
  // Irreversible (deletes the duplicate conversation row after moving its
  // messages) and only ever needed to clean up a pre-existing duplicate —
  // see findOrCreateContact's @lid contact-matching fix — so restricted to
  // ADMIN rather than the general attendance-permission set.
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const { intoConversationId } = mergeSchema.parse(req.body);
    const merged = await service.mergeConversations(req.params.id, intoConversationId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATIONS_MERGED",
      entity: "Conversation",
      entityId: merged.id,
      ipAddress: req.ip ?? null,
      metadata: { mergedConversationId: req.params.id },
    });
    realtimeEvents.conversationsMerged(merged.whatsappConnectionId);
    // The surviving conversation just gained the duplicate's messages —
    // reuses newMessage's existing wiring to refresh its owner's "mine"
    // list and this conversation's own view if it's open right now.
    realtimeEvents.newMessage(merged.id, merged.assignedAgentId);
    res.json(toConversationListItemDTO(merged, true));
  })
);

conversationsRouter.post(
  "/:id/close",
  requireAttendanceAccess,
  requirePermission(PERMISSION.ATENDIMENTO_ENCERRAR),
  asyncHandler(async (req, res) => {
    const existing = await service.getConversationOrThrow(req.params.id);
    service.assertAgentCanAccessConversation(existing, req.auth!);
    const conversation = await service.closeConversation(req.params.id, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_CLOSED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null });
    realtimeEvents.conversationClosed(conversation.id, req.auth!.userId);
    res.json(toConversationListItemDTO(conversation, true));
  })
);
