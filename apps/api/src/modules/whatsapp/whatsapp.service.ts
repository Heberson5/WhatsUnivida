import { recordPollVote } from "../messages/poll-votes.service";
import { normalizeContactName } from "@whatsatendende/types";
import path from "node:path";
import { fillSendTags } from "../../lib/customer-tags";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createWhatsAppProvider,
  CloudApiWhatsAppProvider,
  isGroupChat,
  type CloudApiWebhookValue,
  type InboundMessageEvent,
  type OutboundMenu,
  type OutgoingPresence,
  type SendResult,
  type TemplateSendInput,
  type WhatsAppProvider,
  type WhatsAppStatusSnapshot,
} from "@whatsatendende/whatsapp";
import { verifyWebhookSignature } from "../meta/meta.service";
import * as messageTemplatesService from "../message-templates/message-templates.service";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { Errors } from "../../lib/http-error";
import type { Prisma, Role } from "@prisma/client";
import { brazilianPhoneVariants, type ManagerConnectionAccessDTO } from "@whatsatendende/types";
import { realtimeEvents } from "../../realtime/realtime";
import { writeAudit } from "../../lib/audit";
import * as conversationsService from "../conversations/conversations.service";
import * as messagesService from "../messages/messages.service";
import * as satisfaction from "../satisfaction/satisfaction.service";
import * as flowEngine from "../flows/flow-engine.service";
import { assertWorkScheduleExists } from "../work-schedules/work-schedules.service";
import * as groupsService from "../groups/groups.service";
import { announceGroupTyping } from "../groups/groups.service";
import { getBusinessSettings } from "../settings/settings.service";
import { toMessageDTO } from "../messages/messages.mapper";
import { getManagerConnectionIds } from "../../lib/connection-access";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { sendOutOfHoursNotice } from "../../lib/auto-messages";

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

/** An agent opened this conversation: ask WhatsApp to tell us while the customer types (best-effort). */
export async function watchCustomerTyping(conversationId: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { whatsappConnectionId: true, channel: true, contact: { select: { providerChatId: true, phone: true } } },
  });
  if (!conversation?.whatsappConnectionId || conversation.channel !== "WHATSAPP") return;
  const provider = providers.get(conversation.whatsappConnectionId);
  const chatId = conversation.contact.providerChatId ?? (conversation.contact.phone ? toChatId(conversation.contact.phone) : null);
  if (provider && chatId) await provider.subscribeTyping(chatId);
}

/**
 * The attendant is typing or recording in this conversation (or stopped): the customer's WhatsApp shows it, like any
 * chat — unless Configurações › Fila turned that off. Best-effort: a failure never reaches the attendant.
 */
export async function sendAgentPresence(conversationId: string, presence: OutgoingPresence): Promise<void> {
  const settings = await getBusinessSettings();
  if (settings.typingToCustomer === false) return;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { whatsappConnectionId: true, channel: true, contact: { select: { providerChatId: true, phone: true } } },
  });
  if (!conversation?.whatsappConnectionId || conversation.channel !== "WHATSAPP") return;
  const provider = providers.get(conversation.whatsappConnectionId);
  const chatId = conversation.contact.providerChatId ?? (conversation.contact.phone ? toChatId(conversation.contact.phone) : null);
  if (provider && chatId) await provider.sendPresence(chatId, presence);
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
    // Read-receipt sync is a WhatsApp-only concept — no-op for an
    // Instagram/Messenger conversation, same "best-effort" precedent as
    // every other early return in this function.
    if (!conversation || conversation.channel !== "WHATSAPP" || !conversation.contact.whatsappConnectionId) return;
    const provider = providers.get(conversation.contact.whatsappConnectionId);
    if (!provider) return;
    await provider.markRead(await chatIdFor(conversation.contact.whatsappConnectionId, conversation.contact.phone!), providerMessageIds);
  } catch (err) {
    logger.error({ err, conversationId }, "failed to sync a WhatsApp read receipt to the linked phone");
  }
}

/**
 * "Carregar mensagens anteriores" in a group: asks WhatsApp for one batch
 * of messages older than the oldest the app has — same bounded, on-demand
 * request as requestOlderHistory for a customer. What comes back (if the
 * linked phone still has it) arrives through onHistorySync.
 */
export async function requestOlderGroupHistory(groupId: string): Promise<void> {
  const group = await prisma.conversation.findUnique({ where: { id: groupId }, include: { contact: true, whatsappConnection: true } });
  if (!group || group.status !== "GROUP" || !group.contact.providerChatId) throw Errors.notFound("Grupo nao encontrado");
  if (group.whatsappConnection?.status !== "CONNECTED") {
    throw Errors.badRequest("A conexão de WhatsApp está desconectada — não é possível buscar mensagens anteriores");
  }
  const anchor = await groupsService.getOldestGroupAnchor(groupId);
  if (!anchor) throw Errors.badRequest("Este grupo ainda não tem uma mensagem recebida para servir de ponto de partida. Aguarde a próxima mensagem do grupo.");
  await getProvider(group.whatsappConnectionId!).fetchOlderHistory(group.contact.providerChatId, anchor, HISTORY_BACKFILL_BATCH_SIZE);
}

/** A group's name and participants straight from WhatsApp (cached by the provider); null when it can't be read. */
export async function getGroupInfo(connectionId: string, chatId: string) {
  const provider = providers.get(connectionId);
  if (!provider || provider.getStatus().state !== "CONNECTED") return null;
  return provider.getGroupInfo(chatId).catch(() => null);
}

/** WhatsApp's read receipt for a group's messages the team just read for the first time (best-effort). */
export async function syncGroupReadReceiptToDevice(groupId: string, messages: { providerMessageId: string; participantJid: string | null }[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    const group = await prisma.conversation.findUnique({ where: { id: groupId }, include: { contact: true } });
    if (!group?.contact.providerChatId || !group.whatsappConnectionId) return;
    const provider = providers.get(group.whatsappConnectionId);
    if (!provider || provider.getStatus().state !== "CONNECTED") return;
    const participantByMessageId: Record<string, string> = {};
    for (const m of messages) if (m.participantJid) participantByMessageId[m.providerMessageId] = m.participantJid;
    await provider.markRead(
      group.contact.providerChatId,
      messages.map((m) => m.providerMessageId),
      { participantByMessageId }
    );
  } catch (err) {
    logger.error({ err, groupId }, "failed to sync a WhatsApp group read receipt to the linked phone");
  }
}

/**
 * Turns Atendimento's Grupos tab on or off for one connection (administrator
 * only). Turning it on brings the number's groups in right away; turning it
 * off stops new group messages — what was stored stays, and comes back if
 * it is turned on again.
 */
