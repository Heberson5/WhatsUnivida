import fs from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { replyMediaKind, type AutoMessageBlockDTO, type AutoMessageKind } from "@whatsatendende/types";
import { prisma } from "./prisma";
import { env } from "../config/env";
import { logger } from "./logger";
import type { HeldReplyMedia } from "./reply-media";
import { realtimeEvents } from "../realtime/realtime";
import { addAttachment, createSystemOutboundMessage } from "../modules/messages/messages.service";

/**
 * Automatic messages: the tags that stop them (Etiquetas › "Não enviar estas mensagens automáticas"), the record of
 * every one a tag stopped (Relatórios › Mensagens automáticas bloqueadas), and the 3–10 seconds each one waits before
 * going out — so the customer is not answered by a machine the instant they write. Aceite, Transferência and the Fluxo
 * never wait.
 */

// ---------------------------------------------------------------------------
// Tags that block

/** The tag of this contact that stops this kind of message, if any. */
export async function blockingTag(contactId: string, kind: AutoMessageKind): Promise<{ id: string; name: string } | null> {
  const row = await prisma.contactTag.findFirst({
    where: { contactId, tag: { blockedAutoMessages: { has: kind } } },
    select: { tag: { select: { id: true, name: true } } },
    orderBy: { tag: { name: "asc" } },
  });
  return row?.tag ?? null;
}

/** Contacts with a tag that stops this kind of message (e.g. SURVEY: left out of the NPS). */
export async function contactIdsBlocking(kind: AutoMessageKind): Promise<string[]> {
  const rows = await prisma.contactTag.findMany({ where: { tag: { blockedAutoMessages: { has: kind } } }, select: { contactId: true }, distinct: ["contactId"] });
  return rows.map((r) => r.contactId);
}

/** Records that a tag stopped this message, for the report. `once`: not again for the same conversation and kind. */
export async function recordBlocked(conversationId: string, kind: AutoMessageKind, tag: { id: string; name: string }, options: { once?: boolean } = {}) {
  if (options.once && (await prisma.autoMessageBlockLog.count({ where: { conversationId, kind } })) > 0) return;
  await prisma.autoMessageBlockLog.create({ data: { conversationId, kind, tagId: tag.id, tagName: tag.name } });
}

/** Checks the tags and, when one blocks, records it. True = do not send. */
export async function isBlocked(conversation: { id: string; contactId: string }, kind: AutoMessageKind, options: { once?: boolean } = {}): Promise<boolean> {
  const tag = await blockingTag(conversation.contactId, kind);
  if (!tag) return false;
  await recordBlocked(conversation.id, kind, tag, options);
  return true;
}

/** For the conversation list: what this customer does not get, and which tag says so. */
export function autoMessageBlocksOf(tags: { tag: { name: string; blockedAutoMessages: string[] } }[] | undefined): AutoMessageBlockDTO[] {
  const blocks: AutoMessageBlockDTO[] = [];
  for (const { tag } of tags ?? []) {
    for (const kind of tag.blockedAutoMessages) {
      if (!blocks.some((b) => b.kind === kind)) blocks.push({ kind: kind as AutoMessageKind, tagName: tag.name });
    }
  }
  return blocks;
}

/** Prisma include for a conversation's contact with all its tags: shown on the attendance card, and the ones that block something. */
export const CONTACT_CARD_TAGS = {
  tags: { orderBy: { tag: { name: "asc" } }, select: { tag: { select: { id: true, name: true, color: true, blockedAutoMessages: true } } } },
} as const;

/** Prisma include for a conversation's contact with the tags that block something. */
export const CONTACT_BLOCKING_TAGS = {
  tags: { where: { tag: { blockedAutoMessages: { isEmpty: false } } }, select: { tag: { select: { name: true, blockedAutoMessages: true } } } },
} as const;

// ---------------------------------------------------------------------------
// The 3–10 seconds

/**
 * When it may still go out: CLOSED — the conversation is still closed (a "Desfazer" drops it); OPEN_AWAITING_CUSTOMER —
 * still being attended and the last word is ours (the customer answered = dropped); IN_QUEUE — still waiting in the
 * queue; ANY — always.
 */
