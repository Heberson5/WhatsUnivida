import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createWhatsAppProvider, type InboundMessageEvent, type WhatsAppProvider, type WhatsAppStatusSnapshot } from "@whatsunivida/whatsapp";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { Errors } from "../../lib/http-error";
import type { Role } from "@prisma/client";
import type { ManagerConnectionAccessDTO } from "@whatsunivida/types";
import { realtimeEvents } from "../../realtime/realtime";
import * as conversationsService from "../conversations/conversations.service";
import * as messagesService from "../messages/messages.service";
import { toMessageDTO } from "../messages/messages.mapper";
import { getManagerConnectionIds } from "../../lib/connection-access";

fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });

const MEDIA_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/webm": ".webm",
  "audio/aac": ".aac",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
};

function extensionFor(mimeType: string, fileName?: string): string {
  if (fileName && path.extname(fileName)) return path.extname(fileName);
  return MEDIA_EXT_BY_MIME[mimeType] ?? "";
}

const CONTACT_PHOTO_DIR = path.join(env.UPLOAD_DIR, "contacts");
fs.mkdirSync(CONTACT_PHOTO_DIR, { recursive: true });

/**
 * A contact's photoUrl is only ever worth storing as OUR OWN copy, never as
 * the raw WhatsApp CDN link getContactPhoto() returns — those URLs are
 * signed/short-lived and start returning 403/404 once they expire or the
 * WhatsApp session that fetched them is replaced (e.g. a disconnect +
 * reconnect), silently breaking every already-stored photo at once with no
 * retry, since it's normally only ever fetched the one time. See PROMPT:
 * "não está mais trazendo as fotos de perfil dos clientes". Downloads the
 * image server-side and re-serves it from /uploads/contacts (same pattern
 * as profile/branding photos), so once stored it never expires again.
 * Best-effort: returns null on any failure, same contract as
 * provider.getContactPhoto itself.
 */
async function downloadContactPhoto(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const ext = MEDIA_EXT_BY_MIME[contentType] ?? ".jpg";
    const storageKey = `${randomUUID()}${ext}`;
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(CONTACT_PHOTO_DIR, storageKey), buffer);
    return `/uploads/contacts/${storageKey}`;
  } catch {
    return null;
  }
}

/**
 * True once a contact's photoUrl already points at our own re-served copy
 * — the only case genuinely safe to skip re-fetching. A raw WhatsApp CDN
 * link (or no link at all) is always worth retrying, since the CDN link is
 * either not-yet-migrated or has since expired (see downloadContactPhoto).
 */
function hasStoredContactPhoto(photoUrl: string | null): boolean {
  return !!photoUrl && photoUrl.startsWith("/uploads/contacts/");
}

// One WhatsAppProvider instance per named connection (see PROMPT: "poderá
// conectar vários WhatsApp"). Each instance owns its own session/QR/status
// independently — nothing here assumes there's only one.
const providers = new Map<string, WhatsAppProvider>();

function getProvider(connectionId: string): WhatsAppProvider {
  const provider = providers.get(connectionId);
  if (!provider) throw Errors.notFound("Conexao de WhatsApp nao encontrada ou nao inicializada");
  return provider;
}

/** Test-only escape hatch to reach the live provider instance (e.g. to inspect MockWhatsAppProvider.sentTexts) — never used by application code. */
export function __getProviderForTests(connectionId: string): WhatsAppProvider | undefined {
  return providers.get(connectionId);
}

/**
 * Sends WhatsApp read receipts for a conversation's still-unread inbound
 * messages — called right when an agent opens it in the app (see
 * conversations.routes.ts's "/:id/read"), so the linked phone's own unread
 * indicator clears too, not just this app's badge. Best-effort: the
 * conversation might not be for a real/currently-connected WhatsApp
 * connection (mock provider, connection mid-reconnect, etc.) — never blocks
 * or fails the actual "mark read" action over this.
 */
export async function syncReadReceiptToDevice(conversationId: string): Promise<void> {
  try {
    const providerMessageIds = await conversationsService.getUnreadInboundProviderMessageIds(conversationId);
    if (providerMessageIds.length === 0) return;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conversation) return;
    const provider = providers.get(conversation.contact.whatsappConnectionId);
    if (!provider) return;
    await provider.markRead(toChatId(conversation.contact.phone), providerMessageIds);
  } catch (err) {
    logger.error({ err, conversationId }, "failed to sync a WhatsApp read receipt to the linked phone");
  }
}