export async function setConnectionGroupsEnabled(connectionId: string, enabled: boolean): Promise<ConnectionSummaryDTO> {
  const row = await prisma.whatsAppConnection.findUnique({ where: { id: connectionId } });
  if (!row) throw Errors.notFound("Conexao de WhatsApp nao encontrada");
  if (row.connectionMode === "OFFICIAL_API") throw Errors.badRequest("A API Oficial do WhatsApp não recebe mensagens de grupos");
  await prisma.whatsAppConnection.update({
    where: { id: connectionId },
    data: enabled ? { groupsEnabled: true, ...(row.groupsEnabled ? {} : { groupsEnabledAt: new Date() }) } : { groupsEnabled: false },
  });
  if (enabled) {
    const provider = providers.get(connectionId);
    if (provider && provider.getStatus().state === "CONNECTED") {
      const groups = await provider.listGroups().catch((err) => {
        logger.warn({ err, connectionId }, "could not list the WhatsApp groups of a connection");
        return [];
      });
      await groupsService.syncGroups(connectionId, groups);
    }
  }
  realtimeEvents.groupsChanged();
  return getConnectionSummary(connectionId);
}

// A single WhatsApp round trip per click, capped well below anything that
// could look like the account-wide dump syncFullHistory does — see
// BaileysWhatsAppProvider's fetchOlderHistory for why that one is off.
const HISTORY_BACKFILL_BATCH_SIZE = 50;

/**
 * Agent-triggered, bounded backfill of one conversation's older WhatsApp
 * history — see PROMPT: "mensagens de antes de conectar o WhatsApp" (a
 * contact whose WhatsApp relationship predates this app being linked never
 * showed any of that earlier history). Deliberately on-demand and scoped to
 * one contact at a time; the route calling this also rate-limits how often
 * an agent can trigger it. Unlike syncReadReceiptToDevice above, this is
 * the primary action the agent asked for, not a side-effect, so it throws
 * instead of swallowing failures — the UI needs to tell them it didn't work.
 */
export async function requestOlderHistory(conversationId: string): Promise<void> {
  const conversation = await conversationsService.getConversationOrThrow(conversationId);
  // Bulk history backfill rides WhatsApp-Web's own sync protocol — Graph
  // API (Messenger/Instagram) has no equivalent to fetch older history
  // from, so this is thrown rather than silently no-op'd: the agent
  // explicitly asked for this action, same reasoning as this function's
  // own doc comment already gives for throwing on a disconnected connection.
  if (conversation.channel !== "WHATSAPP") {
    throw Errors.badRequest("Busca de historico anterior so esta disponivel para conexoes de WhatsApp");
  }
  if (conversation.whatsappConnection!.status !== "CONNECTED") {
    throw Errors.badRequest("A conexao de WhatsApp esta desconectada — nao e possivel buscar historico anterior");
  }
  const anchor = await conversationsService.getOldestMessageAnchor(conversation.contactId);
  if (!anchor) {
    throw Errors.badRequest("Esta conversa ainda nao tem nenhuma mensagem para ancorar a busca de historico anterior");
  }
  const provider = getProvider(conversation.whatsappConnectionId!);
  const chatId = conversation.contact.providerChatId ?? toChatId(conversation.contact.phone!);
  await provider.fetchOlderHistory(chatId, anchor, HISTORY_BACKFILL_BATCH_SIZE);
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

/**
 * Where a message to this customer goes. A customer WhatsApp has moved to its hidden id (…@lid) — every
 * customer whose messages arrive from one — is answered at that @lid: their phone can no longer open what is
 * addressed to their number (…@s.whatsapp.net), asks for it again, and stays on "Aguardando mensagem". The
 * number is used when no @lid is known. A contact whose WhatsApp never revealed their number holds the @lid
 * digits in place of a phone, so that one only ever has the @lid.
 */
async function chatIdsFor(connectionId: string, contactPhone: string): Promise<{ primary: string; fallback: string | null }> {
  if (contactPhone.includes("@")) return { primary: contactPhone, fallback: null };
  const contact = await prisma.contact.findFirst({
    where: { whatsappConnectionId: connectionId, phone: contactPhone },
    select: { providerChatId: true },
  });
  const lid = contact?.providerChatId?.endsWith("@lid") ? contact.providerChatId : null;
  if (!lid) return { primary: toChatId(contactPhone), fallback: null };
  const opaque = lid.split("@")[0] === contactPhone;
  return { primary: lid, fallback: opaque ? null : toChatId(contactPhone) };
}

async function chatIdFor(connectionId: string, contactPhone: string): Promise<string> {
  return (await chatIdsFor(connectionId, contactPhone)).primary;
}

/** Sends at the customer's @lid; should that address be refused outright, once more at their number. */
async function sendToContact<T>(connectionId: string, contactPhone: string, send: (chatId: string) => Promise<T>): Promise<T> {
  const { primary, fallback } = await chatIdsFor(connectionId, contactPhone);
  try {
    return await send(primary);
  } catch (err) {
    if (!fallback) throw err;
    logger.warn({ err, connectionId, chatId: primary }, "sending to the customer's @lid failed — sending to their number instead");
    return send(fallback);
  }
}

// Multiple agents share the same connected WhatsApp number, so without this
// the customer has no way to tell who they're talking to from one message
// to the next — WhatsApp's own bold markdown (*text*) renders on the phone.
// Only ever applied to the text actually sent over the wire; the stored
// Message.body keeps exactly what the agent typed.
// Null = the message goes without it (an automatic message whose "Mostrar o nome do atendente no topo" is off).
export function withSenderPrefix(senderDisplayName: string | null, text: string): string {
  return senderDisplayName === null ? text : `*${senderDisplayName}:*\n\n${text}`;
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
    const provider = bootstrapConnection(row);
    // An OFFICIAL_API connection has no persistent socket to auto-reconnect
    // — its "CONNECTED" status just means the credentials were last known
    // valid, re-checked on demand (see connect() below), never on boot.
    if (row.status === "CONNECTED" && row.connectionMode === "QRCODE") {
      provider.connect().catch((err) => logger.error({ err, connectionId: row.id }, "failed to auto-reconnect WhatsApp connection on startup"));
    }
  }
}

type ConnectionRow = { id: string; connectionMode: "QRCODE" | "OFFICIAL_API"; phoneNumberId: string | null; accessToken: string | null };

function bootstrapConnection(row: ConnectionRow): WhatsAppProvider {
  const provider =
    row.connectionMode === "OFFICIAL_API"
      ? createWhatsAppProvider({
          provider: "cloud-api",
          phoneNumberId: row.phoneNumberId!,
          accessToken: decryptSecret(row.accessToken!),
        })
      : createWhatsAppProvider({
          provider: env.WHATSAPP_PROVIDER,
          authStateDir: path.join(env.WHATSAPP_AUTH_DIR, row.id),
        });
  providers.set(row.id, provider);
  wireProviderEvents(row.id, provider);
  return provider;
}

