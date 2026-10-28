import type { Channel, ConversationStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { realtimeEvents } from "../../realtime/realtime";
import { contactIdsBlocking, enqueueAutoMessage, isBlocked } from "../../lib/auto-messages";
import { sendOutboundTextViaChannel } from "../messages/send-via-channel";
import { getNoReturnSettings } from "../settings/settings.service";
import { getConnectionSchedule, isWorkScheduleOpen } from "../work-schedules/work-schedules.service";
import { renderAutoMessageTemplate, ROLE_LABEL } from "../auto-message-templates/auto-message-templates.service";
import { getConversationOrThrow, NO_RETURN_CLOSE_REASON } from "./conversations.service";
import { scheduleCloseFollowUp, willSendSurveyOnClose, type HeldClosingMessage } from "../satisfaction/satisfaction.service";
import { getActiveClosingMessageForAgent } from "../closing-messages/closing-messages.service";
import { copyReplyMediaFile, type HeldReplyMedia } from "../../lib/reply-media";

const OPEN_STATUSES: ConversationStatus[] = ["IN_PROGRESS", "TRANSFERRED"];

type Conversation = Awaited<ReturnType<typeof getConversationOrThrow>>;

/** A "falta de retorno" text with its tags filled for this conversation. */
function renderNoReturnText(conversation: Conversation, template: string): string {
  const agent = conversation.assignedAgent!;
  return renderAutoMessageTemplate(template, {
    atendente: agent.displayName,
    atendenteNome: agent.fullName,
    atendenteCargo: ROLE_LABEL[agent.role],
    cliente: conversation.contact.name ?? conversation.contact.phone ?? "",
    primeiroNome: conversation.contact.firstName,
  });
}

/**
 * Queues one of the "falta de retorno" texts, recorded as the assigned agent's but WITHOUT the "*Nome:*" on top — an
 * automatic message never carries the agent's name. It waits its 3–10 seconds: the reminder is dropped if the customer
 * answers meanwhile, the closing text if the conversation is taken up again.
 */
async function sendNoReturnText(conversation: Conversation, template: string, condition: "OPEN_AWAITING_CUSTOMER" | "CLOSED") {
  await enqueueAutoMessage({
    conversationId: conversation.id,
    kind: "NO_RETURN",
    text: renderNoReturnText(conversation, template),
    senderAgentId: conversation.assignedAgent!.id,
    senderDisplayName: null,
    condition,
  });
}

/**
 * What follows the survey's thanks when the customer does give a score: the agent's own closing message (Respostas ›
 * Encerramento), never the "como não tivemos retorno" text — or nothing, when the agent has none.
 */
async function agentClosingMessage(conversation: Conversation): Promise<{ text: string | null; media?: HeldReplyMedia | null }> {
  const closing = await getActiveClosingMessageForAgent(conversation.assignedAgentId!, conversation.whatsappConnectionId);
  if (!closing) return { text: null };
  return { text: renderNoReturnText(conversation, closing.text), media: copyReplyMediaFile(closing) };
}

/**
 * "Encerrar por falta de retorno": the customer gets the no-return message and the close counts for the assigned agent
 * like any other — kept apart by closeReason in the reports. `byUserId` null = the automatic close. With "Enviar a
 * pesquisa de satisfação" on (and a survey for the connection) the survey follows, and the no-return message waits for
 * the score like any closing message; survey and message go without the agent's name.
 */
export async function closeForNoReturn(conversationId: string, byUserId: string | null) {
  const conversation = await getConversationOrThrow(conversationId);
  if (!OPEN_STATUSES.includes(conversation.status) || !conversation.assignedAgentId) throw Errors.conflict("Esta conversa não está em atendimento");
  if (await hasPendingScheduledMessage(conversationId)) {
    throw Errors.conflict("Esta conversa tem mensagem agendada. O encerramento por falta de retorno fica bloqueado até ela ser enviada ou cancelada.");
  }
  const agentId = conversation.assignedAgentId;

  const settings = await getNoReturnSettings();
  // A tag that stops falta de retorno: the attendant may still close it by hand, but no message goes out.
  const blocked = await isBlocked(conversation, "NO_RETURN");
  let heldClosingMessage: HeldClosingMessage | undefined;
  let sendCloseText = false;
  if (blocked) {
    // Nothing to send.
  } else if (settings.sendSurvey && conversation.channel === "WHATSAPP" && (await willSendSurveyOnClose(conversationId))) {
    heldClosingMessage = {
      kind: "NO_RETURN",
      text: renderNoReturnText(conversation, settings.closeText),
      senderId: agentId,
      senderDisplayName: null,
      whenAnswered: await agentClosingMessage(conversation),
    };
  } else {
    sendCloseText = true;
  }
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      closedByUserId: agentId,
      closeReason: NO_RETURN_CLOSE_REASON,
      noReturnReminderAt: null,
      noReturnCloseAt: null,
      noReturnHold: false,
      pendingTransferDeadline: null,
      interventionById: null,
      interventionStartedAt: null,
    },
  });
  await prisma.conversationEvent.create({
    data: { conversationId, type: "CLOSED", payload: { agentId, previousStatus: conversation.status, reason: NO_RETURN_CLOSE_REASON, automatic: !byUserId } },
  });
  await prisma.conversationNote.create({
    data: {
      conversationId,
      authorId: byUserId,
      body: byUserId ? "Encerrada por falta de retorno do cliente" : "Encerrada automaticamente por falta de retorno do cliente",
    },
  });
  // Once closed, so the "still closed?" check before sending holds.
  if (sendCloseText) await sendNoReturnText(conversation, settings.closeText, "CLOSED");
  realtimeEvents.conversationClosed(conversationId, agentId);
  if (conversation.interventionById) realtimeEvents.conversationClosed(conversationId, conversation.interventionById);
  if (heldClosingMessage) scheduleCloseFollowUp(conversationId, heldClosingMessage);
  return getConversationOrThrow(conversationId);
}