/**
 * Called once from server.ts's SIGTERM/SIGINT handler, before the process
 * exits (every deploy sends one of these to the outgoing container). Ends
 * every live WhatsApp connection's WebSocket cleanly instead of letting the
 * process die out from under it — see WhatsAppProvider.endForShutdown for
 * why an abrupt kill was corrupting WhatsApp's own multi-device sync to the
 * linked phone on every redeploy.
 */
export async function shutdownAllConnections(): Promise<void> {
  await Promise.all(
    Array.from(providers.values()).map((provider) =>
      provider.endForShutdown().catch((err) => logger.error({ err }, "failed to gracefully end a WhatsApp connection during shutdown"))
    )
  );
}

function toChatId(phone: string): string {
  return phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
}

// Multiple agents share the same connected WhatsApp number, so without this
// the customer has no way to tell who they're talking to from one message
// to the next — WhatsApp's own bold markdown (*text*) renders on the phone.
// Only ever applied to the text actually sent over the wire; the stored
// Message.body keeps exactly what the agent typed.
export function withSenderPrefix(senderDisplayName: string, text: string): string {
  return `*${senderDisplayName}:*\n\n${text}`;
}

/**
 * Boots a provider instance for every existing connection row. Called once
 * at startup — see server.ts.
 *
 * A row whose last persisted status was CONNECTED is auto-reconnected here
 * using its already-linked Baileys session (no new QR/pairing-code needed —
 * WhatsApp accepts the existing credentials same as any other reconnect).
 * Without this, every API restart (every deploy) silently left every
 * previously-connected WhatsApp session sitting idle — the process only
 * ever *creates* the provider object, it never called .connect() on its
 * own — so sending/receiving stayed dead until an admin happened to notice
 * and click "Reconectar" in Configurações.
 */
export async function initWhatsAppConnections(): Promise<void> {
  const rows = await prisma.whatsAppConnection.findMany();
  for (const row of rows) {
    const provider = bootstrapConnection(row.id, row);
    // Conexoes de demonstracao sempre sobem conectadas (simulador, sem rede).
    if (row.status === "CONNECTED" || row.isDemo) {
      provider.connect().catch((err) => logger.error({ err, connectionId: row.id }, "failed to auto-reconnect WhatsApp connection on startup"));
    }
  }
}

function bootstrapConnection(connectionId: string, row?: { isDemo: boolean; linkedNumber: string | null; connectedNumber: string | null }): WhatsAppProvider {
  const isDemo = row?.isDemo ?? false;
  const provider = createWhatsAppProvider({
    provider: isDemo ? "mock" : env.WHATSAPP_PROVIDER,
    authStateDir: path.join(env.WHATSAPP_AUTH_DIR, connectionId),
    mock: isDemo
      ? { connectedNumber: row?.linkedNumber ?? row?.connectedNumber ?? undefined, simulateInboundTraffic: false, fastConnect: true }
      : undefined,
  });
  providers.set(connectionId, provider);
  wireProviderEvents(connectionId, provider);
  return provider;
}