export type AutoMessageCondition = "CLOSED" | "OPEN_AWAITING_CUSTOMER" | "IN_QUEUE" | "ANY";

export interface AutoMessageJob {
  conversationId: string;
  kind: AutoMessageKind;
  text: string;
  media?: HeldReplyMedia | null;
  /** Sent as this agent (the row shows their name) — closing and falta de retorno. */
  senderAgentId?: string | null;
  /** The "*Nome:*" on top; null = without it. */
  senderDisplayName?: string | null;
  /** Sent by the system itself ("SURVEY", "WORK_SCHEDULE", "QUEUE_WAIT") — no agent, the conversation's last message is not touched. */
  automatedBy?: string | null;
  condition: AutoMessageCondition;
}

let delayRange: [number, number] = env.NODE_ENV === "test" ? [0, 0] : [3_000, 10_000];

/** Tests: the wait (ms). [0, 0] sends at once, in the same call. */
export function setAutoMessageDelayForTests(range: [number, number]) {
  delayRange = range;
}

const randomDelay = () => delayRange[0] + Math.floor(Math.random() * (delayRange[1] - delayRange[0] + 1));

/**
 * Queues an automatic message to go out in 3–10 seconds, after any other still waiting in the same conversation
 * (they keep their order). Returns when it is due. With no wait (tests), it goes out right here.
 */
export async function enqueueAutoMessage(job: AutoMessageJob, now = new Date()): Promise<Date> {
  const delay = randomDelay();
  const previous = await prisma.pendingAutoMessage.findFirst({
    where: { conversationId: job.conversationId, resolvedAt: null },
    orderBy: { dueAt: "desc" },
    select: { dueAt: true },
  });
  const dueAt = new Date(Math.max(now.getTime() + delay, previous ? previous.dueAt.getTime() + 1_000 : 0));
  const { conversationId, kind, ...payload } = job;
  const row = await prisma.pendingAutoMessage.create({ data: { conversationId, kind, dueAt, payload: payload as unknown as Prisma.InputJsonValue } });
  if (delay === 0 && !previous) await deliverPending(row.id, dueAt);
  else setTimeout(() => void processDueAutoMessages().catch((err) => logger.error({ err }, "failed to send automatic messages")), dueAt.getTime() - now.getTime() + 50).unref();
  return dueAt;
}

/** Whether one of this kind is already waiting in the conversation (e.g. the out-of-hours notice goes once). */
export async function hasPendingAutoMessage(conversationId: string, kind: AutoMessageKind): Promise<boolean> {
  return (await prisma.pendingAutoMessage.count({ where: { conversationId, kind, resolvedAt: null } })) > 0;
}

/** Sends every automatic message whose wait is over, oldest first. Run every second by server.ts (and right on time). */
export async function processDueAutoMessages(now = new Date()): Promise<number> {
  const due = await prisma.pendingAutoMessage.findMany({
    where: { resolvedAt: null, dueAt: { lte: now } },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    select: { id: true },
    take: 50,
  });
  let sent = 0;
  for (const { id } of due) if ((await deliverPending(id, now)) === "SENT") sent += 1;
  return sent;
}

async function stillFits(condition: AutoMessageCondition, conversation: { status: string; lastMessageDirection: string | null; noReturnHold: boolean }) {
  switch (condition) {
    case "CLOSED":
      return conversation.status === "CLOSED";
    case "OPEN_AWAITING_CUSTOMER":
      return ["IN_PROGRESS", "TRANSFERRED"].includes(conversation.status) && conversation.lastMessageDirection === "OUTBOUND" && !conversation.noReturnHold;
    case "IN_QUEUE":
      return conversation.status === "NEW" || conversation.status === "WAITING";
    default:
      return true;
  }
}

