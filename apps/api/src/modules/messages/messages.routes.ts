import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireAuthFromHeaderOrQuery, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { Errors } from "../../lib/http-error";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { writeAudit } from "../../lib/audit";
import { logger } from "../../lib/logger";
import { transcodeToOggOpus } from "../../lib/audio-transcode";
import * as service from "./messages.service";
import { toMessageDTO } from "./messages.mapper";
import * as whatsappService from "../whatsapp/whatsapp.service";
import * as metaService from "../meta/meta.service";
import * as templatesService from "../message-templates/message-templates.service";
import { toMessageTemplateDTO } from "../message-templates/message-templates.mapper";
import { realtimeEvents } from "../../realtime/realtime";
import * as groupsService from "../groups/groups.service";
import * as dataSources from "../data-sources/data-sources.service";
import * as boletos from "../boletos/boletos.service";
import { assertCanReplyToConversation, assertAgentCanReadContactHistory, assertAgentCanReadConversation, getConversationOrThrow } from "../conversations/conversations.service";

export const messagesRouter = Router();

messagesRouter.get(
  "/attachments/:attachmentId/download",
  requireAuthFromHeaderOrQuery,
  asyncHandler(async (req, res) => {
    const attachment = await prisma.messageAttachment.findUnique({
      where: { id: req.params.attachmentId },
      include: { message: { include: { conversation: true } } },
    });
    if (!attachment) throw Errors.notFound();
    if (attachment.message.conversation.status === "GROUP") {
      // A group's file: whoever sees that group (not "the conversation's agent" — a group has none).
      await groupsService.getGroupForUser(attachment.message.conversationId, req.auth!);
    } else if (req.auth!.role === "AGENT") {
      await assertAgentCanReadContactHistory(attachment.message.conversation.contactId, req.auth!);
    }
    if (!attachment.storageKey) throw Errors.notFound("Arquivo sem conteudo binario (ex.: localizacao/vcard)");
    const filePath = path.join(env.UPLOAD_DIR, attachment.storageKey);
    if (!fs.existsSync(filePath)) throw Errors.notFound("Arquivo nao encontrado no armazenamento");
    res.setHeader("Content-Type", attachment.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(attachment.fileName)}"`);
    res.sendFile(path.resolve(filePath));
  })
);

messagesRouter.use(requireAuth);

// MANAGER/ADMIN can also own and work a conversation in Atendimento (see
// conversations.routes.ts) — restricting sending to AGENT alone would let
// them accept a conversation but never reply in it. Same configurable
// permission as conversations.routes.ts's attendance gate.
const requireAttendanceAccess = requirePermission(PERMISSION.ATENDIMENTO_ACESSAR);

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/3gpp",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm",
  // Safari's MediaRecorder (used by the in-app voice-note recorder) has no
  // WebM support and falls back to this instead — ffmpeg transcodes it to
  // OGG/Opus the same as any other recording before it reaches WhatsApp,
  // see the /conversations/:conversationId/audio route below.
  "audio/mp4",
  "application/pdf",
  // Bloco de Notas (.txt) — o visualizador do sistema abre e imprime. Outros textos (.csv, .html...) continuam de fora.
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
]);

fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      // A plain Error here became a 500 "Erro interno do servidor"; this is the customer-facing reason.
      return cb(Errors.badRequest("Tipo de arquivo não permitido. Envie imagem, vídeo, áudio, PDF, Word, Excel, PowerPoint, Bloco de Notas (.txt) ou .zip."));
    }
    cb(null, true);
  },
});

