import { normalizeContactName } from "@whatsatendende/types";
import { sendOutOfHoursNotice } from "../../lib/auto-messages";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fillSendTags } from "../../lib/customer-tags";
import type { Channel } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import * as conversationsService from "../conversations/conversations.service";
import * as messagesService from "../messages/messages.service";
import { toMessageDTO } from "../messages/messages.mapper";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { getMetaSettings } from "../settings/settings.service";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

/**
 * Meta-channel equivalent of conversationsService.findOrCreateContact —
 * deliberately much simpler: Instagram/Messenger hand out a single stable
 * scoped user id (IGSID/PSID) per contact, so there's no WhatsApp-style
 * @lid-resolution/merge logic to reproduce here at all.
 */
export async function findOrCreateMetaContact(metaConnectionId: string, channel: Channel, externalUserId: string, name: string | null) {
  const existing = await prisma.contact.findUnique({
    where: { externalUserId_metaConnectionId: { externalUserId, metaConnectionId } },
  });
  if (existing) {
    if (name && !existing.name) return prisma.contact.update({ where: { id: existing.id }, data: { name, lastInteractionAt: new Date() } });
    return prisma.contact.update({ where: { id: existing.id }, data: { lastInteractionAt: new Date() } });
  }
  return prisma.contact.create({ data: { channel, metaConnectionId, externalUserId, name: normalizeContactName(name) } });
}

interface MetaMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: { mid: string; text?: string; is_echo?: boolean };
}

interface MetaWebhookEntry {
  id: string; // Facebook Page id (both Messenger and Instagram webhooks key by the Page)
  messaging?: MetaMessagingEvent[];
}

/** Verifies Meta's `X-Hub-Signature-256` header (an HMAC-SHA256 over the exact raw request bytes) against the App Secret. */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  // Different-length buffers would throw inside timingSafeEqual instead of
  // just comparing unequal — an invalid signature is exactly that case
  // (hex of a wrong length), not a genuine server error.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Entry point for POST /webhook — mirrors whatsapp.service.ts's
 * provider.onMessage handler as closely as the two channels' shapes allow:
 * same Contact -> Conversation -> Message -> realtime/notification pipeline,
 * reusing findOrOpenConversationForInboundMessage/createInboundMessage
 * verbatim (both already channel-agnostic). Text-only for this first pass —
 * image/file attachments aren't wired up yet (Graph API delivers media as a
 * CDN URL that would need to be downloaded and re-hosted, same idea as
 * whatsapp.service.ts's downloadContactPhoto, just not built here yet).
 */
export async function processWebhookPayload(object: string, entries: MetaWebhookEntry[]): Promise<void> {
  const channel: Channel = object === "instagram" ? "INSTAGRAM" : "MESSENGER";
  for (const entry of entries) {
    for (const event of entry.messaging ?? []) {
      // is_echo = this event is Meta echoing back a message OUR page sent
      // (via the Send API or another admin tool) — not a genuine inbound
      // customer message, so it's skipped rather than creating a duplicate.
      if (!event.message || event.message.is_echo) continue;
      try {
        await handleInboundEvent(channel, entry.id, event);
      } catch (err) {
        logger.error({ err, channel, pageId: entry.id }, "failed to process inbound meta message");
      }
    }
  }
}

async function handleInboundEvent(channel: Channel, pageId: string, event: MetaMessagingEvent): Promise<void> {
  const connection = await prisma.metaConnection.findFirst({ where: { channel, externalPageId: pageId } });
  if (!connection) {
    logger.warn({ channel, pageId }, "received a Meta webhook event for a page with no matching MetaConnection — ignoring");
    return;
  }
  const providerMessageId = event.message!.mid;
  // Meta redelivers webhook events that weren't acknowledged fast enough —
  // this is the same dedup key WhatsApp messages already rely on
  // (Message.providerMessageId is globally unique).
  if (await prisma.message.findUnique({ where: { providerMessageId } })) return;

  const body = event.message!.text ?? null;
  const contact = await findOrCreateMetaContact(connection.id, channel, event.sender.id, null);
  const { conversation, isNewConversation, autoAssignedAgentId, closedMessage } = await conversationsService.findOrOpenConversationForInboundMessage(
    connection.id,
    contact.id,
    body,
    channel
  );

  await messagesService.createInboundMessage({
    conversationId: conversation.id,
    providerMessageId,
    type: "TEXT",
    body,
  });

  // The connection is outside its Horário de expediente: the notice goes out once, with the conversation that just opened.
  if (closedMessage) await sendOutOfHoursNotice({ id: conversation.id, contactId: contact.id }, fillSendTags(closedMessage, contact.name ?? "Contato", contact.firstName));

  const contactLabel = contact.name ?? "Contato";
  if (isNewConversation) {
    if (autoAssignedAgentId) {
      realtimeEvents.conversationAccepted(conversation.id, connection.id, autoAssignedAgentId);
    } else {
      realtimeEvents.newQueueConversation(connection.id, conversation.id, contactLabel);
    }
    return;
  }
  if (autoAssignedAgentId) realtimeEvents.conversationAccepted(conversation.id, connection.id, autoAssignedAgentId);
  realtimeEvents.newMessage(conversation.id, conversation.assignedAgentId);
  if (conversation.assignedAgentId) {
    const preview = body ?? "Anexo recebido";
    realtimeEvents.inboundMessageNotification(conversation.id, conversation.assignedAgentId, contactLabel, preview);
    const notification = await createNotification({
      userId: conversation.assignedAgentId,
      type: "MESSAGE",
      title: contactLabel,
      body: preview,
      entityType: "Conversation",
      entityId: conversation.id,
    });
    realtimeEvents.notificationCreated(conversation.assignedAgentId, toNotificationDTO(notification));
  }
}

// Bounds how long a slow/stalled Graph API response can hold up the
// request-response cycle of the /text route calling this — same reasoning
// as whatsapp.service.ts's sendWithTimeoutGuard (OUTBOUND_SEND_TIMEOUT_MS),
// just via AbortController since this is a plain fetch, not a persistent
// provider connection with its own promise to race.
const META_SEND_TIMEOUT_MS = 15_000;

/** Outbound send via the Meta Send API — the Messenger/Instagram equivalent of whatsapp.service.ts's sendOutboundText. */
export async function sendMetaMessage(channel: Channel, messageId: string, recipientExternalUserId: string, text: string) {
  try {
    const settings = await getMetaSettings();
    const accessToken = channel === "INSTAGRAM" ? settings.igAccessToken : settings.pageAccessToken;
    if (!accessToken) throw new Error(`Nenhum token de acesso configurado para ${channel} em Conexões`);

    const response = await fetch(`${GRAPH_API_BASE}/me/messages?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientExternalUserId }, message: { text } }),
      signal: AbortSignal.timeout(META_SEND_TIMEOUT_MS),
    });
    const json = (await response.json()) as { message_id?: string; error?: { message: string } };
    if (!response.ok || !json.message_id) {
      throw new Error(json.error?.message ?? `Meta Graph API respondeu ${response.status}`);
    }
    const message = await messagesService.markMessageSent(messageId, json.message_id);
    return toMessageDTO(message);
  } catch (err) {
    logger.error({ err, messageId, channel }, "failed to send outbound meta message");
    const message = await messagesService.markMessageFailed(messageId);
    return toMessageDTO(message);
  }
}
