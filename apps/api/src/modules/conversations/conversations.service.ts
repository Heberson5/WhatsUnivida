import { normalizeContactName } from "@whatsatendende/types";
import { Prisma } from "@prisma/client";
import { CONVERSATION_UNDO_WINDOW_MS, brazilianPhoneVariants } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { endFlowSession, flowIdsWithPerson, noteAbandonedReason } from "../flows/flow-engine.service";
import { blockingTag, recordBlocked, CONTACT_CARD_TAGS } from "../../lib/auto-messages";
import { getClosedMessageForConnection } from "../work-schedules/work-schedules.service";
import { scheduleCloseFollowUp, type HeldClosingMessage } from "../satisfaction/satisfaction.service";
import { Errors } from "../../lib/http-error";
import { writeAudit } from "../../lib/audit";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import type { AgentPresence, Channel, Contact, ConversationStatus, Role } from "@prisma/client";

/** Conversation.closeReason of "Encerrar por falta de retorno" (manual or automatic) — counted apart in the reports. */
export const NO_RETURN_CLOSE_REASON = "NO_RETURN";
const TRANSFER_OFFLINE_GRACE_MS = 2 * 60 * 60 * 1000; // 2h — see PROMPT: transfer to an offline agent auto-reverts if they don't log in in time.

const conversationInclude = {
  // The contact's tags — on the card (name and color), and the ones that stop automatic messages.
  contact: { include: CONTACT_CARD_TAGS },
  assignedAgent: true,
  interventionBy: true,
  whatsappConnection: true,
  metaConnection: true,
  transfers: { orderBy: { createdAt: "desc" as const }, take: 1, include: { fromAgent: true, toAgent: true } },
  // A scheduled message still to go out pauses the "falta de retorno" close (and blocks the manual one).
  _count: { select: { scheduledMessages: { where: { sentAt: null, canceledAt: null, failedAt: null } } } },
};

/**
 * Unread badge count per conversation: inbound messages newer than the
 * assigned agent's last "read" marker (or all inbound messages if they
 * have never opened it). One query for the whole list instead of N+1 —
 * the JOIN compares each message against its own conversation's cutoff.
 */
async function getUnreadCounts(conversationIds: string[]): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ conversationId: string; count: bigint }[]>(
    Prisma.sql`
      SELECT m."conversationId" AS "conversationId", COUNT(*)::bigint AS count
      FROM "Message" m
      JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
        AND m.direction = 'INBOUND'
        AND (c."assignedAgentReadAt" IS NULL OR m."createdAt" > c."assignedAgentReadAt")
      GROUP BY m."conversationId"
    `
  );
  return new Map(rows.map((r) => [r.conversationId, Number(r.count)]));
}

/**
 * Contact resolution: WhatsApp is the source of truth for phone -> identity,
 * scoped per connection — the same phone number talking to two different
 * connected WhatsApp numbers is two separate customer relationships.
 *
 * `providerChatId` (the raw WhatsApp chat id, e.g. "<n>@lid" or
 * "<n>@s.whatsapp.net") matters because of WhatsApp's @lid privacy
 * migration: the SAME chat can report this id in either form across
 * different events — e.g. an inbound customer message resolves the real
 * phone (via senderPn) while a message echoed from the linked phone itself
 * comes back with only the opaque @lid digits and no phone attached at all
 * (senderPn/participantPn are only ever populated for group chats). Without
 * a stable key, that second kind of event would spawn a brand-new,
 * disconnected contact/conversation every time instead of continuing the
 * existing one — this is what used to show up as a duplicate card in the
 * Fila for someone already in "Meus Atendimentos".
 *
 * Resolution order: (1) exact match on the stable chat id, if we've seen
 * this one before — correcting the phone in place should this event have
 * resolved a real number where an earlier one hadn't; (2) match on phone,
 * learning the chat id onto that row if it didn't have one yet; (3) the
 * legacy heal path for a row created back when only the @lid digits were
 * known and stored as its phone, before providerChatId existed at all;
 * (4) a genuinely new contact.
 *
 * `opts.preferIncomingName` lets a name someone picked on purpose (Nova
 * conversa) override a name already on file, instead of the default "never
 * clobber a known name" rule.
 * `opts.createIfMissing` (default true) set to false turns this into a
 * passive enrichment lookup that never creates a Contact — used by the
 * device-address-book sync, where a match against a phone nobody has ever
 * actually messaged this connection through would otherwise pollute
 * Fila/Gestão with contacts that have no conversation behind them.
 */
export async function findOrCreateContact(
  connectionId: string,
  phone: string,
  name: string | null,
  providerChatId?: string,
  opts?: { preferIncomingName?: boolean; createIfMissing?: true }
): Promise<Contact>;
export async function findOrCreateContact(
  connectionId: string,
  phone: string,
  name: string | null,
  providerChatId: string | undefined,
  opts: { preferIncomingName?: boolean; createIfMissing: false }
): Promise<Contact | null>;
export async function findOrCreateContact(
  connectionId: string,
  phone: string,
  name: string | null,
  providerChatId?: string,
  opts?: { preferIncomingName?: boolean; createIfMissing?: boolean }
): Promise<Contact | null> {
  const createIfMissing = opts?.createIfMissing ?? true;
  // Contatos › padrão de nomes: "MARIA DA SILVA" / "123 tgs maria" as WhatsApp brings them are saved standardized.
  name = normalizeContactName(name);
  const resolveName = (existingName: string | null, incomingName: string | null) =>
    opts?.preferIncomingName && incomingName ? incomingName : (existingName ?? incomingName ?? undefined);

  if (providerChatId) {
    const byChatId = await prisma.contact.findFirst({
      where: { whatsappConnectionId: connectionId, providerChatId },
    });
    if (byChatId) {
      // Only upgrade the stored phone when this event actually resolved
      // one — never downgrade an already-known real number back to the
      // raw @lid digits just because this particular event couldn't
      // resolve it.
      const resolvedPhone = phone === providerChatId.split("@")[0] ? undefined : phone;
      if (resolvedPhone && resolvedPhone !== byChatId.phone) {
        // A DIFFERENT contact already owns this exact phone under this
        // connection — byChatId was itself a duplicate spawned back when
        // this chat id had never resolved a phone number yet (e.g. a
        // message sent directly from the phone on a chat this app had no
        // prior record of), and this event is the first to reveal it was
        // the same person all along. Fold it into the real contact instead
        // of colliding on the unique-phone constraint (which used to fail
        // this update silently, permanently stranding the duplicate).
        const collision = await prisma.contact.findUnique({
          where: { phone_whatsappConnectionId: { phone: resolvedPhone, whatsappConnectionId: connectionId } },
        });
        if (collision && collision.id !== byChatId.id) {
          const merged = await prisma.$transaction(async (tx) => {
            await tx.conversation.updateMany({ where: { contactId: byChatId.id }, data: { contactId: collision.id } });
            // Delete the duplicate BEFORE writing its providerChatId onto
            // the survivor — both rows would briefly hold the same value
            // otherwise, tripping the unique [providerChatId,
            // whatsappConnectionId] constraint.
            await tx.contact.delete({ where: { id: byChatId.id } });
            return tx.contact.update({
              where: { id: collision.id },
              data: { lastInteractionAt: new Date(), providerChatId: collision.providerChatId ?? providerChatId },
            });
          });
          // The survivor can now own two simultaneously-active conversations
          // (one from each side of the contact merge) — same customer, still
          // two cards in Fila/Gestão. Collapse them into one automatically,
          // same as the manual merge an admin would otherwise have to do.
          await foldActiveConversationDuplicates(collision.id);
          await writeAudit({
            userId: null,
            action: "CONTACTS_AUTO_MERGED",
            entity: "Contact",
            entityId: collision.id,
            metadata: { mergedContactId: byChatId.id, connectionId, reason: "WhatsApp resolved this chat's real phone number to an already-known contact" },
          });
          realtimeEvents.conversationsMerged(connectionId);
          return merged;
        }
      }
      return prisma.contact.update({
        where: { id: byChatId.id },
        data: { lastInteractionAt: new Date(), name: resolveName(byChatId.name, name), phone: resolvedPhone },
      });
    }
  }

  const existing = await prisma.contact.findUnique({
    where: { phone_whatsappConnectionId: { phone, whatsappConnectionId: connectionId } },
  });
  if (existing) {
    return prisma.contact.update({
      where: { id: existing.id },
      data: {
        lastInteractionAt: new Date(),
        name: resolveName(existing.name, name),
        // WhatsApp moving this customer to a hidden id (@lid) replaces the address kept from before: replies have
        // to go there now (see whatsapp.service chatIdsFor). Any other id only fills a gap.
        providerChatId: providerChatId?.endsWith("@lid") && !existing.providerChatId?.endsWith("@lid") ? providerChatId : (existing.providerChatId ?? providerChatId ?? undefined),
      },
    });
  }

  if (!createIfMissing) return null;

  if (providerChatId) {
    const priorPhone = providerChatId.split("@")[0];
    if (priorPhone && priorPhone !== phone) {
      const byPriorPhone = await prisma.contact.findUnique({
        where: { phone_whatsappConnectionId: { phone: priorPhone, whatsappConnectionId: connectionId } },
      });
      if (byPriorPhone) {
        return prisma.contact
          .update({
            where: { id: byPriorPhone.id },
            data: { phone, providerChatId, lastInteractionAt: new Date(), name: resolveName(byPriorPhone.name, name) },
          })
          .catch(() => byPriorPhone); // extremely rare unique-constraint race — keep the old phone rather than fail the message
      }
    }
  }

  return prisma.contact.create({ data: { phone, name, whatsappConnectionId: connectionId, providerChatId } });
}

export async function updateContactPhoto(contactId: string, photoUrl: string) {
  return prisma.contact.update({ where: { id: contactId }, data: { photoUrl } });
}

export interface HistoricalMessageInput {
  providerMessageId: string;
  chatId?: string;
  phone: string;
  fromMe: boolean;
  type: "TEXT" | "LOCATION" | "CONTACT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "POLL" | "EVENT";
  body: string | null;
  latitude?: number;
  longitude?: number;
  vcard?: string;
  pollQuestion?: string;
  pollOptions?: string[];
  pollSelectableCount?: number;
  pollSecret?: string | null;
  pollCreatorJid?: string | null;
  eventName?: string;
  eventDescription?: string;
  eventStartAt?: Date;
  eventJoinLink?: string;
  timestamp: Date;
}

/**
 * Backfills messages handed over by a WhatsApp history sync (see
 * BaileysWhatsAppProvider's onHistorySync) into whichever conversation
 * already represents that contact — reusing an active one if the contact
 * currently has one, otherwise archiving them into a new CLOSED conversation
 * (browsable from Gestão, never surfaced in the live queue). Idempotent by
 * providerMessageId so re-syncs (e.g. every reconnect) never duplicate.
 */