function wireProviderEvents(connectionId: string, provider: WhatsAppProvider) {
  provider.onConnectionUpdate(async (status) => {
    try {
      let linkedNumberToSet: string | undefined;
      if (status.state === "CONNECTED" && status.connectedNumber) {
        const existing = await prisma.whatsAppConnection.findUnique({
          where: { id: connectionId },
          select: { linkedNumber: true },
        });
        if (!existing) return; // deleted mid-flight — same as the P2025 guard below
        if (existing.linkedNumber && existing.linkedNumber !== status.connectedNumber) {
          // This connection's history (contacts/conversations/messages)
          // belongs to a specific real-world number — see PROMPT:
          // "reconectar somente no mesmo número que já estava antes".
          // Pairing a different one here would silently start mixing a
          // second person's WhatsApp account into it, so the pairing is
          // undone immediately instead of ever reaching CONNECTED.
          logger.error(
            { connectionId, expected: existing.linkedNumber, got: status.connectedNumber },
            "rejected a WhatsApp pairing: the linked number does not match this connection's original number"
          );
          provider.disconnect().catch(() => undefined);
          realtimeEvents.whatsappPairingRejected(connectionId, status.connectedNumber, "MISMATCH", { expectedNumber: existing.linkedNumber });
          return;
        }
        if (!existing.linkedNumber) {
          // The complementary check to the one above: that one stops THIS
          // connection from ever drifting onto a different number than its
          // own history. This one stops the SAME real phone from ever being
          // linked into a *second*, different connection row in the first
          // place — e.g. an admin scanning the wrong QR code with a phone
          // that's already the linked number of "Vendas" while setting up
          // "Suporte". Two Baileys sessions authenticated as the very same
          // WhatsApp identity fight over which one WhatsApp's own servers
          // treat as the live device, corrupting message delivery on
          // whichever one loses that fight — every account only ever gets
          // to be genuinely CONNECTED in exactly one connection row.
          const duplicate = await prisma.whatsAppConnection.findFirst({
            where: { linkedNumber: status.connectedNumber, id: { not: connectionId } },
            select: { name: true },
          });
          if (duplicate) {
            logger.error(
              { connectionId, number: status.connectedNumber, otherConnection: duplicate.name },
              "rejected a WhatsApp pairing: this number is already linked to a different connection"
            );
            provider.disconnect().catch(() => undefined);
            realtimeEvents.whatsappPairingRejected(connectionId, status.connectedNumber, "ALREADY_LINKED", { otherConnectionName: duplicate.name });
            return;
          }
          linkedNumberToSet = status.connectedNumber;
        }
      }
      await persistConnectionStatus(connectionId, status, linkedNumberToSet);
    } catch (err) {
      // The connection row can vanish out from under an in-flight
      // connect/reconnect (deleted by an admin, or — only ever in
      // tests — a database reset); a stale async status update landing
      // afterwards is not an error worth crashing over.
      if ((err as { code?: string }).code !== "P2025") throw err;
      logger.warn({ connectionId }, "dropped a status update for a WhatsApp connection that no longer exists");
      return;
    }
    realtimeEvents.whatsappStatusChanged(connectionId, status);
  });

  provider.onMessage(async (event) => {
    try {
      if (event.fromMe) {
        await handleDeviceSentMessage(event);
        return;
      }

      const contact = await conversationsService.findOrCreateContact(connectionId, event.phone, event.contactName, event.chatId);
      if (!hasStoredContactPhoto(contact.photoUrl)) {
        // Fire-and-forget: a WhatsApp profile-picture lookup must never
        // delay showing the message itself. Best-effort — getContactPhoto
        // and downloadContactPhoto both already swallow their own errors
        // and resolve null.
        provider
          .getContactPhoto(event.chatId)
          .then((externalUrl) => (externalUrl ? downloadContactPhoto(externalUrl) : null))
          .then((photoUrl) => (photoUrl ? conversationsService.updateContactPhoto(contact.id, photoUrl) : undefined))
          .catch(() => undefined);
      }
      const { conversation, isNewConversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
        connectionId,
        contact.id,
        event.body
      );

      const message = await messagesService.createInboundMessage({
        conversationId: conversation.id,
        providerMessageId: event.providerMessageId,
        type: event.type,
        body: event.body,
        replyToProviderMessageId: event.replyToProviderMessageId,
        isQuotedStoryReply: event.isQuotedStoryReply,
        quotedStoryText: event.quotedStoryText,
        quotedStoryThumbnailBase64: event.quotedStoryThumbnailBase64,
        linkPreviewTitle: event.linkPreviewTitle,
        linkPreviewDescription: event.linkPreviewDescription,
        linkPreviewUrl: event.linkPreviewUrl,
        linkPreviewThumbnailBase64: event.linkPreviewThumbnailBase64,
      });

      await addAttachmentsFromEvent(message.id, event);

      const contactLabel = contact.name ?? contact.phone;
      if (isNewConversation) {
        if (autoAssignedAgentId) {
          // "@<nome do atendente>" in the customer's first message — skips
          // the queue entirely, straight into that agent's own list, same
          // realtime path an accepted conversation uses.
          realtimeEvents.conversationAccepted(conversation.id, connectionId, autoAssignedAgentId);
        } else {
          realtimeEvents.newQueueConversation(connectionId, conversation.id, contactLabel);
        }
      } else {
        realtimeEvents.newMessage(conversation.id, conversation.assignedAgentId);
        if (conversation.assignedAgentId) {
          const preview = event.body ?? (event.type === "LOCATION" ? "Localizacao" : event.type === "CONTACT" ? "Contato" : "Anexo recebido");
          realtimeEvents.inboundMessageNotification(conversation.id, conversation.assignedAgentId, contactLabel, preview);
        }
      }
    } catch (err) {
      logger.error({ err, connectionId }, "failed to process inbound whatsapp message");
    }
  });

  /**
   * A message sent directly from the linked phone (or any other linked
   * device) instead of through this app. Reuses the same contact/
   * conversation lookup as an inbound customer message — WhatsApp itself
   * doesn't distinguish where a conversation's next message comes from —
   * but records it as OUTBOUND with no agent attached, and skips it
   * entirely when it turns out to be an echo of a message this app just
   * sent itself (see createOutboundMessageFromDevice).
   */
  async function handleDeviceSentMessage(event: InboundMessageEvent) {
    // contactName is never trusted here (see BaileysWhatsAppProvider) and
    // a fromMe message should never seed a brand-new contact's photo from
    // this account's own profile picture, so no getContactPhoto call here.
    const contact = await conversationsService.findOrCreateContact(connectionId, event.phone, null, event.chatId);
    const { conversation, leftQueue } = await conversationsService.findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);

    const message = await messagesService.createOutboundMessageFromDevice({
      conversationId: conversation.id,
      providerMessageId: event.providerMessageId,
      type: event.type,
      body: event.body,
      timestamp: event.timestamp,
      replyToProviderMessageId: event.replyToProviderMessageId,
      isQuotedStoryReply: event.isQuotedStoryReply,
      quotedStoryText: event.quotedStoryText,
      quotedStoryThumbnailBase64: event.quotedStoryThumbnailBase64,
      linkPreviewTitle: event.linkPreviewTitle,
      linkPreviewDescription: event.linkPreviewDescription,
      linkPreviewUrl: event.linkPreviewUrl,
      linkPreviewThumbnailBase64: event.linkPreviewThumbnailBase64,
    });
    if (!message) return; // already recorded via this app's own send flow

    await addAttachmentsFromEvent(message.id, event);
    realtimeEvents.newMessage(conversation.id, conversation.assignedAgentId);
    // A reply from the phone just moved a previously-queued conversation to
    // HANDLED_EXTERNALLY — without this, every agent's live Fila kept
    // showing the card until their next poll/refresh (same broadcast
    // onChatRead below fires for the "read from device" case).
    if (leftQueue) realtimeEvents.conversationHandledExternally(connectionId);
  }

  async function addAttachmentsFromEvent(messageId: string, event: InboundMessageEvent) {
    if (event.mediaBuffer) {
      const mimeType = event.mediaMimeType ?? "application/octet-stream";
      const ext = extensionFor(mimeType, event.mediaFileName);
      const storageKey = `${randomUUID()}${ext}`;
      fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), event.mediaBuffer);
      await messagesService.addAttachment(messageId, {
        fileName: event.mediaFileName ?? `arquivo${ext}`,
        mimeType,
        sizeBytes: event.mediaBuffer.length,
        storageKey,
        kind: event.type,
      });
    }
    if (event.type === "LOCATION" && event.latitude != null && event.longitude != null) {
      await messagesService.addAttachment(messageId, {
        fileName: "location",
        mimeType: "application/geo+json",
        sizeBytes: 0,
        storageKey: "",
        kind: "LOCATION",
        latitude: event.latitude,
        longitude: event.longitude,
      });
    }
    if (event.vcard) {
      await messagesService.addAttachment(messageId, {
        fileName: "contact.vcf",
        mimeType: "text/vcard",
        sizeBytes: event.vcard.length,
        storageKey: "",
        kind: "CONTACT",
        vcard: event.vcard,
      });
    }
    if (event.type === "POLL") {
      await messagesService.addAttachment(messageId, {
        fileName: "poll",
        mimeType: "application/vnd.whatsapp.poll",
        sizeBytes: 0,
        storageKey: "",
        kind: "POLL",
        pollQuestion: event.pollQuestion ?? "",
        pollOptions: event.pollOptions ?? [],
      });
    }
    if (event.type === "EVENT") {
      await messagesService.addAttachment(messageId, {
        fileName: "event",
        mimeType: "application/vnd.whatsapp.event",
        sizeBytes: 0,
        storageKey: "",
        kind: "EVENT",
        eventName: event.eventName ?? "",
        eventDescription: event.eventDescription,
        eventStartAt: event.eventStartAt,
        eventJoinLink: event.eventJoinLink,
        latitude: event.latitude,
        longitude: event.longitude,
      });
    }
  }

  provider.onDelivery(async (event) => {
    const message = await messagesService.updateMessageStatusByProviderId(event.providerMessageId, event.status);
    if (!message) return;
    const conversation = await prisma.conversation.findUnique({
      where: { id: message.conversationId },
      select: { assignedAgentId: true },
    });
    realtimeEvents.messageStatusChanged(message.conversationId, conversation?.assignedAgentId);
  });

  provider.onHistorySync(async (event) => {
    try {
      for (const c of event.contacts) {
        if (!c.photoUrl) continue;
        // Best-effort: only touches contacts we already know about (created
        // by a live message or by this same import) — never creates a
        // Contact row just to hold a photo with no conversation behind it.
        // Re-serves our own downloaded copy rather than the raw (expiring)
        // WhatsApp CDN link — see downloadContactPhoto.
        const photoUrl = await downloadContactPhoto(c.photoUrl).catch(() => null);
        if (!photoUrl) continue;
        await prisma.contact
          .updateMany({ where: { whatsappConnectionId: connectionId, phone: c.phone, photoUrl: null }, data: { photoUrl } })
          .catch(() => undefined);
      }
      if (event.messages.length > 0) {
        await conversationsService.importHistoricalMessages(connectionId, event.messages);
        logger.info({ connectionId, count: event.messages.length }, "imported a WhatsApp history sync batch");
      }
    } catch (err) {
      logger.error({ err, connectionId }, "failed to import WhatsApp history sync batch");
    }
  });

  provider.onChatRead(async (event) => {
    try {
      // Non-customer chats (groups, status, broadcast lists) are already
      // filtered out by the provider before this event is emitted.
      //
      // Resolve by chatId (providerChatId) first, same order findOrCreateContact
      // uses — event.phone is only ever a best-effort guess (see phoneFromJid):
      // on an @lid chat whose pnJid isn't attached to THIS particular event, it
      // falls back to the meaningless @lid digits, which never match the
      // contact's real stored phone. Looking up by phone alone silently missed
      // the contact on exactly those events, which is why a chat read on the
      // linked phone would sometimes never leave the queue.
      const contact =
        (await prisma.contact.findFirst({ where: { whatsappConnectionId: connectionId, providerChatId: event.chatId } })) ??
        (await prisma.contact.findUnique({
          where: { phone_whatsappConnectionId: { phone: event.phone, whatsappConnectionId: connectionId } },
        }));
      if (!contact) {
        // Silent by design until now — but a contact that never resolves
        // here is exactly why a device-side read sometimes never clears
        // the badge/leaves the queue. Logged (not just swallowed) so a
        // real occurrence is visible in production instead of looking
        // like the whole feature silently does nothing.
        logger.warn({ connectionId, chatId: event.chatId, phone: event.phone }, "chat-read event from linked phone: no matching contact found");
        return;
      }
      const conversation = await conversationsService.findActiveConversationForContact(contact.id);
      if (!conversation) {
        // Not a bug on its own — the contact's last conversation may
        // already be CLOSED/HANDLED_EXTERNALLY — but logged at the same
        // level as the contact-miss above so both silent-drop paths are
        // equally visible when diagnosing a report that this isn't working.
        logger.warn({ connectionId, contactId: contact.id }, "chat-read event from linked phone: no active conversation for this contact");
        return;
      }
      const { leftQueue } = await conversationsService.markConversationReadFromDevice(conversation.id);
      if (leftQueue) {
        realtimeEvents.conversationHandledExternally(connectionId);
      } else {
        realtimeEvents.conversationReadFromDevice(conversation.id, conversation.assignedAgentId);
      }
    } catch (err) {
      logger.error({ err, connectionId }, "failed to sync a chat-read event from the linked phone");
    }
  });

  // The only source that can ever correct a contact created from a message
  // with no phone-resolvable field at all to begin with — a message sent
  // directly from the linked phone in a brand-new 1:1 chat, whose remoteJid
  // comes back as the opaque @lid id with no senderPn/participantPn
  // attached (those are only ever populated for group chats). See
  // ChatIdentityResolvedEvent and findOrCreateContact's self-heal.
  provider.onChatIdentityResolved(async (event) => {
    try {
      await conversationsService.findOrCreateContact(connectionId, event.phone, null, event.chatId);
    } catch (err) {
      logger.error({ err, connectionId }, "failed to heal a contact's phone number from a resolved chat identity");
    }
  });

  provider.onReaction(async (event) => {
    const message = await prisma.message.findUnique({
      where: { providerMessageId: event.providerMessageId },
      include: { conversation: { select: { assignedAgentId: true } } },
    });
    if (!message) return;
    // Customer reactions have userId=NULL, so a compound-unique upsert
    // can't target them reliably (NULLs never compare equal in Postgres) —
    // replace-by-delete instead.
    await prisma.messageReaction.deleteMany({ where: { messageId: message.id, fromCustomer: true } });
    if (event.emoji) {
      await prisma.messageReaction.create({ data: { messageId: message.id, emoji: event.emoji, fromCustomer: true } });
    }
    realtimeEvents.messageStatusChanged(message.conversationId, message.conversation.assignedAgentId);
  });
}