export function mimeToMessageType(mime: string): "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" {
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

async function loadConversationForAgent(conversationId: string, agentId: string) {
  const conversation = await getConversationOrThrow(conversationId);
  // The assigned agent — or, during a Gestão intervention, only the person intervening.
  assertCanReplyToConversation(conversation, agentId);
  // Shared by every outbound send route (text/file/audio/location) — a
  // disconnected connection can't actually deliver anything, so block it
  // here once instead of duplicating the check in each route. Exactly one
  // of whatsappConnection/metaConnection is populated (see Channel's doc
  // comment in schema.prisma).
  const connectionStatus = conversation.channel === "WHATSAPP" ? conversation.whatsappConnection?.status : conversation.metaConnection?.status;
  if (connectionStatus !== "CONNECTED") {
    throw Errors.badRequest("A conexao esta desconectada — nao e possivel enviar mensagens");
  }
  return conversation;
}

// Arquivo/áudio/localização/reação ainda só existem para WhatsApp — ver
// PROMPT: "prepare tudo para integrar com Instagram e Facebook" (esse
// pedido cobriu texto; anexos ficam para depois, já que a API da Meta
// entrega mídia como uma URL de CDN a baixar, não como bytes prontos como
// o Baileys entrega). Checado antes de qualquer escrita no banco, não
// depois — evita criar uma mensagem PENDING que nunca seria enviada.
function assertWhatsAppChannel(conversation: { channel: string }, feature: string): void {
  if (conversation.channel !== "WHATSAPP") {
    throw Errors.badRequest(`${feature} ainda não é suportado para Instagram/Messenger`);
  }
}

const querySchema = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().min(1).max(100).default(30) });

messagesRouter.get(
  "/conversations/:conversationId",
  asyncHandler(async (req, res) => {
    const conversation = await getConversationOrThrow(req.params.conversationId);
    if (req.auth!.role === "AGENT") await assertAgentCanReadConversation(conversation, req.auth!);
    const { cursor, limit } = querySchema.parse(req.query);
    const result = await service.listMessages({ contactId: conversation.contactId, cursor, limit });
    res.json({ items: result.items.map(toMessageDTO), nextCursor: result.nextCursor });
  })
);

const sendTextSchema = z.object({ body: z.string().min(1).max(4096), replyToMessageId: z.string().uuid().optional() });
messagesRouter.post(
  "/conversations/:conversationId/text",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await loadConversationForAgent(req.params.conversationId, req.auth!.userId);
    const parsed = sendTextSchema.parse(req.body);
    const { replyToMessageId } = parsed;
    // Safety lock: a {{dados.coluna}} without a value for this client never goes out.
    const body = await dataSources.fillDataTagsOrThrow(conversation, parsed.body, req.auth!.role);

    const message = await service.createOutboundMessage({
      conversationId: conversation.id,
      agentId: req.auth!.userId,
      type: "TEXT",
      body,
      replyToMessageId,
    });

    let replyToProviderMessageId: string | undefined;
    let replyToText: string | null | undefined;
    if (replyToMessageId) {
      const original = await prisma.message.findUnique({ where: { id: replyToMessageId } });
      replyToProviderMessageId = original?.providerMessageId ?? undefined;
      replyToText = original?.body;
    }

    const dto =
      conversation.channel === "WHATSAPP"
        ? await whatsappService.sendOutboundText(
            conversation.whatsappConnectionId!,
            message.id,
            conversation.contact.phone!,
            body,
            req.auth!.displayName,
            replyToProviderMessageId,
            replyToText
          )
        : // Instagram/Messenger have no reply-to-quote or sender-name-prefix
          // concept on the Send API — just the bare text.
          await metaService.sendMetaMessage(conversation.channel, message.id, conversation.contact.externalUserId!, body);
    await writeAudit({
      userId: req.auth!.userId,
      action: "MESSAGE_SENT",
      entity: "Message",
      entityId: message.id,
      ipAddress: req.ip ?? null,
      metadata: { conversationId: conversation.id, contactName: conversation.contact.name, contactPhone: conversation.contact.phone, text: body },
    });
    realtimeEvents.newMessage(conversation.id, req.auth!.userId);
    res.status(201).json(dto);
  })
);

// WhatsApp Oficial: whether the 24h customer window is still open and which
// approved templates this conversation's connection can send.
messagesRouter.get(
  "/conversations/:conversationId/template-context",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await getConversationOrThrow(req.params.conversationId);
    if (req.auth!.role === "AGENT") await assertAgentCanReadConversation(conversation, req.auth!);
    const context = await templatesService.getTemplateContext(conversation);
    res.json({ ...context, templates: context.templates.map(toMessageTemplateDTO) });
  })
);