/**
 * unreadChatIds: chats a history sync reported as having unread messages
 * (see BaileysWhatsAppProvider's RECENT sync handling) that this app has
 * never seen before become live queue entries instead of silent CLOSED
 * archives — the same NEW status a brand-new live inbound message gets
 * (see findOrOpenConversationForInboundMessage). A chat in this set whose
 * contact already has an active conversation here (even from a much
 * earlier sync) is left alone: the app already knows about it, so its
 * messages just attach normally below. See PROMPT: "conversas no WhatsApp
 * que não foram lidas não aparecem na fila, pois são conversas que já
 * estavam sem ler antes de conectar o WhatsApp".
 */
export async function importHistoricalMessages(
  connectionId: string,
  messages: HistoricalMessageInput[],
  unreadChatIds: Set<string> = new Set()
): Promise<{ touchedConversationIds: Set<string>; newQueueConversationIds: Set<string> }> {
  const touchedConversationIds = new Set<string>();
  const newQueueConversationIds = new Set<string>();
  for (const m of messages) {
    if (!m.providerMessageId) continue;
    const existing = await prisma.message.findUnique({ where: { providerMessageId: m.providerMessageId } });
    if (existing) {
      // A poll saved without its key (e.g. before 2.25.0) gets it now, so the next votes can be read.
      await fillPollKey(existing.id, m);
      continue;
    }

    const promoteToQueue = Boolean(m.chatId && unreadChatIds.has(m.chatId));
    const contact = await findOrCreateContact(connectionId, m.phone, null, m.chatId);
    let conversation = promoteToQueue
      ? await findActiveConversationForContact(contact.id)
      : await prisma.conversation.findFirst({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: promoteToQueue
          ? {
              contactId: contact.id,
              whatsappConnectionId: connectionId,
              status: "NEW",
              enteredQueueAt: m.timestamp,
              lastMessageAt: m.timestamp,
              createdAt: m.timestamp,
            }
          : {
              contactId: contact.id,
              whatsappConnectionId: connectionId,
              status: "CLOSED",
              enteredQueueAt: m.timestamp,
              closedAt: m.timestamp,
              lastMessageAt: m.timestamp,
              createdAt: m.timestamp,
            },
      });
      if (promoteToQueue) newQueueConversationIds.add(conversation.id);
    }

    const created = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: m.fromMe ? "OUTBOUND" : "INBOUND",
        type: m.type,
        status: m.fromMe ? "SENT" : "DELIVERED",
        body: m.body,
        providerMessageId: m.providerMessageId,
        createdAt: m.timestamp,
      },
    });
    await addHistoricalAttachments(created.id, m);

    // Only ever push activity forward — an old imported message must never
    // make an already-active conversation look "more recently active" than
    // it actually is, or bump its ordering ahead of a genuinely newer one.
    if (m.timestamp > conversation.lastMessageAt) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: m.timestamp,
          lastMessageDirection: m.fromMe ? "OUTBOUND" : "INBOUND",
          ...(m.fromMe ? { awaitingReplySince: null } : {}),
        },
      });
    }
    touchedConversationIds.add(conversation.id);
  }
  return { touchedConversationIds, newQueueConversationIds };
}


/** A history copy of a poll already saved without its key: the key is kept now. */
export async function fillPollKey(messageId: string, m: Pick<HistoricalMessageInput, "type" | "pollSecret" | "pollCreatorJid">): Promise<void> {
  if (m.type !== "POLL" || !m.pollSecret || !m.pollCreatorJid) return;
  await prisma.messageAttachment.updateMany({
    where: { messageId, kind: "POLL", pollSecret: null },
    data: { pollSecret: m.pollSecret, pollCreatorJid: m.pollCreatorJid },
  });
}

/**
 * The attachments a history message carries without a file to download —
 * location, contact card, poll, event. Media from history is never fetched
 * (see BaileysWhatsAppProvider's convertHistoryMessage), only its kind.
 */
export async function addHistoricalAttachments(messageId: string, m: HistoricalMessageInput): Promise<void> {
  if (m.type === "LOCATION" && m.latitude !== undefined && m.longitude !== undefined) {
    await prisma.messageAttachment.create({
      data: { messageId, fileName: "location", mimeType: "application/geo+json", sizeBytes: 0, storageKey: "", kind: "LOCATION", latitude: m.latitude, longitude: m.longitude },
    });
  }
  if (m.vcard) {
    await prisma.messageAttachment.create({
      data: { messageId, fileName: "contact.vcf", mimeType: "text/vcard", sizeBytes: m.vcard.length, storageKey: "", kind: "CONTACT", vcard: m.vcard },
    });
  }
  if (m.type === "POLL") {
    await prisma.messageAttachment.create({
      data: {
        messageId,
        fileName: "poll",
        mimeType: "application/vnd.whatsapp.poll",
        sizeBytes: 0,
        storageKey: "",
        kind: "POLL",
        pollQuestion: m.pollQuestion ?? "",
        pollOptions: m.pollOptions ?? [],
        pollSelectableCount: m.pollSelectableCount,
        pollSecret: m.pollSecret ?? null,
        pollCreatorJid: m.pollCreatorJid ?? null,
      },
    });
  }
  if (m.type === "EVENT") {
    await prisma.messageAttachment.create({
      data: {
        messageId,
        fileName: "event",
        mimeType: "application/vnd.whatsapp.event",
        sizeBytes: 0,
        storageKey: "",
        kind: "EVENT",
        eventName: m.eventName ?? "",
        eventDescription: m.eventDescription,
        eventStartAt: m.eventStartAt,
        eventJoinLink: m.eventJoinLink,
        latitude: m.latitude,
        longitude: m.longitude,
      },
    });
  }
}

/**
 * The earliest message this app already has for a contact (scoped the same
 * way listMessages is — by contact, not by one Conversation row, since a
 * closed-then-reopened contact's history spans several) — the anchor
 * fetchOlderHistory needs to ask WhatsApp for whatever came before it. Only
 * a message that actually reached WhatsApp (has a providerMessageId) can
 * anchor a real request.
 */
export async function getOldestMessageAnchor(
  contactId: string
): Promise<{ providerMessageId: string; fromMe: boolean; timestamp: Date } | null> {
  const message = await prisma.message.findFirst({
    where: { conversation: { contactId }, providerMessageId: { not: null }, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { providerMessageId: true, direction: true, createdAt: true },
  });
  if (!message?.providerMessageId) return null;
  return { providerMessageId: message.providerMessageId, fromMe: message.direction === "OUTBOUND", timestamp: message.createdAt };
}

/**
 * Finds the conversation a new inbound message belongs to, or opens a new
 * one. Section 28 (reabertura): once a conversation is CLOSED, any further
 * message from that contact starts a brand-new conversation record (its own
 * queue entry, its own metrics) rather than silently reopening the closed
 * one — this keeps reporting/"conversas unicas" counts meaningful and gives
 * the agent an explicit new queue card. Default routing target is the
 * queue (not the last agent), per spec section 28's default.
 *
 * HANDLED_EXTERNALLY is deliberately included here, unlike CLOSED/ABANDONED:
 * it isn't a deliberate "this attendance is over" action by an agent, it marks
 * a conversation that lives on the linked phone — started there (the team wrote
 * first), or opened/answered there before anyone accepted it here. It stays
 * there: the customer's next messages go into the SAME row, which keeps its
 * status, instead of a second conversation opening next to it (the one thread
 * listed twice in Gestão, once "Atendido pelo celular" and once in the queue).
 * A conversation belongs to where it began until it is closed; to take a
 * phone one over, Gestão has Devolver para a fila / Transferir. See PROMPT:
 * "caso a conversa tenha sido aberta ou iniciada no celular, deverá permanecer
 * pelo celular".
 *
 * (This replaces two earlier behaviors: the customer's message re-queued that
 * same row, overwriting its Entrada na fila/Aceite, and then it opened a new row
 * on every return, which left the phone one behind forever as a duplicate.)
 */
export async function findActiveConversationForContact(contactId: string) {
  return prisma.conversation.findFirst({
    where: { contactId, status: { in: ["IN_FLOW", "NEW", "WAITING", "FLOW_ABANDONED", "IN_PROGRESS", "TRANSFERRED", "HANDLED_EXTERNALLY"] } },
    orderBy: { createdAt: "desc" },
  });
}

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

type MentionCandidate = { id: string; displayName: string; presence: AgentPresence };

/**
 * Who a customer can name with "@" on this connection: its agents, the
 * managers who receive its conversations (created it, or were granted
 * "receber conversas"), and an admin who works it — the same people who
 * could accept this conversation from the queue. A name from another
 * connection never pulls the customer over to someone who doesn't work
 * this number. Instagram/Messenger have no per-user connection, so there
 * it stays every active agent, as before.
 */
async function mentionCandidates(channel: Channel, connectionId: string | null): Promise<MentionCandidate[]> {
  const select = { id: true, displayName: true, presence: true } as const;
  if (channel !== "WHATSAPP" || !connectionId) {
    return prisma.user.findMany({ where: { role: "AGENT", status: "ACTIVE" }, select });
  }
  return prisma.user.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { role: "AGENT", whatsappConnectionId: connectionId },
        { role: "ADMIN", whatsappConnectionId: connectionId },
        {
          role: "MANAGER",
          OR: [
            { createdConnections: { some: { id: connectionId } } },
            { connectionGrants: { some: { whatsappConnectionId: connectionId, canReceiveConversations: true } } },
          ],
        },
      ],
    },
    select,
  });
}

/** Accents, case and punctuation out: "@Atendente - Gislaine," reads "@atendente gislaine". */
function normalizeMentionText(text: string): string {
  return stripDiacritics(text).toLowerCase().replace(/[^a-z0-9@]+/g, " ").trim();
}

/**
 * The ways a customer can write a person's name in full: the whole display name, and each part of a name
 * registered with a prefix or suffix ("Atendente - Gislaine", "Gislaine | Financeiro").
 */
function fullNameAliases(displayName: string): string[] {
  const parts = displayName.split(/\s*[-–—|/:]\s*|\s*[()[\]]\s*/);
  return [...new Set([displayName, ...parts].map(normalizeMentionText).filter(Boolean))];
}

/** Single words of the name: the first word of each part, and any other word of 3+ letters ("Silva"). */
function nameWordAliases(displayName: string): string[] {
  const words = new Set<string>();
  for (const part of fullNameAliases(displayName)) {
    part.split(" ").forEach((word, i) => {
      if (i === 0 || word.length >= 3) words.add(word);
    });
  }
  return [...words];
}

