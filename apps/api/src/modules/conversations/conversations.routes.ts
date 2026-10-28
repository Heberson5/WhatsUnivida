import { Router, type Request } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import type { Channel, Role } from "@prisma/client";
import { OVERSIGHT_PAGE_SIZES, PERMISSION, type OversightPageDTO } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { env } from "../../config/env";
import { parseListParam } from "../../lib/parse-list-param";
import { optionalDateQueryParam, resolvePeriod } from "../../lib/period";
import { resolveAllowedConnectionIds, canManagerAccessConnection } from "../../lib/connection-access";
import { filterQueueForViewer } from "../../lib/queue-routing";
import { toConversationListItemDTO } from "./conversations.mapper";
import { attachBusinessClocks } from "../../lib/business-clock";
import { enqueueAutoMessage, isBlocked } from "../../lib/auto-messages";
import { customerArrivalIds } from "../dashboard/dashboard.service";
import * as service from "./conversations.service";
import { realtimeEvents } from "../../realtime/realtime";
import { syncReadReceiptToDevice, requestOlderHistory } from "../whatsapp/whatsapp.service";
import { createOutboundMessage, createSystemOutboundMessage } from "../messages/messages.service";
import { sendOutboundTextViaChannel } from "../messages/send-via-channel";
import { closeForNoReturn, setNoReturnHold } from "./no-return.service";
import { getActiveClosingMessageForAgent } from "../closing-messages/closing-messages.service";
import { resolveNumberToStart } from "../phone-numbers/resolve-number.service";
import { closingMessageType, sendClosingMedia, willSendSurveyOnClose, type HeldClosingMessage } from "../satisfaction/satisfaction.service";
import { copyReplyMediaFile } from "../../lib/reply-media";
import { getActiveTemplateFor, renderAutoMessageTemplate, ROLE_LABEL } from "../auto-message-templates/auto-message-templates.service";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

// Anyone who can attend conversations at all — see PROMPT: "o gestor e
// administrador também devem ter o menu de atendimentos e poderão atender e
// receber transferências". Configurable per role in Configurações >
// Permissões; defaults (AGENT/MANAGER true, ADMIN always true) reproduce
// what used to be the hardcoded ATTENDANCE_ROLES check.
const requireAttendanceAccess = requirePermission(PERMISSION.ATENDIMENTO_ACESSAR);

// Skipped only under NODE_ENV=test — same reasoning as auth.routes.ts's own
// copy of this: a single test file can legitimately trigger this well past
// the limit across its scenarios, which is test volume, not the repeated
// clicking this limiter exists to slow down. On-demand history backfill
// talks to WhatsApp's real servers per request (see requestOlderHistory) —
// this exists so mashing the button can't turn into something that looks
// like the account-wide dump BaileysWhatsAppProvider deliberately avoids.
const skipInTests = () => env.NODE_ENV === "test";
const historyBackfillLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, skip: skipInTests });

// Queue: an AGENT only ever sees their own WhatsApp connection's queue.
// MANAGER/ADMIN have no fixed connection, so they see every connection's
// queue combined by default, optionally narrowed with ?connectionId=.
// Never reveals a message preview (mapper enforces this).
conversationsRouter.get(
  "/queue",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const agent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { whatsappConnectionId: true } });
    // An AGENT with no assigned WhatsApp connection used to get an empty
    // queue outright — now falls through to connectionIds = [] (no
    // WhatsApp query param sent for an AGENT, who has no connection
    // filter UI), which still matches every Instagram/Messenger
    // conversation via listQueue's OR clause below.
    let connectionIds =
      req.auth!.role === "AGENT"
        ? agent?.whatsappConnectionId
          ? [agent.whatsappConnectionId]
          : []
        : parseListParam(req.query.connectionId as string | string[] | undefined);
    // A MANAGER only ever receives conversations from a connection they
    // created themselves or were explicitly granted — see PROMPT: "também
    // poderão receber novas conversas de quais conexões" (canReceiveConversations).
    if (req.auth!.role === "MANAGER") {
      connectionIds = await resolveAllowedConnectionIds(req.auth!, connectionIds, "receive");
    }
    // Etiquetas › "Atendida por": an attendant doesn't see a customer reserved for someone else who is online.
    const conversations = await filterQueueForViewer(await service.listQueue(connectionIds), { userId: req.auth!.userId, role: req.auth!.role });
    res.json(await attachBusinessClocks(conversations.map((c) => toConversationListItemDTO(c, false))));
  })
);

