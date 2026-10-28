import { Router, type Request } from "express";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { PERMISSION } from "@whatsatendende/types";
import type { MessageType } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { parseListParam } from "../../lib/parse-list-param";
import { Errors } from "../../lib/http-error";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { writeAudit } from "../../lib/audit";
import { transcodeToOggOpus } from "../../lib/audio-transcode";
import { toMessageDTO } from "../messages/messages.mapper";
import { addAttachment } from "../messages/messages.service";
import { upload, mimeToMessageType } from "../messages/messages.routes";
import * as whatsappService from "../whatsapp/whatsapp.service";
import * as service from "./groups.service";

export const groupsRouter = Router();
groupsRouter.use(requireAuth, requirePermission(PERMISSION.ATENDIMENTO_GRUPOS_VISUALIZAR));

const requireReplyPermission = requirePermission(PERMISSION.ATENDIMENTO_GRUPOS_RESPONDER);

groupsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const connectionIds = parseListParam(req.query.connectionIds as string | string[] | undefined);
    res.json(await service.listGroupsForUser(req.auth!, connectionIds));
  })
);

groupsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await service.getGroupsSummary(req.auth!));
  })
);

const querySchema = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().min(1).max(100).default(50) });
groupsRouter.get(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const group = await service.getGroupForUser(req.params.id, req.auth!);
    const { cursor, limit } = querySchema.parse(req.query);
    // Opening the group: ask WhatsApp to tell who of the participants is typing (best-effort).
    if (!cursor) whatsappService.watchCustomerTyping(group.id).catch(() => undefined);
    const result = await service.listGroupMessages(group.id, cursor, limit);
    res.json({ items: result.items.map(toMessageDTO), nextCursor: result.nextCursor });
  })
);

groupsRouter.get(
  "/:id/participants",
  asyncHandler(async (req, res) => {
    const group = await service.getGroupForUser(req.params.id, req.auth!);
    const info = await whatsappService.getGroupInfo(group.whatsappConnectionId!, group.contact.providerChatId!);
    const participants = (info?.participants ?? [])
      .map((p) => ({ jid: p.jid, name: p.name ?? (p.phone ? `+${p.phone}` : "Participante"), phone: p.phone, isAdmin: p.isAdmin }))
      .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name, "pt-BR"));
    res.json(participants);
  })
);

// Same bound as a customer conversation's "mensagens anteriores": a handful of WhatsApp requests per minute.
const historyBackfillLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, skip: () => env.NODE_ENV === "test" });

/** "Carregar mensagens anteriores": asks WhatsApp for older messages; they arrive later (group:history). */
groupsRouter.post(
  "/:id/older-history",
  historyBackfillLimiter,
  asyncHandler(async (req, res) => {
    const group = await service.getGroupForUser(req.params.id, req.auth!);
    await whatsappService.requestOlderGroupHistory(group.id);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_HISTORY_BACKFILL_REQUESTED", entity: "Conversation", entityId: group.id, ipAddress: req.ip ?? null });
    res.status(202).end();
  })
);

/** Opening the group: read for this person only. */
groupsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const group = await service.getGroupForUser(req.params.id, req.auth!);
    const firstReads = await service.markGroupRead(group.id, req.auth!.userId);
    void whatsappService.syncGroupReadReceiptToDevice(group.id, firstReads);
    res.status(204).end();
  })
);

groupsRouter.post(
  "/:id/mute",
  asyncHandler(async (req, res) => {
    const group = await service.getGroupForUser(req.params.id, req.auth!);
    await service.setGroupMuted(group.id, req.auth!.userId, true);
    res.status(204).end();
  })
);

groupsRouter.delete(
  "/:id/mute",
  asyncHandler(async (req, res) => {
    const group = await service.getGroupForUser(req.params.id, req.auth!);
    await service.setGroupMuted(group.id, req.auth!.userId, false);
    res.status(204).end();
  })
);

/** Replying needs the permission, and the number connected — same as a reply to a customer. */
async function loadGroupForReply(req: Request) {
  const group = await service.getGroupForUser(req.params.id, req.auth!);
  if (group.whatsappConnection?.status !== "CONNECTED") throw Errors.badRequest("A conexao esta desconectada — nao e possivel enviar mensagens");
  // The display name as it is in Usuários right now (the session keeps the one from login).
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { displayName: true } });
  return { group, chatId: group.contact.providerChatId!, senderName: user.displayName };
}

async function sent(req: Request, groupId: string, groupName: string, messageId: string, senderName: string, preview: string) {
  await writeAudit({
    userId: req.auth!.userId,
    action: "GROUP_MESSAGE_SENT",
    entity: "Message",
    entityId: messageId,
    ipAddress: req.ip ?? null,
    metadata: { groupId, groupName, text: preview },
  });
  const group = await prisma.conversation.findUnique({ where: { id: groupId }, select: { whatsappConnectionId: true } });
  await service.announceGroupMessage(groupId, group!.whatsappConnectionId!, groupName, senderName, preview, req.auth!.userId);
}