async function hasPendingScheduledMessage(conversationId: string): Promise<boolean> {
  return (await prisma.scheduledMessage.count({ where: { conversationId, sentAt: null, canceledAt: null, failedAt: null } })) > 0;
}

/**
 * A scheduled message pauses the "falta de retorno" countdown. Scheduling one clears the deadlines already running
 * (a reminder that went out must not close the conversation later); when the last pending one is canceled or fails,
 * the countdown starts over from that moment — a sent one restarts it on its own, like any message the agent writes.
 */
export async function pauseNoReturnForScheduledMessage(conversationId: string) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { noReturnReminderAt: null, noReturnCloseAt: null } });
}

export async function restartNoReturnAfterScheduledMessage(conversationId: string, now = new Date()) {
  if (await hasPendingScheduledMessage(conversationId)) return;
  const settings = await getNoReturnSettings();
  await prisma.conversation.updateMany({
    where: { id: conversationId, status: { in: OPEN_STATUSES }, lastMessageDirection: "OUTBOUND" },
    data: { noReturnReminderAt: new Date(now.getTime() + settings.reminderMinutes * 60_000), noReturnCloseAt: null },
  });
}

/** "Não encerrar automaticamente" / "Manter aberta": no automatic close until the customer answers (or the agent turns it off). */
export async function setNoReturnHold(conversationId: string, hold: boolean) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: hold ? { noReturnHold: true, noReturnReminderAt: null, noReturnCloseAt: null } : { noReturnHold: false },
  });
  return getConversationOrThrow(conversationId);
}

let lastTickAt: number | null = null;

/**
 * server.ts's once-a-minute sweep for the automatic mode. After the agent's last message the customer has
 * reminderMinutes to answer before the reminder goes out, then closeMinutes before the conversation closes — both
 * deadlines are pushed forward while the connection is outside its work schedule, so only expediente counts. Never
 * runs on a conversation whose last word is the customer's, with a pending "lembrar de retornar" or scheduled
 * message, or that the agent put on "Não encerrar automaticamente".
 */
export async function processNoReturnConversations(now = new Date()): Promise<void> {
  const elapsedMs = lastTickAt === null ? 0 : Math.max(0, now.getTime() - lastTickAt);
  lastTickAt = now.getTime();
  const settings = await getNoReturnSettings();
  if (!settings.enabled) return;

  const conversations = await prisma.conversation.findMany({
    where: {
      status: { in: OPEN_STATUSES },
      assignedAgentId: { not: null },
      interventionById: null,
      lastMessageDirection: "OUTBOUND",
      noReturnHold: false,
      contact: { isGroup: false },
      conversationReminders: { none: { firedAt: null } },
      scheduledMessages: { none: { sentAt: null, canceledAt: null, failedAt: null } },
    },
    select: { id: true, contactId: true, channel: true, whatsappConnectionId: true, metaConnectionId: true, lastMessageAt: true, noReturnReminderAt: true, noReturnCloseAt: true },
  });
  // Customers with a tag that stops falta de retorno: never reminded nor closed automatically (recorded once per conversation).
  const blockedContacts = new Set(await contactIdsBlocking("NO_RETURN"));

  const openByConnection = new Map<string, boolean>();
  const isOpen = async (channel: Channel, connectionId: string) => {
    if (!openByConnection.has(connectionId)) {
      const schedule = await getConnectionSchedule(channel, connectionId);
      openByConnection.set(connectionId, !schedule || (await isWorkScheduleOpen(schedule, now)));
    }
    return openByConnection.get(connectionId)!;
  };

  for (const c of conversations) {
    try {
      if (blockedContacts.has(c.contactId)) {
        await isBlocked(c, "NO_RETURN", { once: true });
        if (c.noReturnReminderAt || c.noReturnCloseAt) await prisma.conversation.update({ where: { id: c.id }, data: { noReturnReminderAt: null, noReturnCloseAt: null } });
        continue;
      }
      let reminderAt = c.noReturnReminderAt ?? (c.noReturnCloseAt ? null : new Date(c.lastMessageAt.getTime() + settings.reminderMinutes * 60_000));
      let closeAt = c.noReturnCloseAt;
      if (!(await isOpen(c.channel, c.whatsappConnectionId ?? c.metaConnectionId!))) {
        if (reminderAt) reminderAt = new Date(reminderAt.getTime() + elapsedMs);
        if (closeAt) closeAt = new Date(closeAt.getTime() + elapsedMs);
        await prisma.conversation.update({ where: { id: c.id }, data: { noReturnReminderAt: reminderAt, noReturnCloseAt: closeAt } });
        continue;
      }
      if (closeAt) {
        if (closeAt <= now) await closeForNoReturn(c.id, null);
      } else if (reminderAt && reminderAt <= now) {
        await sendNoReturnText(await getConversationOrThrow(c.id), settings.reminderText, "OPEN_AWAITING_CUSTOMER");
        await prisma.conversation.update({
          where: { id: c.id },
          data: { noReturnReminderAt: null, noReturnCloseAt: new Date(now.getTime() + settings.closeMinutes * 60_000) },
        });
      } else if (!c.noReturnReminderAt) {
        await prisma.conversation.update({ where: { id: c.id }, data: { noReturnReminderAt: reminderAt } });
      }
    } catch (err) {
      logger.error({ err, conversationId: c.id }, "falta de retorno: failed to process conversation");
    }
  }
}

/** Test hook: the sweep remembers when it last ran to stop the clock outside expediente. */
export function resetNoReturnClock() {
  lastTickAt = null;
}