/**
 * "@<nome>" anywhere in a customer's message routes the conversation
 * straight to that person's "Meus atendimentos" — skipping the queue — see
 * PROMPT: "se caso o cliente enviar uma mensagem com arroba [nome], irá
 * direcionar diretamente para meus atendimentos". Matched only among
 * mentionCandidates (who works this connection), case/accent/punctuation-insensitive:
 *  1. the whole display name ("@João Silva"), or a whole part of a name registered
 *     with a prefix ("@Gislaine" for "Atendente - Gislaine"), the longest one winning;
 *     a non-letter/digit must follow, so "@Joao" doesn't false-match into "@Joaozinho";
 *  2. otherwise one word of the name ("@João" or "@Silva" for "João Silva") — only when
 *     exactly one candidate has it: two "João" (or "@Atendente", shared by everyone)
 *     go to the queue, never a guess;
 *  3. otherwise a small typo (findMentionedAgentByTypo) — see PROMPT: "o
 *     cliente digita @gleici, mas no sistema o nome do atendente está Gleicy".
 *
 * Returns whoever was named regardless of presence — findOrOpenConversationForInboundMessage
 * decides whether that's enough to skip the queue (see PROMPT: "só irá para a
 * fila se o atendente estiver offline").
 */
export async function findMentionedAgent(
  body: string | null | undefined,
  channel: Channel = "WHATSAPP",
  connectionId: string | null = null
): Promise<MentionCandidate | null> {
  if (!body || !body.includes("@")) return null;

  const agents = await mentionCandidates(channel, connectionId);
  if (agents.length === 0) return null;

  const normalizedBody = normalizeMentionText(body);
  const exact = matchMentionedName(normalizedBody, agents, (a) => fullNameAliases(a.displayName));
  if (exact !== undefined) return exact;
  const byWord = matchMentionedName(normalizedBody, agents, (a) => nameWordAliases(a.displayName));
  if (byWord !== undefined) return byWord;
  return findMentionedAgentByTypo(normalizedBody, agents);
}

/**
 * "@<name>" match, the longest name winning. undefined = nobody matched (try
 * the next rule); null = a tie between two people (stop: never guess).
 */
function matchMentionedName(normalizedBody: string, agents: MentionCandidate[], namesOf: (a: MentionCandidate) => string[]): MentionCandidate | null | undefined {
  let best: MentionCandidate | null = null;
  let bestLength = -1;
  let tied = false;

  for (const agent of agents) {
    let longest = -1;
    for (const name of namesOf(agent)) {
      const needle = "@" + name;
      let idx = normalizedBody.indexOf(needle);
      while (idx !== -1) {
        const nextChar = normalizedBody[idx + needle.length];
        if (!nextChar || !/[a-z0-9]/.test(nextChar)) {
          longest = Math.max(longest, needle.length);
          break;
        }
        idx = normalizedBody.indexOf(needle, idx + 1);
      }
    }
    if (longest === -1) continue;

    if (longest > bestLength) {
      best = agent;
      bestLength = longest;
      tied = false;
    } else if (longest === bestLength) {
      tied = true;
    }
  }

  if (tied) return null;
  return best ?? undefined;
}