async function deliverPending(id: string, now: Date): Promise<string | null> {
  // Claimed first, so two sweeps never send the same message.
  const claimed = await prisma.pendingAutoMessage.updateMany({ where: { id, resolvedAt: null }, data: { resolvedAt: now, outcome: "SENDING" } });
  if (claimed.count === 0) return null;
  const finish = async (outcome: string) => {
    await prisma.pendingAutoMessage.update({ where: { id }, data: { outcome } });
    return outcome;
  };
  try {
    const row = await prisma.pendingAutoMessage.findUniqueOrThrow({
      where: { id },
      select: {
        kind: true,
        payload: true,
        conversation: {
          select: {
            id: true,
            contactId: true,
            status: true,
            channel: true,
            whatsappConnectionId: true,
            assignedAgentId: true,
            lastMessageDirection: true,
            noReturnHold: true,
            contact: { select: { phone: true, externalUserId: true } },
          },
        },
      },
    });
    const job = row.payload as unknown as Omit<AutoMessageJob, "conversationId" | "kind">;
    const { conversation } = row;
    if (!(await stillFits(job.condition, conversation))) return await finish("CANCELED_NO_LONGER_FITS");
    if (await isBlocked(conversation, row.kind as AutoMessageKind)) return await finish("BLOCKED");
    const sentOk = await send(conversation, job);
    return await finish(sentOk ? "SENT" : "FAILED");
  } catch (err) {
    logger.error({ err, id }, "failed to send an automatic message");
    await finish("FAILED").catch(() => undefined);
    return "FAILED";
  }
}

type SendConversation = {
  id: string;
  channel: "WHATSAPP" | "INSTAGRAM" | "MESSENGER";
  whatsappConnectionId: string | null;
  assignedAgentId: string | null;
  contact: { phone: string | null; externalUserId: string | null };
};

async function send(conversation: SendConversation, job: Omit<AutoMessageJob, "conversationId" | "kind">): Promise<boolean> {
  // Instagram/Messenger: the text only.
  const media = conversation.channel === "WHATSAPP" ? (job.media ?? null) : null;
  const type = (media && replyMediaKind(media.mimeType)) || "TEXT";
  const message = job.automatedBy
    ? await prisma.message.create({ data: { conversationId: conversation.id, direction: "OUTBOUND", type, status: "PENDING", body: job.text, automatedBy: job.automatedBy } })
    : await createSystemOutboundMessage({ conversationId: conversation.id, type, body: job.text, agentId: job.senderAgentId ?? undefined, allowClosed: true });
  const senderName = job.senderDisplayName ?? null;
  // Loaded here, not at the top: the WhatsApp and Meta services import this module too.
  const whatsappService = await import("../modules/whatsapp/whatsapp.service");
  const { sendMetaMessage } = await import("../modules/meta/meta.service");
  let result: { status?: string } | void | null;
  if (conversation.channel !== "WHATSAPP") {
    result = await sendMetaMessage(conversation.channel, message.id, conversation.contact.externalUserId!, job.text);
  } else if (!conversation.whatsappConnectionId || !conversation.contact.phone) {
    return false;
  } else if (media) {
    await addAttachment(message.id, { fileName: media.fileName, mimeType: media.mimeType, sizeBytes: media.sizeBytes, storageKey: media.storageKey, kind: type as "IMAGE" | "VIDEO" | "DOCUMENT" });
    const buffer = fs.readFileSync(path.join(env.UPLOAD_DIR, media.storageKey));
    result = await whatsappService.sendOutboundFile(conversation.whatsappConnectionId, message.id, conversation.contact.phone, buffer, media.fileName, media.mimeType, senderName, job.text);
  } else if (job.automatedBy) {
    result = await whatsappService.sendAutomatedText(conversation.whatsappConnectionId, message.id, conversation.contact.phone, job.text);
  } else {
    result = await whatsappService.sendOutboundText(conversation.whatsappConnectionId, message.id, conversation.contact.phone, job.text, senderName);
  }
  realtimeEvents.newMessage(conversation.id, conversation.assignedAgentId);
  return !(result && typeof result === "object" && result.status === "FAILED");
}

/** The out-of-hours notice of the connection's Horário de expediente — once, even if the customer sends several messages meanwhile. */
export async function sendOutOfHoursNotice(conversation: { id: string; contactId: string }, text: string): Promise<void> {
  if (await isBlocked(conversation, "OUT_OF_HOURS")) return;
  if (await hasPendingAutoMessage(conversation.id, "OUT_OF_HOURS")) return;
  await enqueueAutoMessage({ conversationId: conversation.id, kind: "OUT_OF_HOURS", text, automatedBy: "WORK_SCHEDULE", condition: "ANY" });
}