// Abandonados: left by the Fluxo (menus unanswered, or nobody of the transfer step online) — accepted like the queue.
conversationsRouter.get(
  "/abandoned",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const viewer = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { whatsappConnectionId: true } });
    let connectionIds = req.auth!.role === "AGENT" ? undefined : parseListParam(req.query.connectionId as string | string[] | undefined);
    if (req.auth!.role === "MANAGER") connectionIds = await resolveAllowedConnectionIds(req.auth!, connectionIds, "receive");
    const conversations = await service.listAbandoned({ userId: req.auth!.userId, role: req.auth!.role, whatsappConnectionId: viewer?.whatsappConnectionId ?? null }, connectionIds);
    res.json(await attachBusinessClocks(conversations.map((c) => toConversationListItemDTO(c, false))));
  })
);

conversationsRouter.get(
  "/mine",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversations = await service.listMyConversations(req.auth!.userId);
    res.json(await attachBusinessClocks(conversations.map((c) => toConversationListItemDTO(c, true))));
  })
);

// "Transferidas" — conversations this agent sent to someone else, so they
// can see who and when without it cluttering Ativos/Fila. See
// listTransferredOutByAgent for why the transfer object here is built from
// this agent's own transfer record rather than toConversationListItemDTO's
// default (the conversation's overall latest transfer, which could by now
// belong to someone else entirely if it moved on again).
conversationsRouter.get(
  "/transferred-out",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const rows = await service.listTransferredOutByAgent(req.auth!.userId);
    res.json(
      rows.map((r) => ({
        ...toConversationListItemDTO(r.conversation, true),
        transfer: {
          fromAgentName: req.auth!.displayName,
          toAgentName: r.toAgentName,
          at: r.transferredAt.toISOString(),
          note: r.note,
        },
      }))
    );
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
    // The typed number goes through Configurações › Números de telefone (DDI padrão, 9 a mais) first; WhatsApp
    // is asked only when the 9 was dropped, to know which of the two forms the account really has.
    const { phone: startPhone, confirmedOnWhatsApp } = await resolveNumberToStart(targetConnectionId, phone);
    const conversation = await service.startConversation(targetConnectionId, startPhone, name ?? null, req.auth!.userId, { confirmedOnWhatsApp });
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATION_STARTED",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { connectionId: targetConnectionId, phone: startPhone, ...(startPhone !== phone.replace(/\D/g, "") && { typedPhone: phone }) },
    });
    // startConversation only ever targets a WhatsApp connection (Nova
    // Conversa has no Instagram/Messenger equivalent — those channels are
    // inbound-only in this phase, and Meta's own policies restrict
    // businesses from opening a fresh DM to a customer who hasn't messaged
    // first).
    realtimeEvents.conversationAccepted(conversation.id, conversation.whatsappConnectionId!, req.auth!.userId);
    res.status(201).json(toConversationListItemDTO(conversation, true));
  })
);