const sendTemplateSchema = z.object({
  templateId: z.string().uuid(),
  headerParams: z.array(z.string().trim().min(1).max(60)).max(1).default([]),
  bodyParams: z.array(z.string().trim().min(1).max(1024)).max(20).default([]),
});
messagesRouter.post(
  "/conversations/:conversationId/template",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await loadConversationForAgent(req.params.conversationId, req.auth!.userId);
    const { templateId, headerParams, bodyParams } = sendTemplateSchema.parse(req.body);
    const template = await templatesService.getTemplate(templateId);
    if (template.status !== "APPROVED" || template.whatsappConnectionId !== conversation.whatsappConnectionId) {
      throw Errors.badRequest("Este template não está aprovado para a conexão desta conversa");
    }
    if (headerParams.length !== templatesService.templateParamCount(template.headerType === "TEXT" ? template.headerText : null)) {
      throw Errors.badRequest("Preencha todos os campos do cabeçalho do template");
    }
    if (bodyParams.length !== templatesService.templateParamCount(template.bodyText)) {
      throw Errors.badRequest("Preencha todos os campos do texto do template");
    }

    const text = templatesService.renderTemplateText(template, headerParams, bodyParams);
    const message = await service.createOutboundMessage({ conversationId: conversation.id, agentId: req.auth!.userId, type: "TEXT", body: text });
    const headerMedia =
      template.headerSampleStorageKey && template.headerSampleMimeType && ["IMAGE", "VIDEO", "DOCUMENT"].includes(template.headerType)
        ? {
            kind: template.headerType.toLowerCase() as "image" | "video" | "document",
            buffer: fs.readFileSync(path.join(env.UPLOAD_DIR, template.headerSampleStorageKey)),
            fileName: template.headerSampleFileName ?? "arquivo",
            mimeType: template.headerSampleMimeType,
          }
        : undefined;
    const dto = await whatsappService.sendOutboundTemplate(conversation.whatsappConnectionId!, message.id, conversation.contact.phone!, {
      name: template.name,
      language: template.language,
      headerParams,
      headerMedia,
      bodyParams,
    });
    await writeAudit({
      userId: req.auth!.userId,
      action: "MESSAGE_TEMPLATE_SENT",
      entity: "Message",
      entityId: message.id,
      ipAddress: req.ip ?? null,
      metadata: { conversationId: conversation.id, template: template.name },
    });
    realtimeEvents.newMessage(conversation.id, req.auth!.userId);
    res.status(201).json(dto);
  })
);

messagesRouter.post(
  "/conversations/:conversationId/file",
  requireAttendanceAccess,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const conversation = await loadConversationForAgent(req.params.conversationId, req.auth!.userId);
    assertWhatsAppChannel(conversation, "Envio de arquivos");
    if (!req.file) throw Errors.badRequest("Nenhum arquivo enviado");

    const type = mimeToMessageType(req.file.mimetype);
    const caption = req.body?.caption ? await dataSources.fillDataTagsOrThrow(conversation, req.body.caption as string, req.auth!.role) : undefined;
    const message = await service.createOutboundMessage({
      conversationId: conversation.id,
      agentId: req.auth!.userId,
      type,
      body: caption || null,
    });

    const storageKey = `${randomUUID()}${path.extname(req.file.originalname)}`;
    fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), req.file.buffer);
    await service.addAttachment(message.id, {
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storageKey,
      kind: type,
    });

    const dto = await whatsappService.sendOutboundFile(
      conversation.whatsappConnectionId!,
      message.id,
      conversation.contact.phone!,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.auth!.displayName,
      caption || undefined
    );
    await writeAudit({
      userId: req.auth!.userId,
      action: "MESSAGE_SENT",
      entity: "Message",
      entityId: message.id,
      ipAddress: req.ip ?? null,
      metadata: {
        conversationId: conversation.id,
        contactName: conversation.contact.name,
        contactPhone: conversation.contact.phone,
        text: caption || `Arquivo: ${req.file.originalname}`,
      },
    });
    realtimeEvents.newMessage(conversation.id, req.auth!.userId);
    res.status(201).json(dto);
  })
);