/** Re-creates a connection's provider instance with freshly-saved credentials — called after updateConnection changes an OFFICIAL_API row's phoneNumberId/accessToken, since CloudApiWhatsAppProvider captures them at construction time. */
function rebootstrapConnection(row: ConnectionRow): WhatsAppProvider {
  providers.delete(row.id);
  return bootstrapConnection(row);
}

// Customer reactions waiting their turn, one chain per WhatsApp message id.
const reactionQueues = new Map<string, Promise<void>>();

/** Runs `task` after every earlier task queued under the same key (the task handles its own errors). */
function runInOrder(queues: Map<string, Promise<void>>, key: string, task: () => Promise<void>): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
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
      // A WhatsApp group: its own tab, never the queue, Fluxo, @menção or the survey.
      if (event.group) {
        await groupsService.handleInboundGroupMessage(connectionId, event, {
          getGroupInfo: (chatId) => provider.getGroupInfo(chatId),
          addAttachments: addAttachmentsFromEvent,
        });
        return;
      }
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
      // The customer answering the satisfaction survey of a closed conversation, or thanking after its last message — kept
      // there, nothing new opens. Only the text of a text message can be a score or a thank-you: a picture or an audio is
      // somebody who wants to talk.
      const surveyBody = event.type === "TEXT" ? event.body ?? null : null;
      const kept = { body: surveyBody, providerMessageId: event.providerMessageId };
      if ((await satisfaction.captureSurveyAnswer(connectionId, contact, kept)) || (await satisfaction.captureThanksAfterClose(connectionId, contact, kept))) {
        // Nobody opens a closed conversation to read it: the phone must not keep the chat as unread.
        await provider.markRead(event.chatId, [event.providerMessageId]).catch((err) => logger.warn({ err, connectionId }, "failed to mark a kept message as read on the phone"));
        return;
      }

      const { conversation, isNewConversation, autoAssignedAgentId, flowId, closedMessage } = await conversationsService.findOrOpenConversationForInboundMessage(
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

      // The connection is outside its Horário de expediente: the notice goes out once, with the conversation that just opened.
      if (closedMessage) await sendClosedHoursNotice({ id: conversation.id, contactId: contact.id }, event.phone, contact.name, contact.firstName, closedMessage);

      // An active Fluxo is still talking to this customer — the engine
      // answers, and only hands the conversation to people when it's done.
      if (conversation.status === "IN_FLOW") {
        realtimeEvents.newMessage(conversation.id, null);
        await flowEngine.handleInboundForFlow(conversation.id, flowId, event.body ?? null, event.selectedOptionId ?? null);
        return;
      }

      // This whole handler only ever runs for a WhatsApp event (see
      // provider.onMessage above) — contact.phone is always set here.
      const contactLabel = contact.name ?? contact.phone!;
      const preview = event.body ?? (event.type === "LOCATION" ? "Localizacao" : event.type === "CONTACT" ? "Contato" : "Anexo recebido");

      // Same notification (bell + Windows, with the message text) for every
      // case where this message landed straight in an agent's own list —
      // whether it's an ongoing conversation, or one that was just routed
      // there by "@<nome do atendente>" (new, or a customer reopening a
      // conversation that had been Encerrada). See PROMPT: "ao direcionar
      // deve notificar no Windows mesmo assim que tem uma conversa nova e
      // pode até mostrar a mensagem que o cliente enviou" — this branch used
      // to only move the conversation silently, with nothing telling the
      // agent it had arrived.
      const notifyAssignedAgent = async (agentId: string) => {
        realtimeEvents.inboundMessageNotification(conversation.id, agentId, contactLabel, preview);
        const notification = await createNotification({
          userId: agentId,
          type: "MESSAGE",
          title: contactLabel,
          body: preview,
          entityType: "Conversation",
          entityId: conversation.id,
        });
        realtimeEvents.notificationCreated(agentId, toNotificationDTO(notification));
      };

      if (isNewConversation) {
        if (autoAssignedAgentId) {
          // "@<nome do atendente>" in the customer's message — skips the
          // queue entirely, straight into that agent's own list, same
          // realtime path an accepted conversation uses.
          realtimeEvents.conversationAccepted(conversation.id, connectionId, autoAssignedAgentId);
          await notifyAssignedAgent(autoAssignedAgentId);
        } else {
          // A brand-new, unclaimed conversation entering the queue — on
          // purpose, this notification never includes the message text
          // (just who's writing), unlike every other case above/below.
          realtimeEvents.newQueueConversation(connectionId, conversation.id, contactLabel);
        }
      } else {
        // "@<nome>" from a customer still waiting (queue, Fluxo, or on the phone) just took it to that person — the card leaves the queue.
        if (autoAssignedAgentId) realtimeEvents.conversationAccepted(conversation.id, connectionId, autoAssignedAgentId);
        realtimeEvents.newMessage(conversation.id, conversation.assignedAgentId);
        if (conversation.assignedAgentId) await notifyAssignedAgent(conversation.assignedAgentId);
        // Still in Abandonados: it stays there, the card moves up with the new message.
        else if (conversation.status === "FLOW_ABANDONED") realtimeEvents.abandonedChanged();
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
    // Checked before the lookup below, which opens a conversation when none is active: a message
    // already recorded (delivered again after its conversation closed) left an empty one behind.
    if (await messagesService.isMessageRecorded(event.providerMessageId)) return;

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
        isGif: event.type === "VIDEO" && Boolean(event.mediaIsGif),
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
        pollSelectableCount: event.pollSelectableCount,
        pollSecret: event.pollSecret ?? null,
        pollCreatorJid: event.pollCreatorJid ?? null,
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
    if (event.status === "FAILED") {
      // WhatsApp accepted the message from us and then refused it (an error
      // ack) — it will never reach the customer. The code is the only clue to
      // why, and the provider's own logger is silent by default.
      logger.warn(
        { connectionId, providerMessageId: event.providerMessageId, chatId: event.chatId, errorCode: event.errorCode },
        "WhatsApp rejected an outbound message — marking it failed"
      );
    }
    try {
      const message = await messagesService.updateMessageStatusByProviderId(event.providerMessageId, event.status);
      if (!message) return;
      const conversation = await prisma.conversation.findUnique({
        where: { id: message.conversationId },
        select: { assignedAgentId: true },
      });
      realtimeEvents.messageStatusChanged(message.conversationId, conversation?.assignedAgentId);
    } catch (err) {
      // A receipt for a message that was removed a moment ago (the row vanished between the lookup and the
      // update) is not worth an unhandled rejection — which would take the whole process down.
      logger.error({ err, connectionId, providerMessageId: event.providerMessageId }, "failed to apply a delivery receipt");
    }
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
      // A group's history belongs to the Grupos tab, never to the customer conversations below.
      const groupMessages = event.messages.filter((m) => m.group || isGroupChat(m.chatId));
      if (groupMessages.length > 0) {
        const added = await groupsService.importGroupHistory(connectionId, groupMessages);
        if (added.size > 0) logger.info({ connectionId, groups: added.size }, "imported a WhatsApp group history batch");
      }
      const customerMessages = groupMessages.length > 0 ? event.messages.filter((m) => !(m.group || isGroupChat(m.chatId))) : event.messages;
      if (customerMessages.length > 0) {
        const unreadChatIds = new Set(event.chats.filter((c) => c.unreadCount > 0).map((c) => c.chatId));
        const { touchedConversationIds, newQueueConversationIds } = await conversationsService.importHistoricalMessages(
          connectionId,
          customerMessages,
          unreadChatIds
        );
        logger.info(
          { connectionId, count: customerMessages.length, newQueueConversations: newQueueConversationIds.size },
          "imported a WhatsApp history sync batch"
        );
        // Without this, a conversation already open in ChatPanel when an
        // on-demand history batch lands (see requestOlderHistory below)
        // never picked it up live — only the next unrelated refetch or the
        // 20s safety poll would surface it. agentId is left null here on
        // purpose: this only needs to reach whoever has that conversation's
        // room joined right now (ChatPanel joins it explicitly while open),
        // not any specific agent's own room.
        for (const conversationId of touchedConversationIds) {
          realtimeEvents.newMessage(conversationId, null);
        }
        // A chat that already had unread messages before this connection
        // was ever linked just became a real queue entry (see
        // importHistoricalMessages' promoteToQueue) — announce it exactly
        // like a brand-new live inbound message would, so it doesn't just
        // sit there until someone happens to refresh Atendimento. See
        // PROMPT: "conversas no WhatsApp que não foram lidas não aparecem
        // na fila, pois são conversas que já estavam sem ler antes de
        // conectar o WhatsApp".
        if (newQueueConversationIds.size > 0) {
          const newConversations = await prisma.conversation.findMany({
            where: { id: { in: Array.from(newQueueConversationIds) } },
            include: { contact: true },
          });
          for (const conversation of newConversations) {
            realtimeEvents.newQueueConversation(connectionId, conversation.id, conversation.contact.name ?? conversation.contact.phone!);
            await writeAudit({
              userId: null,
              action: "WHATSAPP_UNREAD_HISTORY_QUEUED",
              entity: "Conversation",
              entityId: conversation.id,
              ipAddress: null,
              metadata: { connectionId, contactPhone: conversation.contact.phone },
            });
          }
        }
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

  // Two things heal here, both passively (createIfMissing: false — this
  // fires for every address-book contact, most of whom never actually
  // message this connection, and must never spawn a Contact/queue entry for
  // those): (1) a contact created from a message with no phone-resolvable
  // field at all to begin with — a message sent directly from the linked
  // phone in a brand-new 1:1 chat, whose remoteJid comes back as the opaque
  // @lid id with no senderPn/participantPn attached (those are only ever
  // populated for group chats); (2) the contact's name, from the phone's
  // own saved address-book entry — only for a contact still without one: a
  // name already on the platform stays (see syncDeviceContacts). See
  // ChatIdentityResolvedEvent.
  provider.onChatIdentityResolved(async (event) => {
    try {
      await conversationsService.findOrCreateContact(connectionId, event.phone, event.name ?? null, event.chatId, {
        createIfMissing: false,
      });
    } catch (err) {
      logger.error({ err, connectionId }, "failed to heal a contact's identity from a resolved chat identity");
    }
  });

  provider.onTyping(async (event) => {
    try {
      if ((await getBusinessSettings()).typingFromCustomer === false) return;
      const kind = event.kind ?? "typing";
      if (event.participantJid !== undefined) {
        // A WhatsApp group: everyone who sees it learns who of the participants is typing or recording.
        const group = await prisma.conversation.findFirst({
          where: { status: "GROUP", whatsappConnectionId: connectionId, contact: { providerChatId: event.chatId } },
          select: { id: true },
        });
        if (!group) return;
        const name = event.participantPhone
          ? ((await prisma.contact.findFirst({ where: { whatsappConnectionId: connectionId, phone: event.participantPhone, isGroup: false }, select: { name: true } }))?.name ??
            event.participantPhone)
          : "Alguém";
        await announceGroupTyping(group.id, connectionId, { typing: event.typing, kind, participant: event.participantJid ?? name, name });
        return;
      }
      const phone = event.chatId.endsWith("@s.whatsapp.net") ? event.chatId.split("@")[0] : null;
      const contact = await prisma.contact.findFirst({
        where: { whatsappConnectionId: connectionId, OR: [{ providerChatId: event.chatId }, ...(phone ? [{ phone }] : [])] },
        select: { id: true },
      });
      if (!contact) return;
      const conversation = await prisma.conversation.findFirst({
        where: { contactId: contact.id, status: { in: ["NEW", "WAITING", "IN_PROGRESS", "TRANSFERRED"] } },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true, assignedAgentId: true },
      });
      if (conversation) realtimeEvents.customerTyping(conversation.id, conversation.assignedAgentId, event.typing, kind);
    } catch (err) {
      logger.warn({ err, connectionId }, "failed to relay that the customer is typing");
    }
  });

  // Enquetes nos grupos: each vote, decrypted with the poll's key and recorded (in arrival order per poll).
  provider.onPollVote?.(async (event) => {
    await runInOrder(reactionQueues, `poll:${event.pollMessageId}`, async () => {
      try {
        const recorded = await recordPollVote(event, (conversationId) => groupParticipantName(connectionId, conversationId, event.voterJid, event.voterPhone));
        if (!recorded) return;
        const conversation = await prisma.conversation.findUnique({ where: { id: recorded.conversationId }, select: { assignedAgentId: true, status: true } });
        if (conversation?.status === "GROUP") await groupsService.announceGroupReaction(recorded.conversationId, connectionId);
        else realtimeEvents.messageStatusChanged(recorded.conversationId, conversation?.assignedAgentId ?? null);
      } catch (err) {
        logger.error({ err, connectionId, pollMessageId: event.pollMessageId }, "failed to record a poll vote");
      }
    });
  });

  provider.onReaction(async (event) => {
    // A reaction made by OUR account is never the customer's: Baileys echoes
    // every reaction an agent clicks in this app (the agent's own reaction is
    // already stored — recording the echo too showed it twice, "Ana" plus a
    // phantom "Cliente", and wiped out whatever the customer had reacted),
    // and a reaction made on the linked phone arrives the same way.
    if (event.fromMe) return;
    // In arrival order per message — a customer who changes their reaction twice
    // inside one Baileys batch must end up with the LAST one, not whichever
    // database round-trip happens to finish first.
    await runInOrder(reactionQueues, event.providerMessageId, async () => {
      try {
        const message = await prisma.message.findUnique({
          where: { providerMessageId: event.providerMessageId },
          include: { conversation: { select: { assignedAgentId: true } } },
        });
        if (!message) return;
        if (event.participant) {
          // A group: each participant has their own reaction, shown with their name.
          const name = await groupParticipantName(connectionId, message.conversationId, event.participant.jid, event.participant.phone);
          await messagesService.setParticipantReaction(message.id, { jid: event.participant.jid, name, phone: event.participant.phone }, event.emoji);
          await groupsService.announceGroupReaction(message.conversationId, connectionId);
          return;
        } else {
          await messagesService.setCustomerReaction(message.id, event.emoji);
        }
        realtimeEvents.messageStatusChanged(message.conversationId, message.conversation.assignedAgentId);
      } catch (err) {
        logger.error({ err, connectionId, providerMessageId: event.providerMessageId }, "failed to record a customer reaction");
      }
    });
  });
}

/** A group participant's name: the one their messages in this group carried, else the contact saved with that number. */
async function groupParticipantName(connectionId: string, conversationId: string, jid: string, phone: string | null): Promise<string | null> {
  const lastMessage = await prisma.message.findFirst({
    where: { conversationId, senderParticipantJid: jid, senderParticipantName: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { senderParticipantName: true },
  });
  if (lastMessage?.senderParticipantName) return lastMessage.senderParticipantName;
  if (!phone) return null;
  const contact = await prisma.contact.findFirst({ where: { whatsappConnectionId: connectionId, phone, isGroup: false }, select: { name: true } });
  return contact?.name ?? null;
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
  /** Respostas › Horário de expediente this connection follows; null = open 24 hours. */
  workScheduleId: string | null;
  /** Minutes a customer of a phone conversation may wait before it comes to the queue; null = never. */
  deviceReplyTimeoutMinutes: number | null;
  id: string;
  name: string;
  color: string;
  connectionMode: "QRCODE" | "OFFICIAL_API";
  state: string;
  qrCodeDataUrl: string | null;
  pairingCode: string | null;
  /** While a pairing code is on screen: when it stops being valid (a new one replaces it) and the number it is for. */
  pairingCodeExpiresAt: string | null;
  pairingPhoneNumber: string | null;
  connectedNumber: string | null;
  // The number this connection was first ever linked to — see PROMPT:
  // "reconectar somente no mesmo número que já estava antes". Null only for
  // a connection that has never completed a pairing yet, in which case any
  // number is accepted (there's nothing to conflict with). QRCODE only.
  linkedNumber: string | null;
  lastConnectedAt: string | null;
  // Last time the phone's address book was loaded into Nova conversa — null if never.
  contactsSyncedAt: string | null;
  agentCount: number;
  /** Atendimento's Grupos tab is on for this number (never for an OFFICIAL_API one). */
  groupsEnabled: boolean;
  /** How many WhatsApp groups of this number the system knows. */
  groupsCount: number;
  createdByUserId: string | null;
  createdByUserName: string | null;
  // OFFICIAL_API only — accessToken itself is never returned, only whether
  // one is on file (same masking precedent as MetaSettingsMasked).
  phoneNumberId: string | null;
  wabaId: string | null;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  webhookVerifyToken: string | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
}

// Distinct, readable-on-white swatches auto-assigned to new connections in
// rotation so the admin doesn't have to pick a color for every one — still
// changeable afterwards via PATCH /connections/:id.
const COLOR_PALETTE = ["#0097B4", "#7C3AED", "#F97316", "#059669", "#DC2626", "#2563EB", "#DB2777", "#65A30D"];

const connectionSummaryInclude = {
  _count: { select: { agents: true, conversations: { where: { status: "GROUP" as const } } } },
  createdByUser: { select: { id: true, displayName: true } } } as const;

function toConnectionSummary(row: {
  id: string;
  name: string;
  color: string;
  connectionMode: "QRCODE" | "OFFICIAL_API";
  status: string;
  connectedNumber: string | null;
  linkedNumber: string | null;
  lastConnectedAt: Date | null;
  contactsSyncedAt: Date | null;
  _count: { agents: number; conversations: number };
  groupsEnabled: boolean;
  workScheduleId: string | null;
  deviceReplyTimeoutMinutes: number | null;
  createdByUser: { id: string; displayName: string } | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  accessToken: string | null;
  appSecret: string | null;
  webhookVerifyToken: string | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
}): ConnectionSummaryDTO {
  const runtime = providers.get(row.id)?.getStatus();
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    connectionMode: row.connectionMode,
    state: runtime?.state ?? row.status,
    qrCodeDataUrl: runtime?.qrCodeDataUrl ?? null,
    pairingCode: runtime?.pairingCode ?? null,
    pairingCodeExpiresAt: runtime?.pairingCode ? (runtime.pairingCodeExpiresAt?.toISOString() ?? null) : null,
    pairingPhoneNumber: runtime?.pairingCode ? (runtime.pairingPhoneNumber ?? null) : null,
    connectedNumber: runtime?.connectedNumber ?? row.connectedNumber,
    linkedNumber: row.linkedNumber,
    lastConnectedAt: (runtime?.lastConnectedAt ?? row.lastConnectedAt)?.toISOString?.() ?? null,
    contactsSyncedAt: row.contactsSyncedAt?.toISOString() ?? null,
    agentCount: row._count.agents,
    groupsEnabled: row.groupsEnabled,
    workScheduleId: row.workScheduleId,
    deviceReplyTimeoutMinutes: row.deviceReplyTimeoutMinutes,
    groupsCount: row._count.conversations,
    createdByUserId: row.createdByUser?.id ?? null,
    createdByUserName: row.createdByUser?.displayName ?? null,
    phoneNumberId: row.phoneNumberId,
    wabaId: row.wabaId,
    hasAccessToken: Boolean(row.accessToken),
    hasAppSecret: Boolean(row.appSecret),
    webhookVerifyToken: row.webhookVerifyToken,
    displayPhoneNumber: row.displayPhoneNumber,
    businessName: row.businessName,
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

export interface OfficialCredentialsInput {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret?: string;
  webhookVerifyToken?: string;
}

export async function createConnection(
  name: string,
  color: string | undefined,
  createdByUserId: string,
  official?: OfficialCredentialsInput
): Promise<ConnectionSummaryDTO> {
  const existing = await prisma.whatsAppConnection.findUnique({ where: { name } });
  if (existing) throw Errors.conflict("Ja existe uma conexao com este nome");
  const existingCount = await prisma.whatsAppConnection.count();
  const row = await prisma.whatsAppConnection.create({
    data: {
      name,
      color: color ?? COLOR_PALETTE[existingCount % COLOR_PALETTE.length],
      createdByUserId,
      ...(official
        ? {
            connectionMode: "OFFICIAL_API" as const,
            phoneNumberId: official.phoneNumberId,
            wabaId: official.wabaId,
            accessToken: encryptSecret(official.accessToken),
            appSecret: official.appSecret ? encryptSecret(official.appSecret) : null,
            webhookVerifyToken: official.webhookVerifyToken || null,
          }
        : {}),
    },
  });
  bootstrapConnection(row);
  return getConnectionSummary(row.id);
}

export async function updateConnection(
  connectionId: string,
  patch: { name?: string; color?: string; workScheduleId?: string | null; deviceReplyTimeoutMinutes?: number | null; official?: Partial<OfficialCredentialsInput> }
): Promise<ConnectionSummaryDTO> {
  if (patch.name) {
    const clash = await prisma.whatsAppConnection.findUnique({ where: { name: patch.name } });
    if (clash && clash.id !== connectionId) throw Errors.conflict("Ja existe uma conexao com este nome");
  }
  if (patch.workScheduleId) await assertWorkScheduleExists(patch.workScheduleId);
  const row = await prisma.whatsAppConnection.update({
    where: { id: connectionId },
    data: {
      name: patch.name,
      color: patch.color,
      workScheduleId: patch.workScheduleId,
      deviceReplyTimeoutMinutes: patch.deviceReplyTimeoutMinutes,
      ...(patch.official
        ? {
            phoneNumberId: patch.official.phoneNumberId,
            wabaId: patch.official.wabaId,
            // Only overwrite when a new non-empty secret is sent — same
            // precedent as updateEmailSettings/updateMetaSettings, since
            // the API never echoes the current one back for the admin to
            // resubmit unchanged.
            ...(patch.official.accessToken ? { accessToken: encryptSecret(patch.official.accessToken) } : {}),
            ...(patch.official.appSecret ? { appSecret: encryptSecret(patch.official.appSecret) } : {}),
            webhookVerifyToken: patch.official.webhookVerifyToken,
          }
        : {}),
    },
  });
  // Credentials changed — rebuild the provider instance so the next
  // connect()/send picks up the new phoneNumberId/accessToken instead of
  // the ones it was constructed with. Marked DISCONNECTED until re-tested,
  // same as a QR connection must be reconnected after any real change.
  if (patch.official && row.connectionMode === "OFFICIAL_API") {
    rebootstrapConnection(row);
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { status: "DISCONNECTED" } });
  }
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

export interface DeviceContact {
  phone: string;
  name: string | null;
  photoUrl: string | null;
}

/**
 * What "Nova conversa" offers: the phone's address book (as of its last
 * sync) plus everyone who already talked to this connection, so a customer
 * can always be found by name or number even when they aren't saved on the
 * phone. Numbers are real phone numbers only — never opaque WhatsApp ids.
 */
export async function listContacts(connectionId: string): Promise<DeviceContact[]> {
  const [addressBook, known] = await Promise.all([
    getProvider(connectionId).listContacts(),
    prisma.contact.findMany({
      where: { whatsappConnectionId: connectionId, channel: "WHATSAPP", phone: { not: null }, isGroup: false },
      select: { phone: true, name: true, photoUrl: true, providerChatId: true },
    }),
  ]);
  const byPhone = new Map<string, DeviceContact>();
  for (const c of known) {
    const opaque = Boolean(c.providerChatId?.endsWith("@lid") && c.phone === c.providerChatId.split("@")[0]);
    if (c.phone && !opaque) byPhone.set(c.phone, { phone: c.phone, name: c.name, photoUrl: c.photoUrl });
  }
  // The name already on the platform wins; the one saved on the phone only names who has none there.
  for (const c of addressBook) byPhone.set(c.phone, { phone: c.phone, name: byPhone.get(c.phone)?.name ?? c.name, photoUrl: c.photoUrl ?? byPhone.get(c.phone)?.photoUrl ?? null });
  return Array.from(byPhone.values()).sort((a, b) => (a.name ?? a.phone).localeCompare(b.name ?? b.phone, "pt-BR"));
}

/** Syncs every connected QR Code connection whose address book was last loaded before `slotStart`. */
export async function syncDueDeviceContacts(slotStart: Date): Promise<void> {
  const due = await prisma.whatsAppConnection.findMany({
    where: { connectionMode: "QRCODE", OR: [{ contactsSyncedAt: null }, { contactsSyncedAt: { lt: slotStart } }] },
    select: { id: true },
  });
  for (const { id } of due) {
    if (providers.get(id)?.getStatus().state !== "CONNECTED") continue;
    try {
      const { count } = await syncDeviceContacts(id);
      logger.info({ connectionId: id, count }, "loaded the phone address book");
    } catch (err) {
      logger.error({ err, connectionId: id }, "failed to load the phone address book");
    }
  }
}

/**
 * Loads the phone's whole address book into this connection's contact list — also run weekly, see
 * lib/contacts-sync.ts — and saves the ones the platform doesn't have yet in Contatos, so they're at hand without
 * loading again. A number already saved (in either form of a Brazilian mobile, with or without the 9) is left as
 * it is: the platform's name wins over the one saved on the phone.
 */
export async function syncDeviceContacts(connectionId: string): Promise<{ count: number; created: number; syncedAt: Date }> {
  const provider = getProvider(connectionId);
  if (provider.getStatus().state !== "CONNECTED") throw Errors.badRequest("A conexão precisa estar conectada para carregar os contatos");
  const { count } = await provider.syncContacts();
  const created = await saveAddressBookToContacts(connectionId, await provider.listContacts());
  const syncedAt = new Date();
  await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { contactsSyncedAt: syncedAt } });
  return { count, created, syncedAt };
}