// Oversight: full cross-connection visibility for MANAGER/ADMIN, read-only —
// distinct from their "/queue" and "/mine" above, which only ever show
// conversations they can actually act on (their own, or unassigned).
const oversightQuerySchema = z.object({
  // "hoje", "ontem"... — resolved below in the viewer's own time zone, the same way the Dashboard and Relatórios do.
  period: z.enum(["today", "yesterday", "last7days", "month", "lastMonth", "custom"]).optional(),
  from: optionalDateQueryParam,
  to: optionalDateQueryParam,
  // The browser's UTC offset in minutes (Date#getTimezoneOffset()) — see lib/period.ts for why the server can't use its own clock.
  tzOffsetMinutes: z.coerce.number().default(0),
  agentId: z.string().uuid().optional(),
  // Repeated query param (?status=a&status=b) or comma-separated — see
  // PROMPT: Dashboard's "Em atendimento" card needs IN_PROGRESS + TRANSFERRED at once.
  status: z.union([z.string(), z.array(z.string())]).optional(),
  q: z.string().trim().max(120).optional(),
  // Repeated query param (?connectionId=a&connectionId=b) or comma-separated; empty/absent = all connections.
  connectionId: z.union([z.string(), z.array(z.string())]).optional(),
});
const OVERSIGHT_STATUSES = new Set(["IN_FLOW", "NEW", "WAITING", "FLOW_ABANDONED", "IN_PROGRESS", "TRANSFERRED", "CLOSED", "ABANDONED", "HANDLED_EXTERNALLY"]);
conversationsRouter.get(
  "/oversight",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  asyncHandler(async (req, res) => {
    const filters = oversightQuerySchema.parse(req.query);
    let connectionIds = parseListParam(filters.connectionId);
    if (req.auth!.role === "MANAGER") {
      connectionIds = await resolveAllowedConnectionIds(req.auth!, connectionIds, "manage");
    }
    const status = parseListParam(filters.status)?.filter((s) => OVERSIGHT_STATUSES.has(s));
    // No period (or a "personalizado" still missing its dates) = whatever from/to came — a link from the
    // Dashboard's "Aguardando" card carries none and means "everything, right now".
    const range =
      filters.period && (filters.period !== "custom" || (filters.from && filters.to))
        ? resolvePeriod(filters.period, filters.from, filters.to, filters.tzOffsetMinutes)
        : { from: filters.from, to: filters.to };
    const conversations = await service.listAllConversations({
      from: range.from,
      to: range.to,
      agentId: filters.agentId,
      status,
      search: filters.q,
      connectionIds,
    });
    const matches = filters.q ? await service.findSearchMatches(conversations.map((c) => c.id), filters.q) : new Map<string, string>();
    res.json(conversations.map((c) => ({ ...toConversationListItemDTO(c, true), searchMatch: matches.get(c.id) ?? null })));
  })
);

// Gestão's own list, page by page — "Linhas por página" (50/100/200/300) and "Página X de Y".
const oversightPageSchema = oversightQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (OVERSIGHT_PAGE_SIZES as readonly number[]).includes(n), { message: "Quantidade de linhas inválida" })
    .default(50),
  // From the Dashboard's "Conversas que chegam ao longo do dia": only the conversations the customer opened in the
  // period — at this hour (0–23, the viewer's time zone), when given.
  openedByCustomer: z.enum(["1", "true"]).optional(),
  arrivalHour: z.coerce.number().int().min(0).max(23).optional(),
});

conversationsRouter.get(
  "/oversight/page",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  asyncHandler(async (req, res) => {
    const filters = oversightPageSchema.parse(req.query);
    let connectionIds = parseListParam(filters.connectionId);
    if (req.auth!.role === "MANAGER") {
      connectionIds = await resolveAllowedConnectionIds(req.auth!, connectionIds, "manage");
    }
    const status = parseListParam(filters.status)?.filter((s) => OVERSIGHT_STATUSES.has(s));
    const range =
      filters.period && (filters.period !== "custom" || (filters.from && filters.to))
        ? resolvePeriod(filters.period, filters.from, filters.to, filters.tzOffsetMinutes)
        : { from: filters.from, to: filters.to };
    const ids =
      filters.openedByCustomer || filters.arrivalHour !== undefined
        ? await customerArrivalIds({ from: range.from ?? new Date(0), to: range.to ?? new Date(), agentId: filters.agentId, connectionIds }, filters.arrivalHour, filters.tzOffsetMinutes)
        : undefined;
    const { items, total, statusCounts } = await service.listOversightPage(
      { from: range.from, to: range.to, agentId: filters.agentId, status, search: filters.q, connectionIds, ids },
      filters.page,
      filters.pageSize
    );
    const matches = filters.q ? await service.findSearchMatches(items.map((c) => c.id), filters.q) : new Map<string, string>();
    const body: OversightPageDTO = {
      items: await attachBusinessClocks(items.map((c) => ({ ...toConversationListItemDTO(c, true), searchMatch: matches.get(c.id) ?? null }))),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      statusCounts,
    };
    res.json(body);
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
    const [item] = await attachBusinessClocks([toConversationListItemDTO(conversation, true)]);
    res.json(item);
  })
);

