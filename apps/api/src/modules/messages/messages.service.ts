import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import type { MessageType } from "@prisma/client";

const messageInclude = {
  senderAgent: true,
  attachments: true,
  reactions: { include: { user: true } },
};

export interface ListMessagesParams {
  contactId: string;
  cursor?: string;
  limit: number;
}

/**
 * Scoped by contact, not by the single conversation being opened: closing a
 * conversation and having the contact message back deliberately starts a
 * brand-new Conversation row (its own queue card, its own metrics — see
 * conversations.service.ts's findActiveConversationForContact), but on
 * WhatsApp itself there is only ever one continuous thread with that
 * contact. Splitting the *display* history along those same conversation
 * boundaries used to make a returning customer's prior (closed) messages
 * disappear the moment a new record was created — see PROMPT: "quando
 * encerro uma conversa e o cliente entra em contato em seguida, não está
 * trazendo o histórico anterior do mesmo cliente."
 *
 * Cursor-based pagination (id, via createdAt-desc ordering) so a contact
 * with a long relationship loads incrementally, never all at once.
 */
export async function listMessages({ contactId, cursor, limit }: ListMessagesParams) {
  const messages = await prisma.message.findMany({
    where: { conversation: { contactId }, deletedAt: null },
    include: messageInclude,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;
  return {
    items: page.reverse(), // chronological order for rendering
    nextCursor: hasMore ? page[0].id : null,
  };
}

export interface CreateOutboundMessageInput {
  conversationId: string;
  agentId: string;
  type: MessageType;
  body?: string | null;
  replyToMessageId?: string | null;
}

export async function createOutboundMessage(input: CreateOutboundMessageInput) {
  const conversation = await prisma.conversation.findUnique({ where: { id: input.conversationId } });
  if (!conversation) throw Errors.notFound("Conversa nao encontrada");
  if (conversation.assignedAgentId !== input.agentId) throw Errors.forbidden("Esta conversa pertence a outro atendente");
  if (!["IN_PROGRESS", "TRANSFERRED"].includes(conversation.status)) {
    throw Errors.badRequest("Conversa nao esta em atendimento");
  }

  const message = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      direction: "OUTBOUND",
      type: input.type,
      status: "PENDING",
      body: input.body ?? null,
      senderAgentId: input.agentId,
      replyToMessageId: input.replyToMessageId ?? null,
    },
    include: messageInclude,
  });

  const updates: Record<string, unknown> = { lastMessageAt: new Date(), lastMessageDirection: "OUTBOUND" };
  if (!conversation.firstResponseAt) updates.firstResponseAt = new Date();
  await prisma.conversation.update({ where: { id: input.conversationId }, data: updates });

  return message;
}

export interface QuotedStoryInput {
  isQuotedStoryReply?: boolean;
  quotedStoryText?: string | null;
  quotedStoryThumbnailBase64?: string | null;
}

export interface LinkPreviewInput {
  linkPreviewTitle?: string | null;
  linkPreviewDescription?: string | null;
  linkPreviewUrl?: string | null;
  linkPreviewThumbnailBase64?: string | null;
}

/** Shared by every message-creation path that can carry a story-reply marker and/or a link-preview card — keeps the Prisma `data` shape for both in exactly one place. */
function storyAndLinkPreviewData(input: QuotedStoryInput & LinkPreviewInput) {
  return {
    isStoryReply: Boolean(input.isQuotedStoryReply),
    storyReplyText: input.quotedStoryText ?? null,
    storyReplyThumbnail: input.quotedStoryThumbnailBase64 ?? null,
    linkPreviewTitle: input.linkPreviewTitle ?? null,
    linkPreviewDescription: input.linkPreviewDescription ?? null,
    linkPreviewUrl: input.linkPreviewUrl ?? null,
    linkPreviewThumbnail: input.linkPreviewThumbnailBase64 ?? null,
  };
}

export interface CreateOutboundMessageFromDeviceInput extends QuotedStoryInput, LinkPreviewInput {
  conversationId: string;
  providerMessageId: string;
  type: MessageType;
  body: string | null;
  timestamp: Date;
  replyToProviderMessageId?: string | null;
}

/**
 * Records a message sent directly from the linked phone (or any other
 * WhatsApp multi-device session) instead of through this app — see the
 * fromMe handling in BaileysWhatsAppProvider/whatsapp.service.ts. Unlike
 * createOutboundMessage (the agent-initiated send flow), this doesn't
 * require an assigned agent or an in-progress conversation: WhatsApp
 * itself has no such concept, so a reply typed on the phone can land on a
 * conversation that's still sitting unassigned in the queue.
 * providerMessageId and delivery status are already known from the event
 * (not filled in later by an async send call), so this writes the row
 * already SENT rather than PENDING.
 *
 * Returns null (does nothing) when a message with this providerMessageId
 * already exists — that means this app sent it itself via
 * createOutboundMessage, and WhatsApp is just echoing it back through the
 * same live event stream; recording it again would duplicate it.
 */