async function saveAddressBookToContacts(connectionId: string, addressBook: DeviceContact[]): Promise<number> {
  const saved = await prisma.contact.findMany({ where: { whatsappConnectionId: connectionId, phone: { not: null } }, select: { phone: true } });
  const known = new Set(saved.flatMap((c) => brazilianPhoneVariants(c.phone!)));
  const toCreate: Prisma.ContactCreateManyInput[] = [];
  for (const c of addressBook) {
    const variants = brazilianPhoneVariants(c.phone);
    if (variants.some((v) => known.has(v))) continue;
    variants.forEach((v) => known.add(v));
    toCreate.push({ channel: "WHATSAPP", whatsappConnectionId: connectionId, phone: c.phone, name: normalizeContactName(c.name), photoUrl: c.photoUrl });
  }
  if (toCreate.length === 0) return 0;
  const { count } = await prisma.contact.createMany({ data: toCreate, skipDuplicates: true });
  return count;
}

/**
 * Validates a manually-typed number against WhatsApp itself before starting
 * a conversation with it — one bounded lookup, not a bulk address-book
 * dump. See PROMPT: "Tem a possibilidade de buscar no celular somente o
 * que digitar, pelo número". Name search has no equivalent: WhatsApp's
 * protocol has no per-query "look this name up on the phone" call, only
 * the gradual contacts.upsert stream listContacts above already reads from.
 */