// The "{{atendente}}"/"{{atendente_nome}}"/"{{atendente_cargo}}" tags in the
// template body always describe conversation.assignedAgent — the agent that
// ACCEPTED, or the one a TRANSFER is landing on — since that's already
// exactly who's assigned by the time either trigger fires. `sender` is a
// separate, independent concept: whose identity the message is actually
// sent AS — the WhatsApp prefix (withSenderPrefix, same as a normal reply)
// and the stored Message row's senderAgentId (so the in-app bubble shows
// the same badge). For ACCEPT these are the same person, so no distinction
// shows. For TRANSFER they differ: the body still says who's picking up the
// conversation, but the message is sent as whoever clicked "Transferir" —
// see PROMPT: "o nome de quem está transferindo a conversa apareça no
// topo, atualmente esta aparecendo de quem vai receber". `sender.name` is
// the User's registered `fullName`, not `displayName`, per that same
// PROMPT ("a mensagem precisa trazer o nome que está cadastrado lá no
// usuário, não o nome de exibição"). No-op when no ACTIVE template is
// configured for that trigger (see Respostas > Transferência/Aceite) — an
// admin who never touches those tabs sees no behavior change at all.
// Exactly one of these two is populated depending on `channel` — see
// Channel's doc comment in schema.prisma. Used anywhere a realtime event
// just needs "the room key for this conversation's connection", regardless
// of which table it's actually from.
function connectionIdOf(conversation: { whatsappConnectionId: string | null; metaConnectionId: string | null }): string {
  return conversation.whatsappConnectionId ?? conversation.metaConnectionId!;
}

/** The closing message when no survey follows — queued once the conversation is closed (see lib/auto-messages.ts). */
function queueClosingMessage(conversationId: string, closing: HeldClosingMessage) {
  return enqueueAutoMessage({
    conversationId,
    kind: "CLOSING",
    text: closing.text,
    media: closing.media,
    senderAgentId: closing.senderId,
    senderDisplayName: closing.senderDisplayName,
    condition: "CLOSED",
  });
}

async function sendAutoMessage(
  trigger: "TRANSFER" | "ACCEPT",
  conversation: {
    id: string;
    channel: Channel;
    whatsappConnectionId: string | null;
    assignedAgentId: string | null;
    assignedAgent: { displayName: string; fullName: string; role: Role } | null;
    contactId: string;
    contact: { phone: string | null; externalUserId: string | null; name: string | null; firstName?: string | null };
  },
  sender: { id: string; name: string }
): Promise<void> {
  const template = await getActiveTemplateFor(trigger, conversation.whatsappConnectionId, conversation.assignedAgentId);
  if (!template) return;
  // Aceite and Transferência never wait — but a tag may stop them.
  if (await isBlocked(conversation, trigger)) return;
  const templateAgent = conversation.assignedAgent;
  const text = renderAutoMessageTemplate(template.text, {
    atendente: templateAgent?.displayName ?? "",
    atendenteNome: templateAgent?.fullName ?? "",
    atendenteCargo: templateAgent ? ROLE_LABEL[templateAgent.role] : "",
    cliente: conversation.contact.name ?? conversation.contact.phone ?? "",
    primeiroNome: conversation.contact.firstName,
  });
  const message = await createSystemOutboundMessage({ conversationId: conversation.id, type: "TEXT", body: text, agentId: sender.id });
  await sendOutboundTextViaChannel(conversation, message.id, text, template.showSenderName ? sender.name : null);
  realtimeEvents.newMessage(conversation.id, conversation.assignedAgentId);
}