async function persistConnectionStatus(connectionId: string, status: WhatsAppStatusSnapshot, linkedNumber?: string) {
  await prisma.whatsAppConnection.update({
    where: { id: connectionId },
    data: {
      status: status.state,
      connectedNumber: status.connectedNumber,
      lastConnectedAt: status.lastConnectedAt,
      lastQrAt: status.qrCodeDataUrl || status.pairingCode ? new Date() : undefined,
      ...(linkedNumber ? { linkedNumber } : {}),
    },
  });
}

export interface ConnectionSummaryDTO {
  id: string;
  name: string;
  color: string;
  state: string;
  qrCodeDataUrl: string | null;
  pairingCode: string | null;
  connectedNumber: string | null;
  // The number this connection was first ever linked to — see PROMPT:
  // "reconectar somente no mesmo número que já estava antes". Null only for
  // a connection that has never completed a pairing yet, in which case any
  // number is accepted (there's nothing to conflict with).
  linkedNumber: string | null;
  lastConnectedAt: string | null;
  agentCount: number;
  createdByUserId: string | null;
  createdByUserName: string | null;
}

// Distinct, readable-on-white swatches auto-assigned to new connections in
// rotation so the admin doesn't have to pick a color for every one — still
// changeable afterwards via PATCH /connections/:id.
const COLOR_PALETTE = ["#0097B4", "#7C3AED", "#F97316", "#059669", "#DC2626", "#2563EB", "#DB2777", "#65A30D"];