function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Typo-tolerant fallback for findMentionedAgent, above — only reached when
 * no exact name or name word matched anywhere in the message. Scans every
 * "@word" token in the message against each word of every candidate's name
 * by edit distance, e.g. a customer typing "@gleici" still resolves to an
 * agent whose displayName is "Gleicy" (one substitution), and "@gislane" to
 * "Atendente - Gislaine". Bounded tightly (1 edit for names of 4 letters or
 * fewer, 2 otherwise, and only compared against names within 2 characters of
 * the token's own length) so this stays a typo correction, not a loose fuzzy
 * search that could route a stranger's name to the wrong agent. Same
 * tie-breaks-to-null safety as the exact path: a typo close enough to two
 * different agents isn't a confident enough signal to skip the queue on.
 */
function findMentionedAgentByTypo(
  normalizedBody: string,
  agents: MentionCandidate[]
): MentionCandidate | null {
  const tokens = Array.from(normalizedBody.matchAll(/@([a-z0-9]+)/g), (m) => m[1]);
  if (tokens.length === 0) return null;

  let best: MentionCandidate | null = null;
  let bestDistance = Infinity;
  let tied = false;

  for (const token of tokens) {
    for (const agent of agents) {
      let distance = Infinity;
      for (const name of nameWordAliases(agent.displayName)) {
        if (Math.abs(token.length - name.length) > 2) continue;
        const d = levenshteinDistance(token, name);
        const maxAllowed = name.length <= 4 ? 1 : 2;
        if (d === 0 || d > maxAllowed) continue; // 0 would already have matched exactly above
        distance = Math.min(distance, d);
      }
      if (distance === Infinity) continue;

      if (distance < bestDistance) {
        best = agent;
        bestDistance = distance;
        tied = false;
      } else if (distance === bestDistance && best?.id !== agent.id) {
        tied = true;
      }
    }
  }

  return tied ? null : best;
}

export async function findOrOpenConversationForInboundMessage(
  connectionId: string,
  contactId: string,
  body?: string | null,
  // Defaults to WHATSAPP so the one existing caller (whatsapp.service.ts)
  // needs no change — meta.service.ts passes INSTAGRAM/MESSENGER and a
  // MetaConnection id instead.
  channel: Channel = "WHATSAPP"
) {
  const connectionField = channel === "WHATSAPP" ? { whatsappConnectionId: connectionId } : { metaConnectionId: connectionId };
  // Any open conversation takes the message — one being handled on the linked
  // phone (HANDLED_EXTERNALLY) included, see findActiveConversationForContact.
  // Only bypasses the queue when the mentioned agent is actually ONLINE
  // right now (not AWAY, not OFFLINE) — same bar the dashboard's own
  // "online agora" stat uses. Mentioning someone who isn't around to see it
  // would otherwise strand the conversation assigned to them with nobody
  // watching until they log back in — worse than just queuing it normally,
  // where any available agent (or a manager) can still pick it up. See
  // PROMPT: "só irá para a fila se o atendente estiver offline".
  const findOnlineMention = async () => {
    const mentioned = await findMentionedAgent(body, channel, connectionId);
    return mentioned?.presence === "ONLINE" ? mentioned : null;
  };

  const active = await findActiveConversationForContact(contactId);
  if (active) {
    // Nobody is with this customer yet — waiting in the queue, still in the Fluxo, or on the
    // linked phone ("Atendido pelo celular") — so an "@nome" now still takes it to that person.
    // One already with an agent (IN_PROGRESS/TRANSFERRED) never moves on a customer's say-so.
    const unattended = ["NEW", "WAITING", "IN_FLOW", "FLOW_ABANDONED", "HANDLED_EXTERNALLY"].includes(active.status);
    const mentionedAgent = unattended ? await findOnlineMention() : null;
    if (!mentionedAgent) {
      return { conversation: active, isNewConversation: false, autoAssignedAgentId: null as string | null, flowId: null as string | null, closedMessage: null as string | null };
    }
    if (active.status === "IN_FLOW") await endFlowSession(active.id);
    const now = new Date();
    const [conversation] = await prisma.$transaction([
      prisma.conversation.update({
        where: { id: active.id },
        data: { status: "IN_PROGRESS", assignedAgentId: mentionedAgent.id, acceptedAt: now, firstResponseAt: null, assignedAgentReadAt: null },
      }),
      prisma.conversationAssignment.create({
        data: { conversationId: active.id, fromAgentId: active.assignedAgentId, toAgentId: mentionedAgent.id, reason: "MENTION" },
      }),
      prisma.conversationEvent.create({
        data: { conversationId: active.id, type: "ACCEPTED", payload: { agentId: mentionedAgent.id, autoAssignedByMention: mentionedAgent.displayName, previousStatus: active.status } },
      }),
    ]);
    return { conversation, isNewConversation: false, autoAssignedAgentId: mentionedAgent.id as string | null, flowId: null as string | null, closedMessage: null as string | null };
  }

  // Encerrada por falta de retorno e o cliente voltou: a conversa nova vai direto para o mesmo atendente, se ele está
  // online (senão, fila normal) — com a nota que conta o que aconteceu.
  const lastConversation = await prisma.conversation.findFirst({
    where: { contactId },
    orderBy: { createdAt: "desc" },
    select: { closeReason: true, assignedAgent: { select: { id: true, displayName: true, presence: true, status: true } } },
  });
  const returnedAfterNoReturn = lastConversation?.closeReason === NO_RETURN_CLOSE_REASON;
  const lastAgent = lastConversation?.assignedAgent;
  const mention = await findOnlineMention();
  const mentionedAgent =
    mention ?? (returnedAfterNoReturn && lastAgent?.presence === "ONLINE" && lastAgent.status === "ACTIVE" ? { id: lastAgent.id, displayName: lastAgent.displayName } : null);
  const now = new Date();

  // An active Fluxo on this connection talks to the customer first (see
  // flow-engine.service.ts) — unless they asked for an online agent by name.
  const connectionFlow =
    !mentionedAgent && channel === "WHATSAPP"
      ? await prisma.flowConnection.findFirst({
          where: { whatsappConnectionId: connectionId, flow: { active: true } },
          select: { flowId: true, flow: { select: { nodes: { where: { type: "START" }, select: { data: true } } } } },
        })
      : null;
  // A tag that stops the Fluxo (Etiquetas): the customer goes straight to the queue — recorded below, once the conversation exists.
  const flowBlock = connectionFlow ? await blockingTag(contactId, "FLOW") : null;
  const activeFlow = flowBlock ? null : connectionFlow;
  // A flow that tells the hours itself (Início › avisar fora do horário) replaces the schedule's notice.
  const flowTellsHours = Boolean((activeFlow?.flow.nodes[0]?.data as { outOfHoursPrompt?: boolean } | null)?.outOfHoursPrompt);

  // Outside the hours of the schedule this connection follows (Respostas › Horário de expediente), the customer gets the
  // schedule's notice instead of the Fluxo — once, with the conversation that opens now. Nobody is notified who asked for a named online agent.
  const closedMessage = mentionedAgent || flowTellsHours ? null : await getClosedMessageForConnection(channel, connectionId, now);
  const flowId = closedMessage ? null : (activeFlow?.flowId ?? null);

  const conversation = await prisma.conversation.create({
    data: mentionedAgent
      ? {
          contactId,
          channel,
          ...connectionField,
          status: "IN_PROGRESS",
          assignedAgentId: mentionedAgent.id,
          enteredQueueAt: now,
          acceptedAt: now,
          lastMessageAt: now,
        }
      : { contactId, channel, ...connectionField, status: flowId ? "IN_FLOW" : "NEW", enteredQueueAt: now, lastMessageAt: now },
  });

  if (mentionedAgent) {
    await prisma.$transaction([
      prisma.conversationAssignment.create({
        data: { conversationId: conversation.id, toAgentId: mentionedAgent.id, reason: mention ? "MENTION" : "REOPEN" },
      }),
      prisma.conversationEvent.create({
        data: {
          conversationId: conversation.id,
          type: "CREATED",
          payload: mention ? { autoAssignedByMention: mentionedAgent.displayName } : { returnedAfterNoReturn: mentionedAgent.displayName },
        },
      }),
    ]);
  } else {
    await prisma.conversationEvent.create({
      data: { conversationId: conversation.id, type: "CREATED" },
    });
  }

  if (returnedAfterNoReturn) {
    await prisma.conversationNote.create({ data: { conversationId: conversation.id, body: "Cliente voltou após encerramento por falta de retorno" } });
  }
  if (flowBlock) await recordBlocked(conversation.id, "FLOW", flowBlock);

  return { conversation, isNewConversation: true, autoAssignedAgentId: mentionedAgent?.id ?? null, flowId, closedMessage };
}

/**
 * Same lookup as findOrOpenConversationForInboundMessage, but for a message
 * sent directly from the linked phone/another device (see
 * handleDeviceSentMessage in whatsapp.service.ts). This must never leave a
 * NEW/WAITING conversation sitting in the live queue — that would keep
 * showing a card for a contact the agent is already messaging outside this
 * app. See PROMPT: só deve aparecer na fila quando o cliente envia mensagem.
 *
 * Three cases:
 *  - No active conversation yet: opens straight into HANDLED_EXTERNALLY —
 *    same status markConversationReadFromDevice uses for "being handled on
 *    the phone", visible in Gestão but never in the Fila.
 *  - An active conversation still sitting unassigned in the queue
 *    (NEW/WAITING): replying to it from the phone is just as much "being
 *    handled outside this app" as reading it is, so it gets the exact same
 *    HANDLED_EXTERNALLY transition markConversationReadFromDevice performs
 *    — this used to be skipped entirely (the conversation was returned
 *    untouched), which is why a reply sent from the phone to an
 *    already-queued conversation never made it leave the Fila.
 *  - An active conversation already assigned to an agent (IN_PROGRESS/
 *    TRANSFERRED) — or already HANDLED_EXTERNALLY from an earlier device
 *    reply: left alone, only its read marker is refreshed — replying from
 *    the phone implies the customer's messages up to now have been seen,
 *    same as markConversationReadFromDevice's read-marker-only branch.
 */
export async function findOrOpenConversationForDeviceSentMessage(connectionId: string, contactId: string) {
  const active = await findActiveConversationForContact(contactId);
  if (active) {
    if (active.status === "NEW" || active.status === "WAITING" || active.status === "IN_FLOW") {
      if (active.status === "IN_FLOW") await endFlowSession(active.id);
      const conversation = await prisma.conversation.update({
        where: { id: active.id },
        data: { status: "HANDLED_EXTERNALLY", assignedAgentReadAt: new Date(), startedOnDevice: true },
      });
      await prisma.conversationEvent.create({
        data: { conversationId: conversation.id, type: "HANDLED_EXTERNALLY", payload: { reason: "replied from device" } },
      });
      return { conversation, isNewConversation: false, leftQueue: true };
    }
    const conversation = await prisma.conversation.update({
      where: { id: active.id },
      data: { assignedAgentReadAt: new Date() },
    });
    return { conversation, isNewConversation: false, leftQueue: false };
  }

  const conversation = await prisma.conversation.create({
    data: {
      contactId,
      whatsappConnectionId: connectionId,
      status: "HANDLED_EXTERNALLY",
      startedOnDevice: true,
      enteredQueueAt: new Date(),
      lastMessageAt: new Date(),
      assignedAgentReadAt: new Date(),
    },
  });
  await prisma.conversationEvent.create({
    data: { conversationId: conversation.id, type: "HANDLED_EXTERNALLY", payload: { reason: "started from device" } },
  });
  return { conversation, isNewConversation: true, leftQueue: false };
}

/**
 * An AGENT only ever sees the queue for their own WhatsApp connection.
 * MANAGER/ADMIN have no fixed connection — see PROMPT: "o gestor e
 * administrador também devem ter o menu de atendimentos" — so they pass
 * either a specific set of connections to look at, or undefined for every
 * connection's queue combined (each conversation carries its own connection
 * name/color so they stay distinguishable even mixed together).
 */
export async function listQueue(whatsappConnectionIds?: string[]) {
  const conversations = await prisma.conversation.findMany({
    where: {
      status: { in: ["NEW", "WAITING"] },
      OR: [
        // undefined = no filter (see all); [] must mean "allowed to see
        // none" and match nothing — NOT the same as no filter at all. A
        // MANAGER scoped down to zero connections (see connection-access.ts)
        // must get an empty WhatsApp queue, not everyone's.
        { channel: "WHATSAPP", whatsappConnectionId: whatsappConnectionIds === undefined ? undefined : { in: whatsappConnectionIds } },
        // Instagram/Messenger have no ManagerConnectionAccess equivalent
        // yet (see PROMPT: "prepare tudo para integrar com Instagram e
        // Facebook") — every agent/manager with attendance access sees
        // every Meta conversation, regardless of the WhatsApp-connection
        // filter above.
        { channel: { not: "WHATSAPP" } },
      ],
    },
    include: conversationInclude,
    // Most recently messaged first — matches WhatsApp's own chat-list
    // ordering and "Meus atendimentos" below, instead of FIFO by when the
    // conversation first entered the queue (which never moved a card even
    // after the customer sent a newer follow-up message).
    orderBy: { lastMessageAt: "desc" },
  });
  // A queue conversation is unassigned, so every inbound message on it is
  // by definition still unread by anyone — same getUnreadCounts query
  // "Meus atendimentos" below already uses, just with no agent to compare
  // against yet. Without this, the card's unread-count badge (see
  // ConversationCard) always rendered 0 in the queue.
  const unreadCounts = await getUnreadCounts(conversations.map((c) => c.id));
  return conversations.map((c) => Object.assign(c, { _unreadCount: unreadCounts.get(c.id) ?? 0 }));
}

/**
 * The same customer can already be saved under the other form of a Brazilian
 * mobile — with or without the 9 — and contacts are told apart by the exact
 * number. Starting a conversation under the form not yet saved would create a
 * second contact (and a second history) for the same person, so the existing
 * one is reused. When WhatsApp just confirmed `phone` as the number the account
 * really has, the saved contact is moved to it too, so messages go to the right
 * address from now on.
 */
async function phoneOfExistingContact(connectionId: string, phone: string, confirmedOnWhatsApp: boolean): Promise<string> {
  const variants = brazilianPhoneVariants(phone);
  if (variants.length === 1) return phone;
  const saved = await prisma.contact.findMany({ where: { whatsappConnectionId: connectionId, phone: { in: variants } } });
  if (saved.length === 0 || saved.some((c) => c.phone === phone)) return phone;
  const other = saved[0];
  if (!confirmedOnWhatsApp) return other.phone ?? phone;
  try {
    await prisma.contact.update({ where: { id: other.id }, data: { phone } });
    return phone;
  } catch {
    return other.phone ?? phone; // lost a race for the same number — keep what is saved rather than fail the start
  }
}

/**
 * Agent/manager/admin-initiated conversation, from a contact picked out of
 * the connection's device address book — see PROMPT: "adicionar uma nova
 * conversa através dos contatos salvos no celular de cada instância".
 * Unlike an inbound message, this skips the queue entirely: the initiator
 * is assigning the conversation to themselves from the moment it exists.
 */
export async function startConversation(
  connectionId: string,
  phone: string,
  name: string | null,
  initiatorId: string,
  opts?: { confirmedOnWhatsApp?: boolean }
) {
  const normalizedPhone = phone.replace(/\D/g, "");
  if (!normalizedPhone) throw Errors.badRequest("Numero de telefone invalido");

  // `name` is picked straight from the device address book (see
  // NovaConversaModal) — authoritative over whatever pushName a prior
  // inbound message might have left on an already-existing contact.
  const contactPhone = await phoneOfExistingContact(connectionId, normalizedPhone, opts?.confirmedOnWhatsApp ?? false);
  const contact = await findOrCreateContact(connectionId, contactPhone, name, undefined, { preferIncomingName: true });

  const active = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { in: ["NEW", "WAITING", "IN_PROGRESS", "TRANSFERRED"] } },
    orderBy: { createdAt: "desc" },
  });

  if (active) {
    if (active.assignedAgentId === initiatorId) return getConversationOrThrow(active.id);
    if (active.assignedAgentId) {
      const owner = await prisma.user.findUnique({ where: { id: active.assignedAgentId }, select: { displayName: true } });
      throw Errors.conflict(`Ja existe uma conversa em andamento com este contato, atribuida a ${owner?.displayName ?? "outro atendente"}`);
    }
    // Unassigned (still NEW/WAITING) — starting it is equivalent to accepting it.
    return acceptConversation(active.id, initiatorId);
  }

  const now = new Date();
  const conversation = await prisma.conversation.create({
    data: {
      contactId: contact.id,
      whatsappConnectionId: connectionId,
      status: "IN_PROGRESS",
      assignedAgentId: initiatorId,
      enteredQueueAt: now,
      acceptedAt: now,
      lastMessageAt: now,
    },
  });
  await prisma.$transaction([
    prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "CREATED", payload: { startedByAgentId: initiatorId } } }),
    prisma.conversationAssignment.create({ data: { conversationId: conversation.id, toAgentId: initiatorId, reason: "START" } }),
  ]);
  return getConversationOrThrow(conversation.id);
}

export async function listMyConversations(agentId: string) {
  const conversations = await prisma.conversation.findMany({
    where: { assignedAgentId: agentId, status: { in: ["IN_PROGRESS", "TRANSFERRED"] } },
    include: conversationInclude,
    orderBy: { lastMessageAt: "desc" },
  });
  const unreadCounts = await getUnreadCounts(conversations.map((c) => c.id));
  return conversations.map((c) => Object.assign(c, { _unreadCount: unreadCounts.get(c.id) ?? 0 }));
}