async function createOutbound(groupId: string, userId: string, type: MessageType, body: string | null, replyToMessageId?: string) {
  return service.createGroupOutboundMessage({ groupId, userId, type, body, replyToMessageId });
}

// "@": the text keeps "@Nome" (what the team reads here); WhatsApp gets "@<número>" plus the jids, so it shows the
// person's name and notifies them. "@todos" notifies every participant without listing them.
const sendTextSchema = z.object({
  body: z.string().min(1).max(4096),
  replyToMessageId: z.string().uuid().optional(),
  mentions: z.array(z.object({ jid: z.string().min(3).max(120), label: z.string().min(1).max(120) })).max(300).default([]),
  mentionAll: z.boolean().default(false),
});
groupsRouter.post(
  "/:id/text",
  requireReplyPermission,
  asyncHandler(async (req, res) => {
    const { group, chatId, senderName } = await loadGroupForReply(req);
    const { body, replyToMessageId, mentions, mentionAll } = sendTextSchema.parse(req.body);
    let whatsappText = body;
    for (const m of mentions) whatsappText = whatsappText.split(`@${m.label}`).join(`@${m.jid.split("@")[0]}`);
    const mentionJids = mentionAll
      ? ((await whatsappService.getGroupInfo(group.whatsappConnectionId!, chatId))?.participants ?? []).map((p) => p.jid)
      : mentions.map((m) => m.jid);
    const original = replyToMessageId ? await prisma.message.findFirst({ where: { id: replyToMessageId, conversationId: group.id } }) : null;
    const message = await createOutbound(group.id, req.auth!.userId, "TEXT", body, original?.id);
    // The same send as a reply to a customer: "*Nome de exibição:*", a blank line, the text.
    const dto = await whatsappService.sendOutboundText(
      group.whatsappConnectionId!,
      message.id,
      chatId,
      whatsappText,
      senderName,
      original?.providerMessageId ?? undefined,
      original?.body,
      original?.direction === "INBOUND" ? original.senderParticipantJid : null,
      mentionJids
    );
    await sent(req, group.id, group.contact.name ?? "Grupo", message.id, senderName, body);
    res.status(201).json(dto);
  })
);

groupsRouter.post(
  "/:id/file",
  requireReplyPermission,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const { group, chatId, senderName } = await loadGroupForReply(req);
    if (!req.file) throw Errors.badRequest("Nenhum arquivo enviado");
    const caption = (req.body?.caption as string) || null;
    const type = mimeToMessageType(req.file.mimetype);
    const message = await createOutbound(group.id, req.auth!.userId, type, caption);
    const storageKey = `${randomUUID()}${path.extname(req.file.originalname)}`;
    fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), req.file.buffer);
    await addAttachment(message.id, { fileName: req.file.originalname, mimeType: req.file.mimetype, sizeBytes: req.file.size, storageKey, kind: type });
    const dto = await whatsappService.sendOutboundFile(
      group.whatsappConnectionId!,
      message.id,
      chatId,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      senderName,
      caption ?? undefined
    );
    await sent(req, group.id, group.contact.name ?? "Grupo", message.id, senderName, caption ?? `Arquivo: ${req.file.originalname}`);
    res.status(201).json(dto);
  })
);

groupsRouter.post(
  "/:id/audio",
  requireReplyPermission,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const { group, chatId, senderName } = await loadGroupForReply(req);
    if (!req.file) throw Errors.badRequest("Nenhum audio enviado");
    let oggBuffer: Buffer;
    try {
      oggBuffer = await transcodeToOggOpus(req.file.buffer);
    } catch {
      throw Errors.badRequest("Nao foi possivel processar o audio gravado");
    }
    const message = await createOutbound(group.id, req.auth!.userId, "AUDIO", null);
    const storageKey = `${randomUUID()}.ogg`;
    fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), oggBuffer);
    await addAttachment(message.id, { fileName: "audio.ogg", mimeType: "audio/ogg", sizeBytes: oggBuffer.length, storageKey, kind: "AUDIO" });
    const dto = await whatsappService.sendOutboundAudio(group.whatsappConnectionId!, message.id, chatId, oggBuffer, "audio/ogg; codecs=opus");
    await sent(req, group.id, group.contact.name ?? "Grupo", message.id, senderName, "🎤 Áudio");
    res.status(201).json(dto);
  })
);

const locationSchema = z.object({ latitude: z.number(), longitude: z.number() });
groupsRouter.post(
  "/:id/location",
  requireReplyPermission,
  asyncHandler(async (req, res) => {
    const { group, chatId, senderName } = await loadGroupForReply(req);
    const { latitude, longitude } = locationSchema.parse(req.body);
    const message = await createOutbound(group.id, req.auth!.userId, "LOCATION", null);
    await addAttachment(message.id, { fileName: "location", mimeType: "application/geo+json", sizeBytes: 0, storageKey: "", kind: "LOCATION", latitude, longitude });
    const dto = await whatsappService.sendOutboundLocation(group.whatsappConnectionId!, message.id, chatId, latitude, longitude);
    await sent(req, group.id, group.contact.name ?? "Grupo", message.id, senderName, "📍 Localização");
    res.status(201).json(dto);
  })
);