const connectionSummaryInclude = { _count: { select: { agents: true } }, createdByUser: { select: { id: true, displayName: true } } } as const;

function toConnectionSummary(row: {
  id: string;
  name: string;
  color: string;
  status: string;
  connectedNumber: string | null;
  linkedNumber: string | null;
  lastConnectedAt: Date | null;
  _count: { agents: number };
  createdByUser: { id: string; displayName: string } | null;
}): ConnectionSummaryDTO {
  const runtime = providers.get(row.id)?.getStatus();
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    state: runtime?.state ?? row.status,
    qrCodeDataUrl: runtime?.qrCodeDataUrl ?? null,
    pairingCode: runtime?.pairingCode ?? null,
    connectedNumber: runtime?.connectedNumber ?? row.connectedNumber,
    linkedNumber: row.linkedNumber,
    lastConnectedAt: (runtime?.lastConnectedAt ?? row.lastConnectedAt)?.toISOString?.() ?? null,
    agentCount: row._count.agents,
    createdByUserId: row.createdByUser?.id ?? null,
    createdByUserName: row.createdByUser?.displayName ?? null,
  };
}

/**
 * ADMIN sees every connection, unrestricted, same as always. A MANAGER
 * only ever sees connections they created themselves or were explicitly
 * granted "view/edit" access to — see PROMPT: "os gestores... podem ter
 * acesso as conexões, mas somente nas conexões que foram cadastradas
 * pelos gestores" (plus whatever an admin additionally designates).
 */