export async function lookupNumber(connectionId: string, phone: string) {
  return getProvider(connectionId).lookupNumber(phone);
}

// Comfortably under Baileys' own ~60s internal query timeout for
// sendMessage, so this guard is always the one that fires first and the UI
// always gets a definitive outcome instead of the clock icon forever. See
// PROMPT: "uma conexão atrapalha a outra? ... a mensagem enviada não
// aparecia para o cliente e nem no meu celular, só aparecia na
// plataforma... ícone de um relógio". Pairing/reconnecting a second
// connection does real (if now lighter, see BaileysWhatsAppProvider's
// syncFullHistory) work on the same Node process/event loop as every other
// connection, so a send elsewhere can end up waiting a long time for its
// turn — this doesn't stop that from happening, but it stops "waiting a
// long time" from ever looking identical to "silently lost forever" in the
// UI, which is what actually made the earlier incident feel broken.
const OUTBOUND_SEND_TIMEOUT_MS = 45_000;

/**
 * Every outbound send (text/file/audio/location) goes through here: races
 * the real provider call against OUTBOUND_SEND_TIMEOUT_MS and marks the
 * message FAILED the moment either one loses, instead of leaving it PENDING
 * indefinitely when the provider call itself never settles.
 *
 * A timed-out send isn't necessarily a dead one — the underlying promise is
 * still running and may yet resolve. If it does, this reconciles the
 * message to what actually happened (SENT, not a stale FAILED) and pushes a
 * realtime update, rather than leaving the agent looking at the wrong
 * status for something that, it turns out, did go through.
 */