/**
 * Conversations this agent personally transferred away — a dedicated
 * "Transferidas" list beside Fila/Ativos so an agent can see who they sent
 * a conversation to and when, and reopen it read-only to watch it live
 * without being able to act on it (see conversations.routes.ts's
 * "/transferred-out" and ReadOnlyConversationDrawer's reuse for agents).
 * See PROMPT: "função de transferidas ao lado de Fila, para que o
 * atendente saiba para quem transferiu e horário, e possa abrir a
 * conversa para acompanhar em tempo real sem poder interferir".
 *
 * One row per conversation, using the most recent transfer THIS agent
 * initiated for it — even if it has since moved on again to a third agent,
 * that's still the answer to "who did I send it to". A conversation that
 * came back to this same agent since (a revert, or a later transfer back)
 * belongs in Ativos instead, not here.
 *
 * Kept for 7 days from the transfer date, then drops off this list on its
 * own — see PROMPT: "deve manter o histórico de conversas por 7 dias
 * contados pela data da transferência". The conversation itself, and its
 * messages, are never deleted — only this specific "who did I send it to"
 * view ages out.
 */
const TRANSFERRED_OUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function listTransferredOutByAgent(agentId: string) {
  const transfers = await prisma.conversationTransfer.findMany({
    where: { fromAgentId: agentId, createdAt: { gte: new Date(Date.now() - TRANSFERRED_OUT_RETENTION_MS) } },
    orderBy: { createdAt: "desc" },
    include: { toAgent: true },
  });

  const seenConversationIds = new Set<string>();
  const rows: {
    conversation: Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;
    toAgentName: string;
    transferredAt: Date;
    note: string | null;
  }[] = [];
  for (const t of transfers) {
    if (seenConversationIds.has(t.conversationId)) continue; // only the latest transfer I made per conversation
    seenConversationIds.add(t.conversationId);

    const conversation = await prisma.conversation.findUnique({ where: { id: t.conversationId }, include: conversationInclude });
    if (!conversation || conversation.assignedAgentId === agentId) continue;

    rows.push({ conversation, toAgentName: t.toAgent.displayName, transferredAt: t.createdAt, note: t.note });
  }
  return rows;
}

/** Marks a conversation as read by its assigned agent — clears the unread badge. */
export async function markConversationRead(conversationId: string, agentId: string) {
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, assignedAgentId: agentId },
    data: { assignedAgentReadAt: new Date() },
  });
  if (result.count === 0) throw Errors.forbidden("Esta conversa nao pertence a este atendente");
}

/**
 * providerMessageIds of a conversation's still-unread inbound messages —
 * i.e. exactly the ones markConversationRead is about to clear the badge
 * for. Called BEFORE markConversationRead (which bumps assignedAgentReadAt)
 * so it still sees the pre-update cutoff — see whatsapp.service.ts's
 * syncReadReceiptToDevice, which sends WhatsApp read receipts for these so
 * opening a conversation in the app also clears the unread indicator on
 * the linked phone itself, not just in this app.
 */
export async function getUnreadInboundProviderMessageIds(conversationId: string): Promise<string[]> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { assignedAgentReadAt: true },
  });
  if (!conversation) return [];
  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      direction: "INBOUND",
      providerMessageId: { not: null },
      ...(conversation.assignedAgentReadAt ? { createdAt: { gt: conversation.assignedAgentReadAt } } : {}),
    },
    select: { providerMessageId: true },
  });
  return messages.map((m) => m.providerMessageId).filter((id): id is string => Boolean(id));
}

/**
 * Same effect as markConversationRead, but with no agent-ownership check —
 * used only when the WhatsApp provider reports a chat was read from the
 * linked phone itself (see onChatRead in whatsapp.service.ts), which is not
 * an authenticated user action and has no agentId to check against.
 *
 * If the conversation was still unassigned and sitting in the queue
 * (NEW/WAITING), reading it directly on the phone means it's already being
 * handled outside this app — see PROMPT: "quando aberto no celular, deve
 * sair da fila". It leaves the queue (HANDLED_EXTERNALLY) instead of being
 * silently assigned to some agent the phone gives no way to identify;
 * Gestão still shows it, just no longer as "aguardando". A conversation an
 * agent already owns (IN_PROGRESS/TRANSFERRED) is left completely alone —
 * this only ever touches its read marker.
 */
export async function markConversationReadFromDevice(conversationId: string): Promise<{ leftQueue: boolean }> {
  const leftQueue = await prisma.conversation.updateMany({
    where: { id: conversationId, status: { in: ["NEW", "WAITING"] } },
    data: { status: "HANDLED_EXTERNALLY", assignedAgentReadAt: new Date(), startedOnDevice: true },
  });
  if (leftQueue.count > 0) {
    await prisma.conversationEvent.create({
      data: { conversationId, type: "HANDLED_EXTERNALLY" },
    });
    return { leftQueue: true };
  }
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentReadAt: new Date() },
  });
  return { leftQueue: false };
}

export interface OversightFilters {
  from?: Date;
  to?: Date;
  agentId?: string;
  /** One or more statuses (OR'd) — a list so the Dashboard's "Em atendimento" card can deep-link into both IN_PROGRESS and TRANSFERRED at once. */
  status?: string[];
  search?: string;
  /** Empty/undefined = all connections — see PROMPT: filtro podendo selecionar várias ou todas. */
  connectionIds?: string[];
  /** Only these conversations — the Dashboard's "Conversas que chegam ao longo do dia" bar that was clicked. */
  ids?: string[];
}

/**
 * Gestão/Admin oversight listing — full visibility, but callers must still enforce read-only in the route layer.
 *
 * With a period, a conversation belongs to it when anything happened inside it: it
 * started, had a message (either way), or was closed — so "Hoje" shows what is
 * moving today, including a chat that began yesterday and got a message this
 * morning, instead of only the ones created today. Newest activity first.
 */
export async function listAllConversations(filters: OversightFilters) {
  return prisma.conversation.findMany({
    where: oversightWhere(filters),
    include: conversationInclude,
    orderBy: { lastMessageAt: "desc" },
    take: 200,
  });
}

/**
 * Gestão's list, one page at a time: the status filter, the total and each status' count are worked out in the
 * database — not in the browser over a capped list, which hid an open conversation whose last message was older than
 * the newest 200 (the Dashboard counted it, Gestão showed nothing).
 */
export async function listOversightPage(filters: OversightFilters, page: number, pageSize: number) {
  const base = oversightWhere({ ...filters, status: undefined });
  const where: Prisma.ConversationWhereInput = filters.status?.length ? { AND: [base, { status: { in: filters.status as ConversationStatus[] } }] } : base;
  const [items, total, byStatus] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include: conversationInclude,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.conversation.count({ where }),
    prisma.conversation.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
  ]);
  const statusCounts = Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])) as Partial<Record<ConversationStatus, number>>;
  return { items, total, statusCounts };
}

function oversightWhere(filters: OversightFilters): Prisma.ConversationWhereInput {
  const inPeriod = { gte: filters.from, lte: filters.to };
  return {
    assignedAgentId: filters.agentId,
    status: filters.status?.length ? { in: filters.status as any } : undefined,
    AND: [
      // WhatsApp groups have their own tab in Atendimento — never in Gestão.
      { status: { not: "GROUP" } },
      // Same WhatsApp-only-filter + "every Meta conversation regardless"
      // OR shape as listQueue above (see its own comment for why).
      {
        OR: [
          { channel: "WHATSAPP", whatsappConnectionId: filters.connectionIds === undefined ? undefined : { in: filters.connectionIds } },
          { channel: { not: "WHATSAPP" } },
        ],
      },
      ...(filters.from || filters.to ? [{ OR: [{ createdAt: inPeriod }, { lastMessageAt: inPeriod }, { closedAt: inPeriod }] }] : []),
      ...(filters.ids ? [{ id: { in: filters.ids } }] : []),
    ],
    // The customer's name or number, or (from 3 letters) anything written in the conversation.
    OR: filters.search
      ? [
          { contact: { name: { contains: filters.search, mode: "insensitive" } } },
          { contact: { phone: { contains: filters.search } } },
          ...(filters.search.length >= MIN_MESSAGE_SEARCH_LENGTH ? [{ messages: { some: { body: { contains: filters.search, mode: "insensitive" as const } } } }] : []),
        ]
      : undefined,
  };
}

const MIN_MESSAGE_SEARCH_LENGTH = 3;

/** For a Gestão search: the most recent message of each conversation that contains the text, to show where it was found. */
export async function findSearchMatches(conversationIds: string[], search: string): Promise<Map<string, string>> {
  if (search.length < MIN_MESSAGE_SEARCH_LENGTH || conversationIds.length === 0) return new Map();
  const messages = await prisma.message.findMany({
    where: { conversationId: { in: conversationIds }, body: { contains: search, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    distinct: ["conversationId"],
    select: { conversationId: true, body: true },
  });
  return new Map(messages.map((m) => [m.conversationId, m.body ?? ""]));
}

export async function getConversationOrThrow(id: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id }, include: conversationInclude });
  if (!conversation) throw Errors.notFound("Conversa nao encontrada");
  return conversation;
}

/**
 * Folds a spurious duplicate conversation (see the @lid contact-matching
 * fix in findOrCreateContact — pre-existing duplicates from before that fix
 * don't heal on their own) into the real one: every message moves over,
 * `intoConversationId`'s lastMessageAt/lastMessageDirection is recomputed
 * from the merged set, and the duplicate conversation row is deleted so it
 * stops showing up anywhere (Fila, Gestão, Relatórios). If the duplicate
 * belonged to a different Contact row than the real conversation (the usual
 * case — that's exactly what made it a duplicate), every other conversation
 * on that duplicate contact moves over too and the now-empty contact row is
 * removed. Irreversible — either ADMIN-triggered (see conversations.routes.ts)
 * or automatic, via foldActiveConversationDuplicates below.
 */
export async function mergeConversations(duplicateConversationId: string, intoConversationId: string) {
  if (duplicateConversationId === intoConversationId) {
    throw Errors.badRequest("Nao e possivel mesclar uma conversa com ela mesma");
  }
  const [duplicate, into] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: duplicateConversationId } }),
    prisma.conversation.findUnique({ where: { id: intoConversationId } }),
  ]);
  if (!duplicate) throw Errors.notFound("Conversa duplicada nao encontrada");
  if (!into) throw Errors.notFound("Conversa de destino nao encontrada");
  if (duplicate.status === "GROUP" || into.status === "GROUP") throw Errors.badRequest("Grupos do WhatsApp nao podem ser mesclados");
  if (duplicate.whatsappConnectionId !== into.whatsappConnectionId) {
    throw Errors.badRequest("So e possivel mesclar conversas da mesma conexao de WhatsApp");
  }

  await prisma.$transaction(async (tx) => {
    await tx.message.updateMany({ where: { conversationId: duplicate.id }, data: { conversationId: into.id } });

    const latestMessage = await tx.message.findFirst({
      where: { conversationId: into.id },
      orderBy: { createdAt: "desc" },
    });
    if (latestMessage) {
      await tx.conversation.update({
        where: { id: into.id },
        data: { lastMessageAt: latestMessage.createdAt, lastMessageDirection: latestMessage.direction },
      });
    }

    if (duplicate.contactId !== into.contactId) {
      await tx.conversation.updateMany({ where: { contactId: duplicate.contactId }, data: { contactId: into.contactId } });
    }

    await tx.conversationEvent.deleteMany({ where: { conversationId: duplicate.id } });
    await tx.conversationAssignment.deleteMany({ where: { conversationId: duplicate.id } });
    await tx.conversationTransfer.deleteMany({ where: { conversationId: duplicate.id } });
    await tx.conversation.delete({ where: { id: duplicate.id } });

    if (duplicate.contactId !== into.contactId) {
      const remaining = await tx.conversation.count({ where: { contactId: duplicate.contactId } });
      if (remaining === 0) await tx.contact.delete({ where: { id: duplicate.contactId } });
    }
  });

  return getConversationOrThrow(into.id);
}