export async function listConnections(auth: { userId: string; role: Role }): Promise<ConnectionSummaryDTO[]> {
  const allowedIds = auth.role === "MANAGER" ? await getManagerConnectionIds(auth.userId, "manage") : undefined;
  const rows = await prisma.whatsAppConnection.findMany({
    where: allowedIds ? { id: { in: allowedIds } } : undefined,
    orderBy: { name: "asc" },
    include: connectionSummaryInclude,
  });
  return rows.map(toConnectionSummary);
}

export async function getConnectionSummary(connectionId: string): Promise<ConnectionSummaryDTO> {
  const row = await prisma.whatsAppConnection.findUnique({
    where: { id: connectionId },
    include: connectionSummaryInclude,
  });
  if (!row) throw Errors.notFound("Conexao de WhatsApp nao encontrada");
  return toConnectionSummary(row);
}

export async function createConnection(name: string, color: string | undefined, createdByUserId: string): Promise<ConnectionSummaryDTO> {
  const existing = await prisma.whatsAppConnection.findUnique({ where: { name } });
  if (existing) throw Errors.conflict("Ja existe uma conexao com este nome");
  const existingCount = await prisma.whatsAppConnection.count();
  const row = await prisma.whatsAppConnection.create({
    data: { name, color: color ?? COLOR_PALETTE[existingCount % COLOR_PALETTE.length], createdByUserId },
  });
  bootstrapConnection(row.id);
  return getConnectionSummary(row.id);
}