async function sendWithTimeoutGuard(messageId: string, logLabel: string, sendFn: () => Promise<SendResult>) {
  // A thunk, not an already-started promise: getProvider() throws
  // synchronously for a connection that's missing from the in-memory
  // registry (e.g. right after a restart, before initWhatsAppConnections
  // finishes) — calling it in here keeps that on the same "mark FAILED,
  // don't propagate a raw 500" path as every other failure instead of
  // escaping past this guard uncaught.
  const settled = Promise.resolve()
    .then(sendFn)
    .then(
      (result) => ({ ok: true as const, result }),
      (err) => ({ ok: false as const, err })
    );
  const timedOut = new Promise<{ ok: "timeout" }>((resolve) => setTimeout(() => resolve({ ok: "timeout" }), OUTBOUND_SEND_TIMEOUT_MS));

  const outcome = await Promise.race([settled, timedOut]);

  if (outcome.ok === "timeout") {
    logger.error({ messageId, logLabel, timeoutMs: OUTBOUND_SEND_TIMEOUT_MS }, `outbound whatsapp ${logLabel} did not settle in time — marking failed instead of leaving it pending forever`);
    const failedMessage = await messagesService.markMessageFailed(messageId);
    settled.then(async (late) => {
      if (!late.ok) return; // it really did fail — already reflected above
      const sentMessage = await messagesService.markMessageSent(messageId, late.result.providerMessageId, late.result.linkPreview);
      const conversation = await prisma.conversation.findUnique({ where: { id: sentMessage.conversationId }, select: { assignedAgentId: true } });
      realtimeEvents.messageStatusChanged(sentMessage.conversationId, conversation?.assignedAgentId);
    });
    return toMessageDTO(failedMessage);
  }

  if (!outcome.ok) {
    logger.error({ err: outcome.err, messageId }, `failed to send outbound whatsapp ${logLabel}`);
    const message = await messagesService.markMessageFailed(messageId);
    return toMessageDTO(message);
  }

  const message = await messagesService.markMessageSent(messageId, outcome.result.providerMessageId, outcome.result.linkPreview);
  return toMessageDTO(message);
}