conversationsRouter.post(
  "/:id/accept",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    if (req.auth!.role === "MANAGER") {
      const target = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { whatsappConnectionId: true } });
      // ManagerConnectionAccess has no Instagram/Messenger equivalent yet
      // (see PROMPT: "prepare tudo para integrar com Instagram e
      // Facebook") — a Meta conversation has no whatsappConnectionId to
      // check, so every MANAGER can receive it, same as any AGENT can.
      if (target?.whatsappConnectionId && !(await canManagerAccessConnection(req.auth!.userId, target.whatsappConnectionId, "receive"))) {
        throw Errors.forbidden("Voce nao tem permissao para receber conversas desta conexao");
      }
    }
    if (req.auth!.role === "AGENT") {
      const target = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { id: true, contactId: true, channel: true, whatsappConnectionId: true } });
      if (target && (await filterQueueForViewer([target], { userId: req.auth!.userId, role: "AGENT" })).length === 0) {
        throw Errors.forbidden("Este cliente está reservado para outro atendente (etiqueta)");
      }
    }
    const conversation = await service.acceptConversation(req.params.id, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_ACCEPTED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null });
    realtimeEvents.conversationAccepted(conversation.id, connectionIdOf(conversation), req.auth!.userId);
    if (conversation.startedOnDevice) {
      // The customer was already being talked to on the phone — an "Aceite" message would look like
      // a second person taking over, so none goes out.
      await prisma.conversationNote.create({
        data: {
          conversationId: conversation.id,
          authorId: null,
          body: `Aceita por ${req.auth!.displayName} — a conversa veio do celular, então a mensagem de aceite não foi enviada.`,
        },
      });
    } else {
      await sendAutoMessage("ACCEPT", conversation, { id: req.auth!.userId, name: req.auth!.displayName });
    }
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
    service.assertCanReplyToConversation(existing, req.auth!.userId);
    const { toAgentId, note } = transferSchema.parse(req.body);
    const conversation = await service.transferConversation(req.params.id, req.auth!.userId, toAgentId, req.auth!.userId, note);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_TRANSFERRED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null, metadata: { toAgentId, note, offlineAtTransfer: conversation.pendingTransferDeadline !== null } });
    realtimeEvents.conversationTransferred(conversation.id, req.auth!.userId, toAgentId);
    const transferNotification = await createNotification({
      userId: toAgentId,
      type: "TRANSFER",
      title: "Conversa transferida para você",
      body: conversation.contact.name ?? conversation.contact.phone ?? "Contato",
      entityType: "Conversation",
      entityId: conversation.id,
    });
    realtimeEvents.notificationCreated(toAgentId, toNotificationDTO(transferNotification));
    // The message body still names whoever is RECEIVING the conversation
    // (conversation.assignedAgent, already toAgentId at this point), but
    // the message is sent as whoever just clicked "Transferir" —
    // req.auth!.userId — using their registered fullName, not displayName.
    const fromAgent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { fullName: true } });
    await sendAutoMessage("TRANSFER", conversation, {
      id: req.auth!.userId,
      name: fromAgent?.fullName ?? req.auth!.displayName,
    });
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
    realtimeEvents.conversationRead(req.params.id, req.auth!.userId);
    res.status(204).end();
  })
);