export async function updateConnection(connectionId: string, patch: { name?: string; color?: string }): Promise<ConnectionSummaryDTO> {
  if (patch.name) {
    const clash = await prisma.whatsAppConnection.findUnique({ where: { name: patch.name } });
    if (clash && clash.id !== connectionId) throw Errors.conflict("Ja existe uma conexao com este nome");
  }
  await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { name: patch.name, color: patch.color } });
  return getConnectionSummary(connectionId);
}

export async function deleteConnection(connectionId: string): Promise<void> {
  const agentCount = await prisma.user.count({ where: { whatsappConnectionId: connectionId } });
  if (agentCount > 0) {
    throw Errors.badRequest("Existem atendentes vinculados a esta conexao — reatribua-os antes de excluir");
  }
  // Contacts/conversations/messages keep a foreign key to this connection
  // (ON DELETE RESTRICT — the history must never silently disappear), so a
  // connection that has ever exchanged a message can't actually be deleted.
  // Checked explicitly here so the admin gets a clear message instead of a
  // raw foreign-key-violation 500 from the DELETE below.
  const contactCount = await prisma.contact.count({ where: { whatsappConnectionId: connectionId } });
  if (contactCount > 0) {
    throw Errors.badRequest("Esta conexao tem historico de conversas e não pode ser excluida — o historico é preservado para sempre.");
  }
  const provider = providers.get(connectionId);
  // Only an actually-linked session needs an explicit disconnect first — a
  // stuck/failed pairing attempt (CONNECTING, QR_PENDING, CODE_PENDING) is
  // safe to tear down directly, so a bad pairing attempt (e.g. no outbound
  // network access to WhatsApp's servers) can never permanently block deletion.
  if (provider && provider.getStatus().state === "CONNECTED") {
    throw Errors.badRequest("Desconecte o WhatsApp antes de excluir esta conexao");
  }
  if (provider) {
    await provider.disconnect().catch(() => undefined);
  }
  providers.delete(connectionId);
  await prisma.whatsAppConnection.delete({ where: { id: connectionId } });
}

/**
 * Every connection in the system, annotated with a given MANAGER's access
 * to each — ADMIN-only, used to render the grant editor in Usuários. A
 * connection the manager created themselves always comes back with both
 * flags true and `owned: true` (implicit full access, no row needed —
 * see WhatsAppConnection.createdByUserId); everything else reflects the
 * actual ManagerConnectionAccess row, defaulting to false when none exists.
 */
export async function listConnectionAccessForManager(managerId: string): Promise<ManagerConnectionAccessDTO[]> {
  const [connections, grants] = await Promise.all([
    prisma.whatsAppConnection.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, color: true, createdByUserId: true } }),
    prisma.managerConnectionAccess.findMany({ where: { managerId } }),
  ]);
  const grantByConnectionId = new Map(grants.map((g) => [g.whatsappConnectionId, g]));
  return connections.map((c) => {
    const owned = c.createdByUserId === managerId;
    const grant = grantByConnectionId.get(c.id);
    return {
      whatsappConnectionId: c.id,
      whatsappConnectionName: c.name,
      whatsappConnectionColor: c.color,
      owned,
      canManage: owned || (grant?.canManage ?? false),
      canReceiveConversations: owned || (grant?.canReceiveConversations ?? false),
    };
  });
}

/**
 * Replaces every ManagerConnectionAccess row for one manager with the
 * given set — PUT (full-replace) semantics, same precedent as
 * savePermissionPatch's role-permission matrix. Entries for a connection
 * the manager already owns are silently dropped (that access is implicit
 * and never needs a row), and an all-false entry is dropped too rather
 * than stored as a no-op row.
 */