/** Sends a text/reply through the provider and reflects the result on the stored Message row. */
export async function sendOutboundText(
  connectionId: string,
  messageId: string,
  contactPhone: string,
  text: string,
  senderDisplayName: string | null,
  replyToProviderMessageId?: string,
  replyToText?: string | null,
  replyToParticipantJid?: string | null,
  mentions?: string[]
) {
  return sendWithTimeoutGuard(messageId, "text", async () =>
    sendToContact(connectionId, contactPhone, (chatId) =>
      getProvider(connectionId).sendText(chatId, withSenderPrefix(senderDisplayName, text), {
        replyToProviderMessageId,
        replyToText,
        ...(replyToParticipantJid ? { replyToParticipantJid } : {}),
        ...(mentions?.length ? { mentions } : {}),
      })
    )
  );
}

/** A message written by the system itself (Fluxo, pesquisa de satisfação) — sent as-is, without the "*Nome:*" agent prefix. */
/** The out-of-hours notice of a connection's Horário de expediente — {{cliente}} is the customer's name (or number), {{primeiro_nome}} its first word. */
async function sendClosedHoursNotice(conversation: { id: string; contactId: string }, phone: string, contactName: string | null, firstName: string | null, text: string): Promise<void> {
  await sendOutOfHoursNotice(conversation, fillSendTags(text, contactName ?? phone, firstName));
}

export async function sendAutomatedText(connectionId: string, messageId: string, contactPhone: string, text: string) {
  return sendWithTimeoutGuard(messageId, "text", () => sendToContact(connectionId, contactPhone, (chatId) => getProvider(connectionId).sendText(chatId, text, {})));
}

/**
 * A notice from the system to a number that isn't a conversation (the alert of a failed scheduled presentation): sent
 * through the chosen connection, not stored as a message. Throws when the connection is off or WhatsApp refuses it.
 */
export async function sendSystemNotice(connectionId: string, phone: string, text: string): Promise<void> {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) throw Errors.badRequest(`Número de WhatsApp inválido: ${phone}`);
  await sendToContact(connectionId, digits.length <= 11 ? `55${digits}` : digits, (chatId) => getProvider(connectionId).sendText(chatId, text, {}));
}