/**
 * Auto-merge engine, part 2: after findOrCreateContact folds two Contact
 * rows together (the same customer resolved under two different WhatsApp
 * identifiers — see the collision branch above), the survivor can end up
 * owning two simultaneously-active conversations at once, one carried over
 * from each side of the merge. The contacts are unified, but the customer
 * would still show up as two separate cards in Fila/Gestão. This collapses
 * every extra active conversation into a single survivor conversation, using
 * the exact same message-move logic mergeConversations already uses for a
 * manual ADMIN merge.
 *
 * Survivor choice: prefer whichever conversation is already assigned to an
 * agent (IN_PROGRESS/TRANSFERRED) — folding an unassigned queue card into it
 * never orphans an agent's in-progress work; between two equally-assigned
 * (or two equally-unassigned) conversations, keep whichever was messaged
 * most recently.
 */
async function foldActiveConversationDuplicates(contactId: string): Promise<void> {
  // Same status set as findActiveConversationForContact — HANDLED_EXTERNALLY
  // included so a stray duplicate left over from before that fix (or from
  // any other race) still gets folded away instead of lingering forever.
  const actives = await prisma.conversation.findMany({
    where: { contactId, status: { in: ["IN_FLOW", "NEW", "WAITING", "FLOW_ABANDONED", "IN_PROGRESS", "TRANSFERRED", "HANDLED_EXTERNALLY"] } },
  });
  if (actives.length < 2) return;

  const survivor = actives.reduce((best, c) => {
    const bestAssigned = best.assignedAgentId !== null;
    const cAssigned = c.assignedAgentId !== null;
    if (cAssigned !== bestAssigned) return cAssigned ? c : best;
    return c.lastMessageAt > best.lastMessageAt ? c : best;
  });

  for (const c of actives) {
    if (c.id !== survivor.id) await mergeConversations(c.id, survivor.id);
  }
}

/**
 * Enforces PROMPT section 10 (and the later "gestor e administrador também
 * ... poderão atender"): only the assigned agent may open/respond to a
 * conversation — but "agent" now means whichever active user (AGENT,
 * MANAGER or ADMIN) it's actually assigned to, since managers/admins can
 * accept and receive transfers too. Read-only oversight of everyone else's
 * conversations still goes exclusively through the /oversight endpoints,
 * never through this check.
 */
export function assertAgentCanAccessConversation(
  conversation: { assignedAgentId: string | null },
  auth: { userId: string; role: Role }
) {
  if (conversation.assignedAgentId !== auth.userId) throw Errors.forbidden("Esta conversa pertence a outro atendente");
}

/**
 * Who may write to the customer (send, transfer, close as the agent): while a Gestão intervention is on, only the
 * person intervening; otherwise only the assigned agent. The assigned agent keeps reading and leaving notes.
 */
export function assertCanReplyToConversation(conversation: { assignedAgentId: string | null; interventionById: string | null }, userId: string) {
  if (conversation.interventionById) {
    if (conversation.interventionById !== userId) {
      throw Errors.forbidden("Um gestor está intervindo nesta conversa — você pode acompanhar e deixar notas, mas não responder ao cliente");
    }
    return;
  }
  if (conversation.assignedAgentId !== userId) throw Errors.forbidden("Esta conversa pertence a outro atendente");
}

const INTERVENABLE_STATUSES: ConversationStatus[] = ["IN_PROGRESS", "TRANSFERRED"];

async function notifyIntervention(conversationId: string, userId: string, title: string, body: string) {
  const notification = await createNotification({ userId, type: "MESSAGE", title, body, entityType: "Conversation", entityId: conversationId });
  realtimeEvents.notificationCreated(userId, toNotificationDTO(notification));
}

/** Gestão › Intervir: `userId` takes over replying; the assigned agent is told and can only follow and leave notes. */
export async function startIntervention(conversationId: string, userId: string) {
  const existing = await getConversationOrThrow(conversationId);
  if (!INTERVENABLE_STATUSES.includes(existing.status) || !existing.assignedAgentId) {
    throw Errors.badRequest("Só é possível intervir em uma conversa em atendimento");
  }
  if (existing.interventionById === userId) return existing;
  if (existing.interventionById) throw Errors.conflict(`${existing.interventionBy?.displayName ?? "Outro gestor"} já está intervindo nesta conversa`);
  if (existing.assignedAgentId === userId) throw Errors.badRequest("Esta conversa já está com você");

  // Two managers clicking at once: only the first one takes it.
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversationId, interventionById: null },
    data: { interventionById: userId, interventionStartedAt: new Date() },
  });
  if (count === 0) throw Errors.conflict("Outro gestor acabou de intervir nesta conversa");

  const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
  await prisma.$transaction([
    prisma.conversationEvent.create({ data: { conversationId, type: "INTERVENTION_STARTED", payload: { userId, agentId: existing.assignedAgentId } } }),
    prisma.conversationNote.create({ data: { conversationId, authorId: userId, body: `${actor.displayName} começou a intervir nesta conversa. Enquanto isso, só ${actor.displayName} responde ao cliente.` } }),
  ]);
  const contactLabel = existing.contact.name ?? existing.contact.phone ?? "Contato";
  await notifyIntervention(conversationId, existing.assignedAgentId, contactLabel, `${actor.displayName} está intervindo nesta conversa. Você pode acompanhar e deixar notas.`);
  realtimeEvents.interventionChanged(conversationId, [existing.assignedAgentId, userId]);
  return getConversationOrThrow(conversationId);
}

/** "Devolver": the assigned agent replies again. */
export async function endIntervention(conversationId: string, userId: string) {
  const existing = await getConversationOrThrow(conversationId);
  if (!existing.interventionById) throw Errors.badRequest("Esta conversa não está em intervenção");
  const interventorId = existing.interventionById;
  await prisma.conversation.update({ where: { id: conversationId }, data: { interventionById: null, interventionStartedAt: null } });
  const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
  const agentName = existing.assignedAgent?.displayName ?? "o atendente";
  await prisma.$transaction([
    prisma.conversationEvent.create({ data: { conversationId, type: "INTERVENTION_ENDED", payload: { userId, interventorId, agentId: existing.assignedAgentId } } }),
    prisma.conversationNote.create({ data: { conversationId, authorId: userId, body: `${actor.displayName} devolveu a conversa para ${agentName}.` } }),
  ]);
  if (existing.assignedAgentId) {
    const contactLabel = existing.contact.name ?? existing.contact.phone ?? "Contato";
    await notifyIntervention(conversationId, existing.assignedAgentId, contactLabel, `${actor.displayName} devolveu a conversa para você. Você já pode responder.`);
  }
  realtimeEvents.interventionChanged(conversationId, [existing.assignedAgentId, interventorId]);
  return getConversationOrThrow(conversationId);
}

/** A note written during an intervention reaches the other side's bell — the agent alerting the manager, or the other way round. */
export async function notifyInterventionNote(conversationId: string, authorId: string, body: string): Promise<void> {
  const conversation = await getConversationOrThrow(conversationId);
  if (!conversation.interventionById || !conversation.assignedAgentId) return;
  const recipientId = authorId === conversation.interventionById ? conversation.assignedAgentId : conversation.interventionById;
  if (recipientId === authorId) return;
  const author = await prisma.user.findUnique({ where: { id: authorId }, select: { displayName: true } });
  const contactLabel = conversation.contact.name ?? conversation.contact.phone ?? "Contato";
  await notifyIntervention(conversationId, recipientId, `Nota de ${author?.displayName ?? "alguém"} · ${contactLabel}`, body.slice(0, 200));
  realtimeEvents.notesChanged(conversationId, [recipientId]);
}

/**
 * Read-only relaxation of assertAgentCanAccessConversation, above —
 * deliberately used ONLY by the GET .../messages route and the socket's
 * conversation:join, never by anything that sends/transfers/closes. The
 * current owner can always read (same as before); an agent who personally
 * transferred this conversation away can also read it (but not act on
 * it — assertAgentCanAccessConversation still guards every mutating
 * route), so "Transferidas" can watch it live without interfering. See
 * PROMPT: "possa abrir a conversa para acompanhar em tempo real sem poder
 * interferir".
 */
export async function assertAgentCanReadConversation(
  conversation: { id: string; assignedAgentId: string | null },
  auth: { userId: string; role: Role }
): Promise<void> {
  if (conversation.assignedAgentId === auth.userId) return;
  const transferredByMe = await prisma.conversationTransfer.findFirst({
    where: { conversationId: conversation.id, fromAgentId: auth.userId },
    select: { id: true },
  });
  if (!transferredByMe) throw Errors.forbidden("Esta conversa pertence a outro atendente");
}

/**
 * Files in a conversation's history. The message list shows every message of
 * the contact (earlier conversations included — see listMessages), so an
 * agent who can read any conversation of this contact must also be able to
 * open the files in that history, even when they belong to an older
 * conversation that someone else attended.
 */
export async function assertAgentCanReadContactHistory(contactId: string, auth: { userId: string; role: Role }): Promise<void> {
  const readable = await prisma.conversation.findFirst({
    where: {
      contactId,
      OR: [{ assignedAgentId: auth.userId }, { transfers: { some: { fromAgentId: auth.userId } } }],
    },
    select: { id: true },
  });
  if (!readable) throw Errors.forbidden("Esta conversa pertence a outro atendente");
}

/**
 * Atomic accept. Two agents clicking ACCEPT at the same time must never
 * both win: the single UPDATE below is executed as one statement with a
 * WHERE clause that only matches while the conversation is still
 * unassigned, and Postgres guarantees that statement is atomic at the row
 * level. `updateMany`'s returned count tells us, without a separate
 * read-then-write race window, whether we actually won the assignment.
 */