export async function createOutboundMessageFromDevice(input: CreateOutboundMessageFromDeviceInput) {
  const existing = await prisma.message.findUnique({ where: { providerMessageId: input.providerMessageId } });
  if (existing) return null;

  const replyTo = input.replyToProviderMessageId
    ? await prisma.message.findUnique({ where: { providerMessageId: input.replyToProviderMessageId } })
    : null;

  const message = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      direction: "OUTBOUND",
      type: input.type,
      status: "SENT",
      body: input.body,
      providerMessageId: input.providerMessageId,
      replyToMessageId: replyTo?.id ?? null,
      createdAt: input.timestamp,
      ...storyAndLinkPreviewData(input),
    },
    include: messageInclude,
  });

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { lastMessageAt: input.timestamp, lastMessageDirection: "OUTBOUND" },
  });

  return message;
}

export async function markMessageSent(
  messageId: string,
  providerMessageId: string,
  linkPreview?: { title: string; description?: string | null; url: string; thumbnailBase64?: string | null } | null
) {
  return prisma.message.update({
    where: { id: messageId },
    data: {
      status: "SENT",
      providerMessageId,
      ...(linkPreview
        ? {
            linkPreviewTitle: linkPreview.title,
            linkPreviewDescription: linkPreview.description ?? null,
            linkPreviewUrl: linkPreview.url,
            linkPreviewThumbnail: linkPreview.thumbnailBase64 ?? null,
          }
        : {}),
    },
    include: messageInclude,
  });
}

export async function markMessageFailed(messageId: string) {
  return prisma.message.update({ where: { id: messageId }, data: { status: "FAILED" }, include: messageInclude });
}

export async function updateMessageStatusByProviderId(
  providerMessageId: string,
  status: "SENT" | "DELIVERED" | "READ" | "FAILED"
) {
  const message = await prisma.message.findUnique({ where: { providerMessageId } });
  if (!message) return null;
  return prisma.message.update({
    where: { id: message.id },
    data: {
      status,
      deliveredAt: status === "DELIVERED" || status === "READ" ? new Date() : message.deliveredAt,
      readAt: status === "READ" ? new Date() : message.readAt,
    },
    include: messageInclude,
  });
}

export interface CreateInboundMessageInput extends QuotedStoryInput, LinkPreviewInput {
  conversationId: string;
  providerMessageId: string;
  type: MessageType;
  body: string | null;
  replyToProviderMessageId?: string | null;
}

export async function createInboundMessage(input: CreateInboundMessageInput) {
  const replyTo = input.replyToProviderMessageId
    ? await prisma.message.findUnique({ where: { providerMessageId: input.replyToProviderMessageId } })
    : null;

  const message = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      direction: "INBOUND",
      type: input.type,
      status: "DELIVERED",
      body: input.body,
      providerMessageId: input.providerMessageId,
      replyToMessageId: replyTo?.id ?? null,
      ...storyAndLinkPreviewData(input),
    },
    include: messageInclude,
  });

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { lastMessageAt: new Date(), lastMessageDirection: "INBOUND" },
  });

  return message;
}

export async function addAttachment(
  messageId: string,
  attachment: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    kind: MessageType;
    latitude?: number;
    longitude?: number;
    vcard?: string;
    pollQuestion?: string;
    pollOptions?: string[];
    eventName?: string;
    eventDescription?: string;
    eventStartAt?: Date;
    eventJoinLink?: string;
  }
) {
  return prisma.messageAttachment.create({ data: { messageId, ...attachment } });
}

export async function toggleReaction(messageId: string, userId: string, emoji: string | null) {
  const existing = await prisma.messageReaction.findFirst({ where: { messageId, userId, fromCustomer: false } });

  if (!emoji) {
    if (existing) await prisma.messageReaction.delete({ where: { id: existing.id } });
    return prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
  }

  if (existing) {
    await prisma.messageReaction.update({ where: { id: existing.id }, data: { emoji } });
  } else {
    await prisma.messageReaction.create({ data: { messageId, userId, emoji, fromCustomer: false } });
  }
  return prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
}

export async function getMessageWithConversation(messageId: string) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { contact: true } } },
  });
  if (!message) throw Errors.notFound("Mensagem nao encontrada");
  return message;
}

/**
 * ADMIN-only "excluir mensagem" — soft delete local to this app: the row
 * (and its attachments) is kept for audit purposes but excluded from
 * listMessages from this point on. Deliberately never calls out to
 * whatsapp.service/Baileys — there is no message-revoke request here, so
 * the customer's own WhatsApp app and any other linked device are
 * completely unaffected.
 */
export async function deleteMessage(messageId: string, deletedByUserId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw Errors.notFound("Mensagem nao encontrada");
  if (message.deletedAt) return message; // already deleted — idempotent no-op
  return prisma.message.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), deletedByUserId },
  });
}

export { messageInclude };