// On-demand, agent-triggered backfill of messages older than whatever this
// app already has for the conversation's contact — see PROMPT: "mensagens
// de antes de conectar o WhatsApp". Only the owning agent can trigger it
// (same boundary as /:id/transfer above); Gestão stays read-only. 202
// because the actual messages (if WhatsApp has any) arrive later, async,
// through the normal history-sync path — see requestOlderHistory.
conversationsRouter.post(
  "/:id/sync-older-history",
  requireAttendanceAccess,
  historyBackfillLimiter,
  asyncHandler(async (req, res) => {
    const conversation = await service.getConversationOrThrow(req.params.id);
    service.assertAgentCanAccessConversation(conversation, req.auth!);
    await requestOlderHistory(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_HISTORY_BACKFILL_REQUESTED", entity: "Conversation", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(202).end();
  })
);

// Gestão (MANAGER/ADMIN) directly routing a conversation, rather than just
// watching it — see PROMPT: "No menu gestão, precisa ter a opção de
// transferir para algum atendente ou enviar para fila". A MANAGER is scoped
// to connections they can manage, same boundary as /merge and /oversight;
// ADMIN is unrestricted. Works from any still-active status (including
// unclaimed NEW/WAITING or a customer parked in HANDLED_EXTERNALLY), unlike
// the agent-only /:id/transfer above.
async function assertManagerCanManageConversationConnection(req: Request): Promise<void> {
  const target = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { whatsappConnectionId: true } });
  if (!target) throw Errors.notFound("Conversa nao encontrada");
  // Same reasoning as the /:id/accept route above — no
  // ManagerConnectionAccess equivalent for Meta channels yet.
  if (target.whatsappConnectionId && req.auth!.role === "MANAGER" && !(await canManagerAccessConnection(req.auth!.userId, target.whatsappConnectionId, "manage"))) {
    throw Errors.forbidden("Voce nao tem permissao para gerenciar conversas desta conexao");
  }
}

const gestaoTransferSchema = z.object({ toAgentId: z.string().uuid() });
conversationsRouter.post(
  "/:id/gestao-transfer",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  requirePermission(PERMISSION.GESTAO_GERENCIAR),
  asyncHandler(async (req, res) => {
    await assertManagerCanManageConversationConnection(req);
    const { toAgentId } = gestaoTransferSchema.parse(req.body);
    const { conversation, previousAgentId } = await service.assignConversationFromGestao(req.params.id, toAgentId, req.auth!.userId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATION_ASSIGNED_BY_MANAGER",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { toAgentId, previousAgentId },
    });
    if (previousAgentId) {
      realtimeEvents.conversationTransferred(conversation.id, previousAgentId, toAgentId);
    } else {
      realtimeEvents.conversationAccepted(conversation.id, connectionIdOf(conversation), toAgentId);
    }
    res.json(toConversationListItemDTO(conversation, true));
  })
);

conversationsRouter.post(
  "/:id/gestao-return-to-queue",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  requirePermission(PERMISSION.GESTAO_GERENCIAR),
  asyncHandler(async (req, res) => {
    await assertManagerCanManageConversationConnection(req);
    const { conversation, previousAgentId } = await service.returnConversationToQueue(req.params.id, req.auth!.userId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATION_RETURNED_TO_QUEUE",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { previousAgentId },
    });
    const contactLabel = conversation.contact.name ?? conversation.contact.phone ?? "Contato";
    realtimeEvents.conversationReturnedToQueue(conversation.id, connectionIdOf(conversation), contactLabel, previousAgentId);
    res.json(toConversationListItemDTO(conversation, true));
  })
);

// Gestão › Intervir: the manager takes over replying; "Devolver" hands it back. Transferring or closing from Gestão ends it too.
conversationsRouter.post(
  "/:id/intervene",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  requirePermission(PERMISSION.GESTAO_INTERVIR),
  asyncHandler(async (req, res) => {
    await assertManagerCanManageConversationConnection(req);
    const conversation = await service.startIntervention(req.params.id, req.auth!.userId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATION_INTERVENTION_STARTED",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { agentId: conversation.assignedAgentId },
    });
    res.json(toConversationListItemDTO(conversation, true));
  })
);

conversationsRouter.post(
  "/:id/intervention/end",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  requirePermission(PERMISSION.GESTAO_INTERVIR),
  asyncHandler(async (req, res) => {
    await assertManagerCanManageConversationConnection(req);
    const conversation = await service.endIntervention(req.params.id, req.auth!.userId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATION_INTERVENTION_ENDED",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { agentId: conversation.assignedAgentId },
    });
    res.json(toConversationListItemDTO(conversation, true));
  })
);