messagesRouter.post(
  "/conversations/:conversationId/audio",
  // A recorded voice note (the mic button) — distinct from the generic
  // /file route above, which now sends an attached audio file as a
  // regular playable audio message (ptt: false). This one always sends
  // WhatsApp's native PTT voice-note bubble, which only renders correctly
  // for genuine OGG/Opus — never the browser's raw recorder output (see
  // PROMPT: "está chegando no celular do cliente como um arquivo web").
  requireAttendanceAccess,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const conversation = await loadConversationForAgent(req.params.conversationId, req.auth!.userId);
    assertWhatsAppChannel(conversation, "Envio de áudio");
    if (!req.file) throw Errors.badRequest("Nenhum audio enviado");

    let oggBuffer: Buffer;
    try {
      oggBuffer = await transcodeToOggOpus(req.file.buffer);
    } catch {
      throw Errors.badRequest("Nao foi possivel processar o audio gravado");
    }

    const message = await service.createOutboundMessage({
      conversationId: conversation.id,
      agentId: req.auth!.userId,
      type: "AUDIO",
    });

    const storageKey = `${randomUUID()}.ogg`;
    fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), oggBuffer);
    await service.addAttachment(message.id, {
      fileName: "audio.ogg",
      mimeType: "audio/ogg",
      sizeBytes: oggBuffer.length,
      storageKey,
      kind: "AUDIO",
    });

    const dto = await whatsappService.sendOutboundAudio(
      conversation.whatsappConnectionId!,
      message.id,
      conversation.contact.phone!,
      oggBuffer,
      "audio/ogg; codecs=opus"
    );
    await writeAudit({
      userId: req.auth!.userId,
      action: "MESSAGE_SENT",
      entity: "Message",
      entityId: message.id,
      ipAddress: req.ip ?? null,
      metadata: { conversationId: conversation.id, contactName: conversation.contact.name, contactPhone: conversation.contact.phone, text: "Áudio (nota de voz)" },
    });
    realtimeEvents.newMessage(conversation.id, req.auth!.userId);
    res.status(201).json(dto);
  })
);

const locationSchema = z.object({ latitude: z.number(), longitude: z.number() });
messagesRouter.post(
  "/conversations/:conversationId/location",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await loadConversationForAgent(req.params.conversationId, req.auth!.userId);
    assertWhatsAppChannel(conversation, "Envio de localização");
    const { latitude, longitude } = locationSchema.parse(req.body);
    const message = await service.createOutboundMessage({
      conversationId: conversation.id,
      agentId: req.auth!.userId,
      type: "LOCATION",
    });
    await service.addAttachment(message.id, {
      fileName: "location",
      mimeType: "application/geo+json",
      sizeBytes: 0,
      storageKey: "",
      kind: "LOCATION",
      latitude,
      longitude,
    });
    const dto = await whatsappService.sendOutboundLocation(conversation.whatsappConnectionId!, message.id, conversation.contact.phone!, latitude, longitude);
    await writeAudit({
      userId: req.auth!.userId,
      action: "MESSAGE_SENT",
      entity: "Message",
      entityId: message.id,
      ipAddress: req.ip ?? null,
      metadata: { conversationId: conversation.id, contactName: conversation.contact.name, contactPhone: conversation.contact.phone, text: "Localização compartilhada" },
    });
    realtimeEvents.newMessage(conversation.id, req.auth!.userId);
    res.status(201).json(dto);
  })
);

