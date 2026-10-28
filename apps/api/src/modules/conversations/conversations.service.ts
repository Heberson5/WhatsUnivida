import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { writeAudit } from "../../lib/audit";
import { realtimeEvents } from "../../realtime/realtime";
import type { Role } from "@prisma/client";

const TRANSFER_OFFLINE_GRACE_MS = 2 * 60 * 60 * 1000; // 2h — see PROMPT: transfer to an offline agent auto-reverts if they don't log in in time.

const conversationInclude = {
  contact: true,
  assignedAgent: true,
  whatsappConnection: true,
  transfers: { orderBy: { createdAt: "desc" as const }, take: 1, include: { fromAgent: true, toAgent: true } },
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
 */
export async function findOrCreateContact(connectionId: string, phone: string, name: string | null, providerChatId?: string) {
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
        data: { lastInteractionAt: new Date(), name: byChatId.name ?? name ?? undefined, phone: resolvedPhone },
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
        // Only overwrite the saved name if we didn't have one yet — an
        // agent-entered/CRM name should not be clobbered by WhatsApp's
        // pushName on every message.
        name: existing.name ?? name ?? undefined,
        providerChatId: existing.providerChatId ?? providerChatId ?? undefined,
      },
    });
  }

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
            data: { phone, providerChatId, lastInteractionAt: new Date(), name: byPriorPhone.name ?? name ?? undefined },
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
export async function importHistoricalMessages(connectionId: string, messages: HistoricalMessageInput[]): Promise<void> {
  for (const m of messages) {
    if (!m.providerMessageId) continue;
    const existing = await prisma.message.findUnique({ where: { providerMessageId: m.providerMessageId } });
    if (existing) continue;

    const contact = await findOrCreateContact(connectionId, m.phone, null, m.chatId);
    let conversation = await prisma.conversation.findFirst({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          contactId: contact.id,
          whatsappConnectionId: connectionId,
          status: "CLOSED",
          enteredQueueAt: m.timestamp,
          closedAt: m.timestamp,
          lastMessageAt: m.timestamp,
          createdAt: m.timestamp,
        },
      });
    }

    await prisma.message.create({
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
    if (m.type === "LOCATION" && m.latitude !== undefined && m.longitude !== undefined) {
      const created = await prisma.message.findUniqueOrThrow({ where: { providerMessageId: m.providerMessageId } });
      await prisma.messageAttachment.create({
        data: { messageId: created.id, fileName: "location", mimeType: "application/geo+json", sizeBytes: 0, storageKey: "", kind: "LOCATION", latitude: m.latitude, longitude: m.longitude },
      });
    }
    if (m.vcard) {
      const created = await prisma.message.findUniqueOrThrow({ where: { providerMessageId: m.providerMessageId } });
      await prisma.messageAttachment.create({
        data: { messageId: created.id, fileName: "contact.vcf", mimeType: "text/vcard", sizeBytes: m.vcard.length, storageKey: "", kind: "CONTACT", vcard: m.vcard },
      });
    }
    if (m.type === "POLL") {
      const created = await prisma.message.findUniqueOrThrow({ where: { providerMessageId: m.providerMessageId } });
      await prisma.messageAttachment.create({
        data: {
          messageId: created.id,
          fileName: "poll",
          mimeType: "application/vnd.whatsapp.poll",
          sizeBytes: 0,
          storageKey: "",
          kind: "POLL",
          pollQuestion: m.pollQuestion ?? "",
          pollOptions: m.pollOptions ?? [],
        },
      });
    }
    if (m.type === "EVENT") {
      const created = await prisma.message.findUniqueOrThrow({ where: { providerMessageId: m.providerMessageId } });
      await prisma.messageAttachment.create({
        data: {
          messageId: created.id,
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

    // Only ever push activity forward — an old imported message must never
    // make an already-active conversation look "more recently active" than
    // it actually is, or bump its ordering ahead of a genuinely newer one.
    if (m.timestamp > conversation.lastMessageAt) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: m.timestamp, lastMessageDirection: m.fromMe ? "OUTBOUND" : "INBOUND" },
      });
    }
  }
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
 * it isn't a deliberate "this attendance is over" action by an agent, just a
 * passive marker that the customer's messages are being handled directly on
 * the linked phone instead of through this app. Treating it as terminal
 * (excluded from "active") used to mean every single message exchanged while
 * a chat sat in that state — inbound from the customer, or another
 * device-sent reply — reopened it into a BRAND NEW Conversation row each
 * time, since neither findOrOpenConversationForInboundMessage nor
 * findOrOpenConversationForDeviceSentMessage below could find the existing
 * one anymore. On any real account where staff sometimes reply straight from
 * the phone, that turned one ongoing WhatsApp thread into dozens of
 * near-empty Conversation rows — see PROMPT: "em Gestão ... está trazendo
 * mais de uma linha para a mesma conversa, isso significa que a cada
 * mensagem recebida ou enviada, está acrescentando uma nova linha".
 */
export async function findActiveConversationForContact(contactId: string) {
  return prisma.conversation.findFirst({
    where: { contactId, status: { in: ["NEW", "WAITING", "IN_PROGRESS", "TRANSFERRED", "HANDLED_EXTERNALLY"] } },
    orderBy: { createdAt: "desc" },
  });
}

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * "@<nome de exibição>" anywhere in a customer's first message routes the
 * new conversation straight to that agent's "Meus atendimentos" — skipping
 * the queue entirely — see PROMPT: "se caso o cliente enviar uma mensagem
 * com arroba [nome], irá direcionar diretamente para meus atendimentos".
 * Case/accent-insensitive substring match against every active AGENT's
 * displayName (never MANAGER/ADMIN — explicitly agent-only per that same
 * conversation), scored so the longest matching name wins when one name is
 * a prefix of another (e.g. "@Joao" alongside a "João Silva" on the roster).
 * Requires a non-letter/digit right after the matched name (or end of
 * string) so "@Joao" doesn't false-match into "@Joaozinho". Zero or
 * genuinely ambiguous (same-length tie) matches return null — the
 * conversation falls through to the normal queue, same as no mention at all.
 */
export async function findMentionedAgent(body: string | null | undefined): Promise<{ id: string; displayName: string } | null> {
  if (!body || !body.includes("@")) return null;

  const agents = await prisma.user.findMany({
    where: { role: "AGENT", status: "ACTIVE" },
    select: { id: true, displayName: true },
  });
  if (agents.length === 0) return null;

  const normalizedBody = stripDiacritics(body).toLowerCase();
  let best: { id: string; displayName: string } | null = null;
  let bestLength = -1;
  let tied = false;

  for (const agent of agents) {
    const needle = "@" + stripDiacritics(agent.displayName).toLowerCase();
    const idx = normalizedBody.indexOf(needle);
    if (idx === -1) continue;
    const nextChar = normalizedBody[idx + needle.length];
    if (nextChar && /[a-z0-9]/i.test(nextChar)) continue; // e.g. "@Joaozinho" must not match agent "Joao"

    if (needle.length > bestLength) {
      best = agent;
      bestLength = needle.length;
      tied = false;
    } else if (needle.length === bestLength) {
      tied = true;
    }
  }

  return tied ? null : best;
}

export async function findOrOpenConversationForInboundMessage(connectionId: string, contactId: string, body?: string | null) {
  const active = await findActiveConversationForContact(contactId);
  if (active) return { conversation: active, isNewConversation: false, autoAssignedAgentId: null as string | null };

  const mentionedAgent = await findMentionedAgent(body);
  const now = new Date();
  const conversation = await prisma.conversation.create({
    data: mentionedAgent
      ? {
          contactId,
          whatsappConnectionId: connectionId,
          status: "IN_PROGRESS",
          assignedAgentId: mentionedAgent.id,
          enteredQueueAt: now,
          acceptedAt: now,
          lastMessageAt: now,
        }
      : { contactId, whatsappConnectionId: connectionId, status: "NEW", enteredQueueAt: now, lastMessageAt: now },
  });

  if (mentionedAgent) {
    await prisma.$transaction([
      prisma.conversationAssignment.create({
        data: { conversationId: conversation.id, toAgentId: mentionedAgent.id, reason: "MENTION" },
      }),
      prisma.conversationEvent.create({
        data: { conversationId: conversation.id, type: "CREATED", payload: { autoAssignedByMention: mentionedAgent.displayName } },
      }),
    ]);
  } else {
    await prisma.conversationEvent.create({
      data: { conversationId: conversation.id, type: "CREATED" },
    });
  }

  return { conversation, isNewConversation: true, autoAssignedAgentId: mentionedAgent?.id ?? null };
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
    if (active.status === "NEW" || active.status === "WAITING") {
      const conversation = await prisma.conversation.update({
        where: { id: active.id },
        data: { status: "HANDLED_EXTERNALLY", assignedAgentReadAt: new Date() },
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
export async function listQueue(connectionIds?: string[]) {
  const conversations = await prisma.conversation.findMany({
    where: {
      // undefined = no filter (see all); [] must mean "allowed to see
      // none" and match nothing — NOT the same as no filter at all. A
      // MANAGER scoped down to zero connections (see connection-access.ts)
      // must get an empty queue, not everyone's.
      whatsappConnectionId: connectionIds === undefined ? undefined : { in: connectionIds },
      status: { in: ["NEW", "WAITING"] },
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
 * Agent/manager/admin-initiated conversation, from a contact picked out of
 * the connection's device address book — see PROMPT: "adicionar uma nova
 * conversa através dos contatos salvos no celular de cada instância".
 * Unlike an inbound message, this skips the queue entirely: the initiator
 * is assigning the conversation to themselves from the moment it exists.
 */
export async function startConversation(connectionId: string, phone: string, name: string | null, initiatorId: string) {
  const normalizedPhone = phone.replace(/\D/g, "");
  if (!normalizedPhone) throw Errors.badRequest("Numero de telefone invalido");

  const contact = await findOrCreateContact(connectionId, normalizedPhone, name);

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
    data: { status: "HANDLED_EXTERNALLY", assignedAgentReadAt: new Date() },
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
  status?: string;
  contactSearch?: string;
  /** Empty/undefined = all connections — see PROMPT: filtro podendo selecionar várias ou todas. */
  connectionIds?: string[];
}

/** Gestão/Admin oversight listing — full visibility, but callers must still enforce read-only in the route layer. */
export async function listAllConversations(filters: OversightFilters) {
  return prisma.conversation.findMany({
    where: {
      createdAt: filters.from || filters.to ? { gte: filters.from, lte: filters.to } : undefined,
      assignedAgentId: filters.agentId,
      status: filters.status ? (filters.status as any) : undefined,
      // Same undefined-vs-empty-array distinction as listQueue above.
      whatsappConnectionId: filters.connectionIds === undefined ? undefined : { in: filters.connectionIds },
      contact: filters.contactSearch
        ? {
            OR: [
              { name: { contains: filters.contactSearch, mode: "insensitive" } },
              { phone: { contains: filters.contactSearch } },
            ],
          }
        : undefined,
    },
    include: conversationInclude,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
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
    where: { contactId, status: { in: ["NEW", "WAITING", "IN_PROGRESS", "TRANSFERRED", "HANDLED_EXTERNALLY"] } },
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
 * Atomic accept. Two agents clicking ACCEPT at the same time must never
 * both win: the single UPDATE below is executed as one statement with a
 * WHERE clause that only matches while the conversation is still
 * unassigned, and Postgres guarantees that statement is atomic at the row
 * level. `updateMany`'s returned count tells us, without a separate
 * read-then-write race window, whether we actually won the assignment.
 */
export async function acceptConversation(conversationId: string, agentId: string) {
  const target = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { whatsappConnection: { select: { status: true } } },
  });
  if (!target) throw Errors.notFound("Conversa nao encontrada");
  if (target.whatsappConnection.status !== "CONNECTED") {
    throw Errors.badRequest("A conexao de WhatsApp esta desconectada — nao e possivel aceitar conversas");
  }

  const now = new Date();
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, status: { in: ["NEW", "WAITING"] }, assignedAgentId: null },
    data: { status: "IN_PROGRESS", assignedAgentId: agentId, acceptedAt: now },
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

  return getConversationOrThrow(conversationId);
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
    data: { status: "TRANSFERRED", assignedAgentId: toAgentId, acceptedAt: new Date(), assignedAgentReadAt: null, pendingTransferDeadline },
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

export async function closeConversation(conversationId: string, agentId: string) {
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, assignedAgentId: agentId, status: { in: ["IN_PROGRESS", "TRANSFERRED"] } },
    data: { status: "CLOSED", closedAt: new Date(), closedByUserId: agentId, pendingTransferDeadline: null },
  });
  if (result.count === 0) throw Errors.conflict("Nao foi possivel encerrar esta conversa");

  await prisma.conversationEvent.create({ data: { conversationId, type: "CLOSED", payload: { agentId } } });
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