const gestaoCloseSchema = z.object({ sendClosingMessage: z.boolean() });
conversationsRouter.post(
  "/:id/gestao-close",
  requirePermission(PERMISSION.GESTAO_ACESSAR),
  requirePermission(PERMISSION.GESTAO_GERENCIAR),
  asyncHandler(async (req, res) => {
    await assertManagerCanManageConversationConnection(req);
    const { sendClosingMessage } = gestaoCloseSchema.parse(req.body);
    const existing = await service.getConversationOrThrow(req.params.id);

    // Uses createSystemOutboundMessage (no ownership check, unlike the
    // agent's own /:id/close route) since the manager closing this from
    // Gestão is very often not its assigned agent — both the WhatsApp-side
    // prefix and the in-app bubble badge show the manager's own name
    // (their configured closing message), not the conversation's assigned
    // agent. Only attempted for a conversation that can actually receive
    // one (IN_PROGRESS/TRANSFERRED) — silently skipped for a still-unclaimed
    // or HANDLED_EXTERNALLY one, same as sendAutoMessage's own no-op
    // precedent.
    //
    // When the satisfaction survey follows this close, the closing message is
    // not sent here: the survey keeps it and sends it after the customer's
    // score, or when the wait runs out (see scheduleCloseFollowUp).
    let heldClosingMessage: HeldClosingMessage | undefined;
    let closingNow: HeldClosingMessage | undefined;
    if (sendClosingMessage && ["IN_PROGRESS", "TRANSFERRED"].includes(existing.status) && !(await isBlocked(existing, "CLOSING"))) {
      const closingMessage = await getActiveClosingMessageForAgent(req.auth!.userId, existing.whatsappConnectionId);
      if (closingMessage) {
        const closingAgent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { fullName: true } });
        const text = renderAutoMessageTemplate(closingMessage.text, {
          atendente: req.auth!.displayName,
          atendenteNome: closingAgent?.fullName ?? req.auth!.displayName,
          atendenteCargo: ROLE_LABEL[req.auth!.role],
          cliente: existing.contact.name ?? existing.contact.phone ?? "",
          primeiroNome: existing.contact.firstName,
        });
        // Its attachment (WhatsApp only), copied for this conversation — the text goes as the caption.
        const media = existing.channel === "WHATSAPP" ? copyReplyMediaFile(closingMessage) : null;
        const senderName = closingMessage.showSenderName ? req.auth!.displayName : null;
        if (await willSendSurveyOnClose(existing.id)) heldClosingMessage = { text, senderId: req.auth!.userId, senderDisplayName: senderName, media };
        else closingNow = { text, senderId: req.auth!.userId, senderDisplayName: senderName, media };
      }
    }

    // "Encerrar sem enviar mensagem": nothing goes to the customer — no closing message and no survey.
    const { conversation, previousAgentId } = await service.closeConversationFromGestao(req.params.id, req.auth!.userId, heldClosingMessage, {
      silent: !sendClosingMessage,
    });
    // Once closed: it waits its 3–10 seconds and is dropped if the close is undone meanwhile.
    if (closingNow) await queueClosingMessage(existing.id, closingNow);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATION_CLOSED_BY_MANAGER",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { previousAgentId, sentClosingMessage: sendClosingMessage },
    });
    realtimeEvents.conversationClosed(conversation.id, previousAgentId ?? req.auth!.userId);
    res.json(toConversationListItemDTO(conversation, true));
  })
);