// "Encaminhar" — copies one message (text, photo, video, document or audio)
// into up to 10 of the agent's own conversations, each one a normal send
// (agent-name prefix included) that remembers which message it came from.
const FORWARDABLE_TYPES = ["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "AUDIO"];
const forwardSchema = z.object({ conversationIds: z.array(z.string().uuid()).min(1).max(10) });
messagesRouter.post(
  "/:messageId/forward",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const { conversationIds } = forwardSchema.parse(req.body);
    const original = await prisma.message.findUnique({ where: { id: req.params.messageId }, include: { conversation: true, attachments: true } });
    if (!original || original.deletedAt) throw Errors.notFound("Mensagem nao encontrada");
    if (req.auth!.role === "AGENT") await assertAgentCanReadContactHistory(original.conversation.contactId, req.auth!);
    if (!FORWARDABLE_TYPES.includes(original.type)) throw Errors.badRequest("Este tipo de mensagem nao pode ser encaminhado");
    const attachment = original.type === "TEXT" ? null : original.attachments[0];
    if (original.type !== "TEXT" && !attachment?.storageKey) throw Errors.badRequest("O arquivo desta mensagem nao esta disponivel");
    const targets = await Promise.all([...new Set(conversationIds)].map((id) => loadConversationForAgent(id, req.auth!.userId)));
    if (attachment) for (const target of targets) assertWhatsAppChannel(target, "Encaminhar arquivos");
    const buffer = attachment ? fs.readFileSync(path.join(env.UPLOAD_DIR, attachment.storageKey)) : null;

    const sent = [];
    for (const target of targets) {
      const message = await service.createOutboundMessage({
        conversationId: target.id,
        agentId: req.auth!.userId,
        type: original.type,
        body: original.body,
        forwardedFromMessageId: original.id,
      });
      let dto;
      if (!attachment) {
        dto =
          target.channel === "WHATSAPP"
            ? await whatsappService.sendOutboundText(target.whatsappConnectionId!, message.id, target.contact.phone!, original.body!, req.auth!.displayName)
            : await metaService.sendMetaMessage(target.channel, message.id, target.contact.externalUserId!, original.body!);
      } else {
        const storageKey = `${randomUUID()}${path.extname(attachment.storageKey)}`;
        fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), buffer!);
        await service.addAttachment(message.id, {
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          storageKey,
          kind: attachment.kind,
        });
        dto =
          original.type === "AUDIO" && attachment.mimeType.startsWith("audio/ogg")
            ? await whatsappService.sendOutboundAudio(target.whatsappConnectionId!, message.id, target.contact.phone!, buffer!, "audio/ogg; codecs=opus")
            : await whatsappService.sendOutboundFile(
                target.whatsappConnectionId!,
                message.id,
                target.contact.phone!,
                buffer!,
                attachment.fileName,
                attachment.mimeType,
                req.auth!.displayName,
                original.body ?? undefined
              );
      }
      await writeAudit({
        userId: req.auth!.userId,
        action: "MESSAGE_FORWARDED",
        entity: "Message",
        entityId: message.id,
        ipAddress: req.ip ?? null,
        metadata: {
          conversationId: target.id,
          fromMessageId: original.id,
          fromConversationId: original.conversationId,
          contactName: target.contact.name,
          contactPhone: target.contact.phone,
          text: original.body ?? `Arquivo: ${attachment?.fileName}`,
        },
      });
      realtimeEvents.newMessage(target.id, req.auth!.userId);
      sent.push(dto);
    }
    res.status(201).json(sent);
  })
);

// Boleto from Dados do cliente: preview first, then one PDF with every parcel (in the source's layout) captioned with the
// editable message, and — when ticked — each linha digitável.
const boletoSelectionSchema = z.object({ parcelIds: z.array(z.string().uuid()).min(1).max(24) });
messagesRouter.post(
  "/conversations/:conversationId/boletos/preview",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await loadConversationForAgent(req.params.conversationId, req.auth!.userId);
    assertWhatsAppChannel(conversation, "Envio de boleto");
    const { parcelIds } = boletoSelectionSchema.parse(req.body);
    res.json(await boletos.previewBoletos(conversation, parcelIds));
  })
);