export async function acceptConversation(conversationId: string, agentId: string) {
  // A paused agent keeps full access to whatever is already theirs
  // (Composer, Aceite/Transferência etc. are untouched) — this is the one
  // gate that stops them picking up anything new while away. startConversation
  // also routes through here when the contact already has an unclaimed
  // conversation (see its own "equivalent to accepting it" comment), so
  // this single check covers both the Fila's Aceitar button and that path.
  // See PROMPT: "quando estiver pausado, não permitirá aceitar novas
  // conversas, só poderá responder as existentes".
  const agent = await prisma.user.findUnique({ where: { id: agentId }, select: { presence: true } });
  if (agent?.presence === "AWAY") {
    throw Errors.badRequest("Voce esta pausado — retome o atendimento para aceitar novas conversas");
  }

  const target = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { whatsappConnection: { select: { status: true } }, metaConnection: { select: { status: true } } },
  });
  if (!target) throw Errors.notFound("Conversa nao encontrada");
  const connectionStatus = target.whatsappConnection?.status ?? target.metaConnection?.status;
  if (connectionStatus !== "CONNECTED") {
    throw Errors.badRequest("A conexao esta desconectada — nao e possivel aceitar conversas");
  }

  const now = new Date();
  const fromAbandoned = (await prisma.conversation.findUnique({ where: { id: conversationId }, select: { status: true } }))?.status === "FLOW_ABANDONED";
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, status: { in: ["NEW", "WAITING", "FLOW_ABANDONED"] }, assignedAgentId: null },
    data: { status: "IN_PROGRESS", assignedAgentId: agentId, acceptedAt: now, firstResponseAt: null },
  });

  if (result.count === 0) {
    // Distinguish "doesn't exist" from "someone beat you to it" — writing a
    // ConversationEvent for a nonexistent conversationId would otherwise
    // fail its own foreign key and surface as an opaque 500.
    const exists = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } });
    if (!exists) throw Errors.notFound("Conversa nao encontrada");
    await prisma.conversationEvent.create({
      data: { conversationId, type: "ACCEPT_CONFLICT", payload: { attemptedBy: agentId } },
    });
    throw Errors.conflict("Esta conversa ja foi assumida por outro atendente.");
  }

  await prisma.$transaction([
    prisma.conversationAssignment.create({
      data: { conversationId, toAgentId: agentId, reason: "ACCEPT" },
    }),
    prisma.conversationEvent.create({
      data: { conversationId, type: "ACCEPTED", payload: { agentId } },
    }),
  ]);
  if (fromAbandoned) {
    await noteAbandonedReason(conversationId);
    realtimeEvents.abandonedChanged();
  }

  return getConversationOrThrow(conversationId);
}

/**
 * Abandonados (see the FLOW_ABANDONED status): for an attendant, their connection's and those of the flows whose
 * transfer steps include them; MANAGER/ADMIN pass the connections they may see, like the queue.
 */
export async function listAbandoned(viewer: { userId: string; role: Role; whatsappConnectionId: string | null }, whatsappConnectionIds?: string[]) {
  const visibility: Prisma.ConversationWhereInput =
    viewer.role === "AGENT"
      ? {
          OR: [
            ...(viewer.whatsappConnectionId ? [{ whatsappConnectionId: viewer.whatsappConnectionId }] : []),
            { flowSession: { flowId: { in: await flowIdsWithPerson(viewer.userId) } } },
          ],
        }
      : { whatsappConnectionId: whatsappConnectionIds === undefined ? undefined : { in: whatsappConnectionIds } };
  const conversations = await prisma.conversation.findMany({
    where: { status: "FLOW_ABANDONED", AND: [visibility] },
    include: conversationInclude,
    orderBy: { lastMessageAt: "desc" },
  });
  const unreadCounts = await getUnreadCounts(conversations.map((c) => c.id));
  return conversations.map((c) => Object.assign(c, { _unreadCount: unreadCounts.get(c.id) ?? 0 }));
}

/**
 * Transfer target may be any active user who can attend conversations
 * (AGENT, MANAGER or ADMIN — see PROMPT: "o gestor e administrador também
 * ... poderão ... receber transferências"), regardless of which WhatsApp
 * connection they normally work — see PROMPT: "poderá transferir a
 * conversa para qualquer atendente". If that agent isn't online right now,
 * the conversation gets a 2h pendingTransferDeadline: if they haven't
 * logged in by then, `revertExpiredTransfers` bounces it back to whoever
 * transferred it (see below).
 */
export async function transferConversation(
  conversationId: string,
  fromAgentId: string,
  toAgentId: string,
  initiatedById: string,
  note: string | undefined
) {
  if (fromAgentId === toAgentId) throw Errors.badRequest("Selecione um atendente diferente para transferir");

  const target = await prisma.user.findUnique({ where: { id: toAgentId } });
  if (!target || target.status !== "ACTIVE") {
    throw Errors.badRequest("Atendente de destino invalido");
  }

  const pendingTransferDeadline = target.presence === "ONLINE" ? null : new Date(Date.now() + TRANSFER_OFFLINE_GRACE_MS);

  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, assignedAgentId: fromAgentId, status: { in: ["IN_PROGRESS", "TRANSFERRED"] } },
    // The new agent hasn't read anything yet — clearing assignedAgentReadAt
    // makes every message (including history) count toward their unread badge again.
    data: { status: "TRANSFERRED", assignedAgentId: toAgentId, acceptedAt: new Date(), firstResponseAt: null, assignedAgentReadAt: null, pendingTransferDeadline },
  });
  if (result.count === 0) throw Errors.conflict("Nao foi possivel transferir: conversa ja foi alterada");

  await prisma.$transaction([
    prisma.conversationTransfer.create({
      data: { conversationId, fromAgentId, toAgentId, initiatedById, note },
    }),
    prisma.conversationAssignment.create({
      data: { conversationId, fromAgentId, toAgentId, reason: "TRANSFER" },
    }),
    prisma.conversationEvent.create({
      data: { conversationId, type: "TRANSFERRED", payload: { fromAgentId, toAgentId, note, targetWasOffline: pendingTransferDeadline !== null } },
    }),
  ]);

  return getConversationOrThrow(conversationId);
}

// Same "still active" scope as findActiveConversationForContact — CLOSED/
// ABANDONED are terminal on purpose (see that function's own doc comment)
// and stay out of Gestão's reach here too; a genuinely new conversation for
// that contact is what picks the thread back up from those.
const GESTAO_TRANSFERABLE_STATUSES: ConversationStatus[] = ["IN_FLOW", "NEW", "WAITING", "FLOW_ABANDONED", "IN_PROGRESS", "TRANSFERRED", "HANDLED_EXTERNALLY"];

/**
 * Gestão (MANAGER/ADMIN) directly assigning or reassigning a conversation to
 * an agent. Unlike the agent-initiated transferConversation above — which
 * only ever works from the current owner's own conversation, already
 * IN_PROGRESS/TRANSFERRED — this works from ANY still-active status,
 * including one nobody has ever claimed (NEW/WAITING) or one parked in
 * HANDLED_EXTERNALLY with no agent at all. See PROMPT: "No menu gestão,
 * precisa ter a opção de transferir para algum atendente ou enviar para
 * fila."
 */
export async function assignConversationFromGestao(conversationId: string, toAgentId: string, initiatedById: string) {
  const existing = await getConversationOrThrow(conversationId);
  if (!GESTAO_TRANSFERABLE_STATUSES.includes(existing.status)) {
    throw Errors.badRequest("Esta conversa nao pode ser transferida neste status");
  }
  if (existing.assignedAgentId === toAgentId) {
    throw Errors.badRequest("A conversa ja esta com este atendente");
  }

  const target = await prisma.user.findUnique({ where: { id: toAgentId } });
  if (!target || target.status !== "ACTIVE" || target.role !== "AGENT") {
    throw Errors.badRequest("Atendente de destino invalido");
  }

  if (existing.status === "IN_FLOW") await endFlowSession(conversationId);
  const previousAgentId = existing.assignedAgentId;
  const pendingTransferDeadline = target.presence === "ONLINE" ? null : new Date(Date.now() + TRANSFER_OFFLINE_GRACE_MS);

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      // A conversation that already had an owner keeps reading as a
      // transfer (TRANSFERRED); one nobody had yet reads as a normal
      // pickup (IN_PROGRESS) — same distinction acceptConversation vs.
      // transferConversation already draw, just both reachable from here.
      status: previousAgentId ? "TRANSFERRED" : "IN_PROGRESS",
      assignedAgentId: toAgentId,
      // A Gestão transfer ends an intervention.
      interventionById: null,
      interventionStartedAt: null,
      acceptedAt: new Date(),
      // "1ª resposta" is counted from this acceptance: the new agent's own first reply.
      firstResponseAt: null,
      // The new agent hasn't read anything yet — same as transferConversation.
      assignedAgentReadAt: null,
      pendingTransferDeadline,
    },
  });

  if (previousAgentId) {
    await prisma.$transaction([
      prisma.conversationTransfer.create({
        data: { conversationId, fromAgentId: previousAgentId, toAgentId, initiatedById, note: "Transferido pela Gestão" },
      }),
      prisma.conversationAssignment.create({
        data: { conversationId, fromAgentId: previousAgentId, toAgentId, reason: "TRANSFER" },
      }),
      prisma.conversationEvent.create({
        data: { conversationId, type: "TRANSFERRED", payload: { fromAgentId: previousAgentId, toAgentId, initiatedById, viaGestao: true } },
      }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.conversationAssignment.create({
        data: { conversationId, toAgentId, reason: "MANAGER_ASSIGNED" },
      }),
      prisma.conversationEvent.create({
        data: { conversationId, type: "MANAGER_ASSIGNED", payload: { toAgentId, initiatedById } },
      }),
    ]);
  }
  if (existing.status === "FLOW_ABANDONED") {
    await noteAbandonedReason(conversationId);
    realtimeEvents.abandonedChanged();
  }

  return { conversation: await getConversationOrThrow(conversationId), previousAgentId };
}

/**
 * Gestão (MANAGER/ADMIN) sending a conversation back to the queue,
 * unassigned — same reach as assignConversationFromGestao above, minus a
 * conversation that's already sitting in the queue (nothing to do there).
 */
export async function returnConversationToQueue(conversationId: string, initiatedById: string) {
  const existing = await getConversationOrThrow(conversationId);
  if (existing.status === "NEW" || existing.status === "WAITING") {
    throw Errors.badRequest("Esta conversa ja esta na fila");
  }
  if (!GESTAO_TRANSFERABLE_STATUSES.includes(existing.status)) {
    throw Errors.badRequest("Esta conversa nao pode ser enviada para a fila neste status");
  }

  if (existing.status === "IN_FLOW") await endFlowSession(conversationId);
  const previousAgentId = existing.assignedAgentId;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: "WAITING",
      assignedAgentId: null,
      interventionById: null,
      interventionStartedAt: null,
      acceptedAt: null,
      firstResponseAt: null,
      assignedAgentReadAt: null,
      pendingTransferDeadline: null,
      enteredQueueAt: new Date(),
    },
  });

  await prisma.conversationEvent.create({
    data: { conversationId, type: "RETURNED_TO_QUEUE", payload: { previousAgentId, initiatedById, previousStatus: existing.status } },
  });
  if (existing.status === "FLOW_ABANDONED") realtimeEvents.abandonedChanged();

  return { conversation: await getConversationOrThrow(conversationId), previousAgentId };
}