// "Desfazer" after closing / returning to the queue — the service checks it's
// the same person, within the undo window, with nothing changed since.
conversationsRouter.post(
  "/:id/undo",
  asyncHandler(async (req, res) => {
    const conversation = await service.undoLastConversationAction(req.params.id, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_ACTION_UNDONE", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null });
    if (conversation.assignedAgentId) {
      realtimeEvents.conversationAccepted(conversation.id, connectionIdOf(conversation), conversation.assignedAgentId);
    } else {
      realtimeEvents.newQueueConversation(connectionIdOf(conversation), conversation.id, conversation.contact.name ?? conversation.contact.phone ?? "Contato");
    }
    res.json(toConversationListItemDTO(conversation, true));
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
    realtimeEvents.conversationsMerged(connectionIdOf(merged));
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
    service.assertCanReplyToConversation(existing, req.auth!.userId);

    // Auto-send this agent's assigned closing message, if any, BEFORE
    // actually closing — createOutboundMessage only accepts an
    // IN_PROGRESS/TRANSFERRED conversation, and sending it here means it
    // lands in history as the real last message of the thread, through
    // the exact same pipeline (own Message row, real WhatsApp delivery,
    // sender-name prefix) as anything an agent types. See PROMPT: "Lista
    // de quais usuários a mensagem será disparada automaticamente ao
    // clicar em encerrar."
    //
    // Exception: when the satisfaction survey follows this close, the message
    // is held instead: it is kept on the survey and goes out 10 s after the
    // customer's score (or when the configured wait runs out), unless the
    // agent undoes the close — see scheduleCloseFollowUp.
    let heldClosingMessage: HeldClosingMessage | undefined;
    let closingNow: HeldClosingMessage | undefined;
    const closingMessage = (await isBlocked(existing, "CLOSING")) ? null : await getActiveClosingMessageForAgent(req.auth!.userId, existing.whatsappConnectionId);
    if (closingMessage) {
      const closingAgent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { fullName: true } });
      const text = renderAutoMessageTemplate(closingMessage.text, {
        atendente: req.auth!.displayName,
        atendenteNome: closingAgent?.fullName ?? req.auth!.displayName,
        atendenteCargo: ROLE_LABEL[req.auth!.role],
        cliente: existing.contact.name ?? existing.contact.phone ?? "",
        primeiroNome: existing.contact.firstName,
      });
      // Its attachment (WhatsApp only), copied for this conversation — the text goes as the caption.
      const media = existing.channel === "WHATSAPP" ? copyReplyMediaFile(closingMessage) : null;
        const senderName = closingMessage.showSenderName ? req.auth!.displayName : null;
      if (await willSendSurveyOnClose(existing.id)) heldClosingMessage = { text, senderId: req.auth!.userId, senderDisplayName: senderName, media };
      else closingNow = { text, senderId: req.auth!.userId, senderDisplayName: senderName, media };
    }

    const conversation = await service.closeConversation(req.params.id, req.auth!.userId, heldClosingMessage);
    // Once closed: it waits its 3–10 seconds and is dropped if the agent clicks "Desfazer" meanwhile.
    if (closingNow) await queueClosingMessage(existing.id, closingNow);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_CLOSED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null });
    realtimeEvents.conversationClosed(conversation.id, req.auth!.userId);
    res.json(toConversationListItemDTO(conversation, true));
  })
);

// "Encerrar por falta de retorno": the no-return message goes out, no satisfaction survey, counted apart in the reports.
conversationsRouter.post(
  "/:id/close-no-return",
  requireAttendanceAccess,
  requirePermission(PERMISSION.ATENDIMENTO_ENCERRAR),
  asyncHandler(async (req, res) => {
    const existing = await service.getConversationOrThrow(req.params.id);
    service.assertAgentCanAccessConversation(existing, req.auth!);
    service.assertCanReplyToConversation(existing, req.auth!.userId);
    const conversation = await closeForNoReturn(existing.id, req.auth!.userId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONVERSATION_CLOSED",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { reason: "NO_RETURN" },
    });
    res.json(toConversationListItemDTO(conversation, true));
  })
);

// "Não encerrar automaticamente" / "Manter aberta": pauses (or resumes) the automatic close for falta de retorno.
conversationsRouter.post(
  "/:id/no-return-hold",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const { hold } = z.object({ hold: z.boolean() }).strict().parse(req.body ?? {});
    const existing = await service.getConversationOrThrow(req.params.id);
    service.assertAgentCanAccessConversation(existing, req.auth!);
    service.assertCanReplyToConversation(existing, req.auth!.userId);
    const conversation = await setNoReturnHold(existing.id, hold);
    res.json(toConversationListItemDTO(conversation, true));
  })
);