// sendLinhas: the attendant ticks it to also send each boleto's linha digitável in its own message.
const boletoSendSchema = boletoSelectionSchema.extend({ message: z.string().max(4096), confirmOverdue: z.boolean().default(false), sendLinhas: z.boolean() });
messagesRouter.post(
  "/conversations/:conversationId/boletos/send",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await loadConversationForAgent(req.params.conversationId, req.auth!.userId);
    assertWhatsAppChannel(conversation, "Envio de boleto");
    const input = boletoSendSchema.parse(req.body);
    const prepared = await boletos.prepareBoletos(conversation, input.parcelIds, input.confirmOverdue);
    const message = input.message.trim() ? await dataSources.fillDataTagsOrThrow(conversation, input.message.trim(), req.auth!.role) : "";
    const connectionId = conversation.whatsappConnectionId!;
    const phone = conversation.contact.phone!;

    // The message goes as the PDF's caption (comentário), like any file sent with text.
    const document = await service.createOutboundMessage({ conversationId: conversation.id, agentId: req.auth!.userId, type: "DOCUMENT", body: message || null });
    await service.addAttachment(document.id, { fileName: prepared.fileName, mimeType: "application/pdf", sizeBytes: prepared.pdf.length, storageKey: prepared.storageKey, kind: "DOCUMENT" });
    await whatsappService.sendOutboundFile(connectionId, document.id, phone, prepared.pdf, prepared.fileName, "application/pdf", req.auth!.displayName, message || undefined);
    for (const item of prepared.items) {
      if (input.sendLinhas) {
        // Only the digits, ready to paste in the bank's app. The client doesn't see the agent's name; the platform does.
        const linhaDigits = item.linha.replace(/\D/g, "");
        const linhaMessage = await service.createOutboundMessage({ conversationId: conversation.id, agentId: req.auth!.userId, type: "TEXT", body: linhaDigits });
        await whatsappService.sendOutboundText(connectionId, linhaMessage.id, phone, linhaDigits, null);
      }
      await prisma.conversationNote.create({
        data: {
          conversationId: conversation.id,
          authorId: null,
          body: `Boleto enviado por ${req.auth!.displayName}: contrato ${item.contract}, vencimento ${item.due}, ${item.value}${item.overdue ? " (já vencido, envio confirmado)" : ""}.`,
        },
      });
      await writeAudit({
        userId: req.auth!.userId,
        action: "BOLETO_SENT",
        entity: "Conversation",
        entityId: conversation.id,
        ipAddress: req.ip ?? null,
        metadata: { ...item, contactName: conversation.contact.name, contactPhone: phone },
      });
    }
    realtimeEvents.newMessage(conversation.id, req.auth!.userId);
    realtimeEvents.notesChanged(conversation.id, [req.auth!.userId]);
    res.status(201).json({ sent: prepared.items });
  })
);

const reactionSchema = z.object({ emoji: z.string().max(8).nullable() });
messagesRouter.post(
  "/:messageId/reaction",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const { emoji } = reactionSchema.parse(req.body);
    const message = await service.getMessageWithConversation(req.params.messageId);
    const conversation = await loadConversationForAgent(message.conversationId, req.auth!.userId);
    const updated = await service.toggleReaction(req.params.messageId, req.auth!.userId, emoji);
    // Reactions only sync to the remote provider for WhatsApp today — the
    // local toggle above still applies either way, it just won't be
    // mirrored back to Instagram/Messenger yet (see assertWhatsAppChannel's
    // doc comment).
    if (message.providerMessageId && conversation.channel === "WHATSAPP") {
      // A reaction to something WE sent has to say so — WhatsApp finds the target by its key.
      await whatsappService
        .sendReaction(conversation.whatsappConnectionId!, conversation.contact.phone!, message.providerMessageId, emoji, message.direction === "OUTBOUND")
        .catch((err) => logger.warn({ err, messageId: message.id }, "failed to send a reaction to WhatsApp"));
    }
    realtimeEvents.messageStatusChanged(conversation.id, conversation.assignedAgentId);
    res.json(toMessageDTO(updated));
  })
);

messagesRouter.delete(
  "/:messageId",
  // ADMIN-only, same restriction level as conversations.routes.ts's
  // /:id/merge — this permanently hides the message from this app's own
  // conversation view. It never touches Baileys/WhatsApp: the customer's
  // WhatsApp app and any other linked device keep the message untouched,
  // per PROMPT: "de forma que nao afete no que esta no APP".
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const message = await service.getMessageWithConversation(req.params.messageId);
    await service.deleteMessage(req.params.messageId, req.auth!.userId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "MESSAGE_DELETED",
      entity: "Message",
      entityId: req.params.messageId,
      ipAddress: req.ip ?? null,
      metadata: {
        conversationId: message.conversationId,
        contactName: message.conversation.contact.name,
        contactPhone: message.conversation.contact.phone,
        text: message.body,
      },
    });
    realtimeEvents.messageDeleted(message.conversationId, req.params.messageId, message.conversation.assignedAgentId);
    res.status(204).end();
  })
);