export async function setConnectionAccessForManager(
  managerId: string,
  entries: { whatsappConnectionId: string; canManage: boolean; canReceiveConversations: boolean }[]
): Promise<void> {
  const owned = await prisma.whatsAppConnection.findMany({ where: { createdByUserId: managerId }, select: { id: true } });
  const ownedIds = new Set(owned.map((c) => c.id));
  const toKeep = entries.filter((e) => !ownedIds.has(e.whatsappConnectionId) && (e.canManage || e.canReceiveConversations));

  await prisma.$transaction([
    prisma.managerConnectionAccess.deleteMany({ where: { managerId } }),
    ...(toKeep.length > 0
      ? [
          prisma.managerConnectionAccess.createMany({
            data: toKeep.map((e) => ({
              managerId,
              whatsappConnectionId: e.whatsappConnectionId,
              canManage: e.canManage,
              canReceiveConversations: e.canReceiveConversations,
            })),
          }),
        ]
      : []),
  ]);
}

export async function connect(connectionId: string, phoneNumber?: string) {
  await getProvider(connectionId).connect(phoneNumber ? { phoneNumber } : undefined);
}

export async function disconnect(connectionId: string) {
  await getProvider(connectionId).disconnect();
}

/** Contacts saved on the linked phone — powers "start a new conversation" in Atendimento. */
export async function listContacts(connectionId: string) {
  return getProvider(connectionId).listContacts();
}

/** Sends a text/reply through the provider and reflects the result on the stored Message row. */
export async function sendOutboundText(
  connectionId: string,
  messageId: string,
  contactPhone: string,
  text: string,
  senderDisplayName: string,
  replyToProviderMessageId?: string,
  replyToText?: string | null
) {
  try {
    const result = await getProvider(connectionId).sendText(toChatId(contactPhone), withSenderPrefix(senderDisplayName, text), {
      replyToProviderMessageId,
      replyToText,
    });
    const message = await messagesService.markMessageSent(messageId, result.providerMessageId, result.linkPreview);
    return toMessageDTO(message);
  } catch (err) {
    logger.error({ err, messageId }, "failed to send outbound whatsapp text");
    const message = await messagesService.markMessageFailed(messageId);
    return toMessageDTO(message);
  }
}

export async function sendOutboundFile(
  connectionId: string,
  messageId: string,
  contactPhone: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  senderDisplayName: string,
  caption?: string
) {
  try {
    const result = await getProvider(connectionId).sendFile(
      toChatId(contactPhone),
      buffer,
      fileName,
      mimeType,
      caption ? withSenderPrefix(senderDisplayName, caption) : undefined
    );
    const message = await messagesService.markMessageSent(messageId, result.providerMessageId);
    return toMessageDTO(message);
  } catch (err) {
    logger.error({ err, messageId }, "failed to send outbound whatsapp file");
    const message = await messagesService.markMessageFailed(messageId);
    return toMessageDTO(message);
  }
}

/** A recorded voice note (WhatsApp's PTT bubble) — distinct from sendOutboundFile, which sends ptt: false for an attached audio file. `buffer` must already be OGG/Opus-encoded by this point; see apps/api/src/lib/audio-transcode.ts. */
export async function sendOutboundAudio(connectionId: string, messageId: string, contactPhone: string, buffer: Buffer, mimeType: string) {
  try {
    const result = await getProvider(connectionId).sendAudio(toChatId(contactPhone), buffer, mimeType);
    const message = await messagesService.markMessageSent(messageId, result.providerMessageId);
    return toMessageDTO(message);
  } catch (err) {
    logger.error({ err, messageId }, "failed to send outbound whatsapp audio");
    const message = await messagesService.markMessageFailed(messageId);
    return toMessageDTO(message);
  }
}

export async function sendOutboundLocation(connectionId: string, messageId: string, contactPhone: string, lat: number, lng: number) {
  try {
    const result = await getProvider(connectionId).sendLocation(toChatId(contactPhone), lat, lng);
    const message = await messagesService.markMessageSent(messageId, result.providerMessageId);
    return toMessageDTO(message);
  } catch (err) {
    logger.error({ err, messageId }, "failed to send outbound whatsapp location");
    const message = await messagesService.markMessageFailed(messageId);
    return toMessageDTO(message);
  }
}

export async function sendReaction(connectionId: string, contactPhone: string, providerMessageId: string, emoji: string | null) {
  await getProvider(connectionId).sendReaction(toChatId(contactPhone), providerMessageId, emoji);
}