/** Whether this connection is the API Oficial (Cloud API) — its flow menus go as buttons/lists. */
export function isOfficialConnection(connectionId: string): boolean {
  return providers.get(connectionId) instanceof CloudApiWhatsAppProvider;
}

/** A flow menu as WhatsApp's own buttons or list — only on an API Oficial connection (see isOfficialConnection). */
export async function sendAutomatedMenu(connectionId: string, messageId: string, contactPhone: string, menu: OutboundMenu) {
  const provider = providers.get(connectionId);
  if (!(provider instanceof CloudApiWhatsAppProvider)) throw Errors.badRequest("Botões e listas só podem ser enviados por uma conexão da API Oficial");
  return sendWithTimeoutGuard(messageId, "menu", () => provider.sendMenu(toChatId(contactPhone), menu));
}

/** Sends a Meta-approved template — only possible on an OFFICIAL_API connection (Cloud API). */
export async function sendOutboundTemplate(connectionId: string, messageId: string, contactPhone: string, template: TemplateSendInput) {
  const provider = providers.get(connectionId);
  if (!(provider instanceof CloudApiWhatsAppProvider)) throw Errors.badRequest("Templates só podem ser enviados por uma conexão da API Oficial");
  return sendWithTimeoutGuard(messageId, "template", () => provider.sendTemplate(toChatId(contactPhone), template));
}

export async function sendOutboundFile(
  connectionId: string,
  messageId: string,
  contactPhone: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  senderDisplayName: string | null,
  caption?: string
) {
  return sendWithTimeoutGuard(messageId, "file", () =>
    sendToContact(connectionId, contactPhone, (chatId) =>
      getProvider(connectionId).sendFile(chatId, buffer, fileName, mimeType, caption ? withSenderPrefix(senderDisplayName, caption) : undefined)
    )
  );
}

/** A recorded voice note (WhatsApp's PTT bubble) — distinct from sendOutboundFile, which sends ptt: false for an attached audio file. `buffer` must already be OGG/Opus-encoded by this point; see apps/api/src/lib/audio-transcode.ts. */
export async function sendOutboundAudio(connectionId: string, messageId: string, contactPhone: string, buffer: Buffer, mimeType: string) {
  return sendWithTimeoutGuard(messageId, "audio", () => sendToContact(connectionId, contactPhone, (chatId) => getProvider(connectionId).sendAudio(chatId, buffer, mimeType)));
}

export async function sendOutboundLocation(connectionId: string, messageId: string, contactPhone: string, lat: number, lng: number) {
  return sendWithTimeoutGuard(messageId, "location", () => sendToContact(connectionId, contactPhone, (chatId) => getProvider(connectionId).sendLocation(chatId, lat, lng)));
}

/** `targetFromMe`: the message being reacted to is one WE sent (WhatsApp needs to know whose message the reaction is about). */
export async function sendReaction(connectionId: string, contactPhone: string, providerMessageId: string, emoji: string | null, targetFromMe = false) {
  await sendToContact(connectionId, contactPhone, (chatId) => getProvider(connectionId).sendReaction(chatId, providerMessageId, emoji, { targetFromMe }));
}

interface MessageTemplateStatusUpdateValue {
  event: string;
  message_template_id: string;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
}

interface CloudApiWebhookBody {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: CloudApiWebhookValue | MessageTemplateStatusUpdateValue }[] }[];
}

/**
 * Entry point for POST /whatsapp/oficial/webhook — mirrors meta.service.ts's
 * processWebhookPayload as closely as the two APIs' shapes allow. One
 * physical webhook URL/route can serve every OFFICIAL_API connection,
 * however many different Meta Apps they were registered under: each
 * change's own value.metadata.phone_number_id (or, for a template status
 * event, the entry's own WABA id) picks out which connection — and
 * therefore which Meta App Secret to verify the signature against — it
 * belongs to. See WhatsAppConnection.appSecret's own doc comment for why
 * this can't be checked before parsing the body, the same way the
 * verify-token handshake below also has to.
 */
export async function verifyAndIngestOfficialWebhook(rawBody: Buffer, signatureHeader: string | undefined, body: CloudApiWebhookBody): Promise<void> {
  if (body.object !== "whatsapp_business_account") return;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "messages") {
        const value = change.value as CloudApiWebhookValue;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const connection = await prisma.whatsAppConnection.findFirst({
          where: { phoneNumberId, connectionMode: "OFFICIAL_API" },
          select: { id: true, appSecret: true },
        });
        if (!connection) {
          logger.warn({ phoneNumberId }, "received a WhatsApp Cloud API webhook event for an unknown phoneNumberId");
          continue;
        }
        if (connection.appSecret && !verifyWebhookSignature(rawBody, signatureHeader, decryptSecret(connection.appSecret))) {
          logger.warn({ connectionId: connection.id }, "rejected a WhatsApp Cloud API webhook event: missing or invalid X-Hub-Signature-256");
          continue;
        }
        const provider = providers.get(connection.id);
        if (!(provider instanceof CloudApiWhatsAppProvider)) {
          logger.warn({ connectionId: connection.id }, "received a WhatsApp Cloud API webhook event for a connection with no cloud-api provider bootstrapped");
          continue;
        }
        await provider.ingestWebhookChange(value);
      } else if (change.field === "message_template_status_update") {
        // Scoped by WABA (entry.id), not by phone number — several
        // OFFICIAL_API connections can share one WABA. Any one of them
        // registered under the same Meta App carries the right secret to
        // verify this event's signature.
        const wabaId = entry.id;
        if (!wabaId) continue;
        const connection = await prisma.whatsAppConnection.findFirst({
          where: { wabaId, connectionMode: "OFFICIAL_API" },
          select: { id: true, appSecret: true },
        });
        if (!connection) {
          logger.warn({ wabaId }, "received a message_template_status_update for an unknown WABA");
          continue;
        }
        if (connection.appSecret && !verifyWebhookSignature(rawBody, signatureHeader, decryptSecret(connection.appSecret))) {
          logger.warn({ connectionId: connection.id }, "rejected a message_template_status_update event: missing or invalid X-Hub-Signature-256");
          continue;
        }
        await messageTemplatesService.handleStatusWebhook(change.value as MessageTemplateStatusUpdateValue);
      }
    }
  }
}

/** The verify-token handshake (GET) accepts a token that matches ANY configured OFFICIAL_API connection — see verifyAndIngestOfficialWebhook's doc comment for why one shared URL has to support several independently-registered Meta Apps/verify tokens. */
export async function officialWebhookVerifyTokenExists(token: string): Promise<boolean> {
  const match = await prisma.whatsAppConnection.findFirst({ where: { connectionMode: "OFFICIAL_API", webhookVerifyToken: token } });
  return Boolean(match);
}