/**
 * `closingMessage` is the agent's closing message when the survey follows this
 * close: it isn't sent now — the survey keeps it and sends it 10 seconds after
 * the customer's score, or when the wait runs out (see scheduleCloseFollowUp
 * and processDueClosingMessages).
 */
export async function closeConversation(conversationId: string, agentId: string, closingMessage?: HeldClosingMessage) {
  const previous = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { status: true } });
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, assignedAgentId: agentId, status: { in: ["IN_PROGRESS", "TRANSFERRED"] } },
    data: { status: "CLOSED", closedAt: new Date(), closedByUserId: agentId, pendingTransferDeadline: null },
  });
  if (result.count === 0) throw Errors.conflict("Nao foi possivel encerrar esta conversa");

  await prisma.conversationEvent.create({ data: { conversationId, type: "CLOSED", payload: { agentId, previousStatus: previous?.status } } });
  scheduleCloseFollowUp(conversationId, closingMessage);
  return getConversationOrThrow(conversationId);
}

/**
 * Gestão's own close — same GESTAO_TRANSFERABLE_STATUSES scope as
 * transfer/return-to-queue above, unlike closeConversation (agent-only,
 * requires ownership). See PROMPT: "Acrescente em gestão o botão de
 * encerrar".
 *
 * `silent`: "Encerrar sem enviar mensagem" — nothing goes to the customer, so
 * the satisfaction survey isn't sent either (see PROMPT: "selecionado que não
 * envia a mensagem de encerramento, também não é para ser enviado a pesquisa").
 */
export async function closeConversationFromGestao(
  conversationId: string,
  initiatedById: string,
  closingMessage?: HeldClosingMessage,
  options: { silent?: boolean } = {}
) {
  const existing = await getConversationOrThrow(conversationId);
  if (!GESTAO_TRANSFERABLE_STATUSES.includes(existing.status)) {
    throw Errors.badRequest("Esta conversa nao pode ser encerrada neste status");
  }
  if (existing.status === "IN_FLOW") await endFlowSession(conversationId);
  const previousAgentId = existing.assignedAgentId;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "CLOSED", closedAt: new Date(), closedByUserId: initiatedById, pendingTransferDeadline: null, interventionById: null, interventionStartedAt: null },
  });

  await prisma.conversationEvent.create({
    data: { conversationId, type: "CLOSED", payload: { agentId: initiatedById, previousAgentId, previousStatus: existing.status } },
  });
  if (!options.silent) scheduleCloseFollowUp(conversationId, closingMessage);
  if (existing.status === "FLOW_ABANDONED") realtimeEvents.abandonedChanged();

  return { conversation: await getConversationOrThrow(conversationId), previousAgentId };
}

// Slack for the request travelling while the "Desfazer" toast was still up.
const UNDO_GRACE_MS = 5_000;
const REOPENABLE_STATUSES: ConversationStatus[] = ["IN_PROGRESS", "TRANSFERRED"];

/**
 * "Desfazer" right after closing or returning a conversation to the queue:
 * reverts the conversation's latest event, only for whoever did it, only
 * within the undo window, and only while nothing else happened since (no
 * one accepted it from the queue, the customer didn't start a new one).
 */
export async function undoLastConversationAction(conversationId: string, userId: string) {
  const conversation = await getConversationOrThrow(conversationId);
  const event = await prisma.conversationEvent.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" } });
  const payload = (event?.payload ?? {}) as { agentId?: string; initiatedById?: string; previousAgentId?: string | null; previousStatus?: ConversationStatus };
  const actorId = event?.type === "CLOSED" ? payload.agentId : event?.type === "RETURNED_TO_QUEUE" ? payload.initiatedById : undefined;
  const tooLate = !event || Date.now() - event.createdAt.getTime() > CONVERSATION_UNDO_WINDOW_MS + UNDO_GRACE_MS;
  if (!event || actorId !== userId || tooLate) throw Errors.conflict("Não é mais possível desfazer esta ação");

  let restoredStatus: ConversationStatus;
  if (event.type === "CLOSED") {
    if (conversation.status !== "CLOSED") throw Errors.conflict("Não é mais possível desfazer esta ação");
    const newer = await prisma.conversation.count({ where: { contactId: conversation.contactId, createdAt: { gt: conversation.createdAt } } });
    if (newer > 0) throw Errors.conflict("O cliente já iniciou outra conversa");
    // The closing message and the survey are already on their way to the customer — too late to take it back.
    if ((await prisma.satisfactionSurvey.count({ where: { conversationId } })) > 0) throw Errors.conflict("Não é mais possível desfazer esta ação");
    restoredStatus =
      conversation.assignedAgentId && payload.previousStatus && REOPENABLE_STATUSES.includes(payload.previousStatus)
        ? payload.previousStatus
        : conversation.assignedAgentId
          ? "IN_PROGRESS"
          : "NEW";
    await prisma.conversation.update({ where: { id: conversationId }, data: { status: restoredStatus, closedAt: null, closedByUserId: null, closeReason: null } });
  } else {
    if (!payload.previousAgentId) throw Errors.conflict("A conversa não tinha atendente para quem voltar");
    if (conversation.status !== "WAITING" || conversation.assignedAgentId) throw Errors.conflict("A conversa já foi aceita por outra pessoa");
    restoredStatus = payload.previousStatus && REOPENABLE_STATUSES.includes(payload.previousStatus) ? payload.previousStatus : "IN_PROGRESS";
    const now = new Date();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: restoredStatus, assignedAgentId: payload.previousAgentId, acceptedAt: now, firstResponseAt: null },
    });
  }
  await prisma.conversationEvent.create({ data: { conversationId, type: "ACTION_UNDONE", payload: { undone: event.type, by: userId } } });
  return getConversationOrThrow(conversationId);
}

/**
 * Logging in proves the agent is back — cancels the 2h countdown on any
 * conversation transferred to them while they were offline, so
 * revertExpiredTransfers leaves those alone from now on.
 */
export async function clearPendingTransferDeadlines(agentId: string): Promise<void> {
  await prisma.conversation.updateMany({
    where: { assignedAgentId: agentId, pendingTransferDeadline: { not: null } },
    data: { pendingTransferDeadline: null },
  });
}

/**
 * Background sweep (see server.ts) — bounces a transferred conversation
 * back to whoever transferred it if the receiving agent never logged in
 * within the 2h grace window. Origin agent = fromAgentId on the most
 * recent transfer record for that conversation.
 */
export async function revertExpiredTransfers(): Promise<void> {
  const expired = await prisma.conversation.findMany({
    where: { status: "TRANSFERRED", pendingTransferDeadline: { lte: new Date() } },
    include: { transfers: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  for (const conversation of expired) {
    const lastTransfer = conversation.transfers[0];
    if (!lastTransfer) continue; // defensive — should never happen for a TRANSFERRED conversation

    const expiredAgentId = conversation.assignedAgentId;
    const result = await prisma.conversation.updateMany({
      where: { id: conversation.id, status: "TRANSFERRED", pendingTransferDeadline: { lte: new Date() } },
      data: {
        assignedAgentId: lastTransfer.fromAgentId,
        status: "IN_PROGRESS",
        pendingTransferDeadline: null,
        assignedAgentReadAt: null,
      },
    });
    if (result.count === 0) continue; // someone else (e.g. a login) already resolved it

    await prisma.conversationEvent.create({
      data: {
        conversationId: conversation.id,
        type: "TRANSFER_REVERTED",
        payload: { revertedToAgentId: lastTransfer.fromAgentId, expiredAgentId },
      },
    });
    await writeAudit({
      userId: null,
      action: "CONVERSATION_TRANSFER_REVERTED",
      entity: "Conversation",
      entityId: conversation.id,
      metadata: { revertedToAgentId: lastTransfer.fromAgentId, expiredAgentId, reason: "recipient did not log in within 2h" },
    });
    if (expiredAgentId) {
      realtimeEvents.transferReverted(conversation.id, lastTransfer.fromAgentId, expiredAgentId);
    }
  }
}

/**
 * A conversation living on the linked phone (HANDLED_EXTERNALLY) whose customer wrote and got no
 * answer — from the phone or from here — within the connection's deviceReplyTimeoutMinutes goes to
 * the queue, so a customer is never left waiting because nobody picked the phone up. Run every
 * minute by server.ts. Returns the conversations it sent to the queue.
 */
export async function requeueUnansweredDeviceConversations(now = new Date()) {
  const candidates = await prisma.conversation.findMany({
    where: {
      status: "HANDLED_EXTERNALLY",
      awaitingReplySince: { not: null },
      whatsappConnection: { deviceReplyTimeoutMinutes: { not: null } },
    },
    select: {
      id: true,
      awaitingReplySince: true,
      whatsappConnectionId: true,
      whatsappConnection: { select: { deviceReplyTimeoutMinutes: true } },
      contact: { select: { name: true, phone: true } },
    },
  });
  const requeued: { id: string; whatsappConnectionId: string; contactName: string; minutes: number }[] = [];
  for (const c of candidates) {
    const minutes = c.whatsappConnection!.deviceReplyTimeoutMinutes!;
    if (c.awaitingReplySince!.getTime() > now.getTime() - minutes * 60_000) continue;
    // Claimed atomically: an answer from the phone in the meantime clears awaitingReplySince and wins.
    const moved = await prisma.conversation.updateMany({
      where: { id: c.id, status: "HANDLED_EXTERNALLY", awaitingReplySince: c.awaitingReplySince },
      data: { status: "WAITING", enteredQueueAt: now, startedOnDevice: true },
    });
    if (moved.count === 0) continue;
    await prisma.conversationEvent.create({
      data: { conversationId: c.id, type: "RETURNED_TO_QUEUE", payload: { reason: "device conversation unanswered", minutes } },
    });
    await prisma.conversationNote.create({
      data: {
        conversationId: c.id,
        authorId: null,
        body: `Conversa iniciada pelo celular: o cliente ficou ${minutes} min sem resposta e ela veio para a fila.`,
      },
    });
    requeued.push({ id: c.id, whatsappConnectionId: c.whatsappConnectionId!, contactName: c.contact.name ?? c.contact.phone ?? "Cliente", minutes });
  }
  return requeued;
}
