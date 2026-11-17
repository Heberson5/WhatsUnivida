import type { Role } from "@prisma/client";
import type { AgentExtrasDTO, ConversationReminderDTO, MyDayDTO, ScheduledMessageDTO } from "@whatsatendende/types";
import { goalProgress, goalsForUser } from "../goals/goals.service";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { resolvePeriod } from "../../lib/period";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { assertAgentCanAccessConversation, assertCanReplyToConversation, getConversationOrThrow } from "../conversations/conversations.service";
import { createOutboundMessage, createOutboundMessageAfterClose } from "../messages/messages.service";
import { getBusinessSettings } from "../settings/settings.service";
import { firstResponseDiffs, SCHEDULE_SELECT } from "../../lib/conversation-timings";
import { pauseNoReturnForScheduledMessage, restartNoReturnAfterScheduledMessage } from "../conversations/no-return.service";
import * as whatsappService from "../whatsapp/whatsapp.service";
import * as metaService from "../meta/meta.service";
import { calculateNps, npsExcludedContactIds } from "../satisfaction/satisfaction.service";

const OPEN_STATUSES = ["IN_PROGRESS", "TRANSFERRED"] as const;

/** The conversation exists and this person may work on it (an attendant: only their own). */
export async function assertCanUseConversation(conversationId: string, auth: { userId: string; role: Role }) {
  const conversation = await getConversationOrThrow(conversationId);
  if (auth.role === "AGENT") assertAgentCanAccessConversation(conversation, auth);
  return conversation;
}

const toReminderDTO = (r: { id: string; conversationId: string; remindAt: Date; note: string | null; firedAt: Date | null }): ConversationReminderDTO => ({
  id: r.id,
  conversationId: r.conversationId,
  remindAt: r.remindAt.toISOString(),
  note: r.note,
  firedAt: r.firedAt?.toISOString() ?? null,
});

const toScheduledDTO = (m: { id: string; conversationId: string; body: string; sendAt: Date }): ScheduledMessageDTO => ({
  id: m.id,
  conversationId: m.conversationId,
  body: m.body,
  sendAt: m.sendAt.toISOString(),
});

export async function getExtras(userId: string): Promise<AgentExtrasDTO> {
  const [pins, reminders, scheduled] = await Promise.all([
    prisma.conversationPin.findMany({ where: { userId }, select: { conversationId: true } }),
    prisma.conversationReminder.findMany({ where: { userId }, orderBy: { remindAt: "asc" } }),
    prisma.scheduledMessage.findMany({ where: { userId, sentAt: null, canceledAt: null, failedAt: null }, orderBy: { sendAt: "asc" } }),
  ]);
  return {
    pinnedConversationIds: pins.map((p) => p.conversationId),
    reminders: reminders.map(toReminderDTO),
    scheduledMessages: scheduled.map(toScheduledDTO),
  };
}

export async function setPinned(userId: string, conversationId: string, pinned: boolean) {
  if (pinned) {
    await prisma.conversationPin.upsert({ where: { userId_conversationId: { userId, conversationId } }, create: { userId, conversationId }, update: {} });
  } else {
    await prisma.conversationPin.deleteMany({ where: { userId, conversationId } });
  }
}

export async function createReminder(userId: string, input: { conversationId: string; remindAt: Date; note?: string | null }) {
  if (input.remindAt.getTime() <= Date.now()) throw Errors.badRequest("Escolha um horário no futuro.");
  const reminder = await prisma.conversationReminder.create({
    data: { userId, conversationId: input.conversationId, remindAt: input.remindAt, note: input.note?.trim() || null },
  });
  return toReminderDTO(reminder);
}

export async function snoozeReminder(userId: string, id: string, minutes: number) {
  const reminder = await prisma.conversationReminder.findFirst({ where: { id, userId } });
  if (!reminder) throw Errors.notFound("Lembrete não encontrado.");
  const updated = await prisma.conversationReminder.update({ where: { id }, data: { remindAt: new Date(Date.now() + minutes * 60_000), firedAt: null } });
  return toReminderDTO(updated);
}

export async function deleteReminder(userId: string, id: string) {
  await prisma.conversationReminder.deleteMany({ where: { id, userId } });
}

/** Every reminder whose time came: a notice in the bell and a pop-up for its attendant. */
export async function fireDueReminders(now = new Date()) {
  const due = await prisma.conversationReminder.findMany({
    where: { firedAt: null, remindAt: { lte: now } },
    include: { conversation: { select: { status: true, assignedAgentId: true, contact: { select: { name: true, phone: true } } } } },
    take: 100,
  });
  for (const reminder of due) {
    // The conversation was closed or went to someone else meanwhile — nothing left to return to.
    const { status, assignedAgentId } = reminder.conversation;
    if (!(OPEN_STATUSES as readonly string[]).includes(status) || assignedAgentId !== reminder.userId) {
      await prisma.conversationReminder.deleteMany({ where: { id: reminder.id } });
      realtimeEvents.agentExtrasChanged(reminder.userId);
      continue;
    }
    // Claimed atomically — two API processes never both notify.
    const claimed = await prisma.conversationReminder.updateMany({ where: { id: reminder.id, firedAt: null }, data: { firedAt: now } });
    if (claimed.count === 0) continue;
    const who = reminder.conversation.contact.name ?? reminder.conversation.contact.phone ?? "o cliente";
    const notification = await createNotification({
      userId: reminder.userId,
      type: "CONVERSATION_REMINDER",
      title: `Hora de retornar para ${who}`,
      body: reminder.note,
      entityType: "Conversation",
      entityId: reminder.conversationId,
    });
    realtimeEvents.notificationCreated(reminder.userId, toNotificationDTO(notification));
    realtimeEvents.reminderDue(reminder.userId, { ...toReminderDTO({ ...reminder, firedAt: now }), contactName: who });
  }
}

/** Configurações › Fila › Mensagens agendadas, with the defaults filled in and the interval always min ≤ max. */
export async function scheduledMessageSettings() {
  const s = await getBusinessSettings();
  const min = Number(s.scheduledIntervalMinSeconds ?? 30);
  return {
    sendAfterClose: s.scheduledSendAfterClose === true,
    intervalMinSeconds: min,
    intervalMaxSeconds: Math.max(min, Number(s.scheduledIntervalMaxSeconds ?? 80)),
    maxPerContact: Number(s.scheduledMaxPerContact ?? 2),
  };
}

const PENDING = { sentAt: null, canceledAt: null, failedAt: null } as const;

export async function scheduleMessage(userId: string, input: { conversationId: string; body: string; sendAt: Date }) {
  if (input.sendAt.getTime() <= Date.now()) throw Errors.badRequest("Escolha um horário no futuro.");
  const { maxPerContact } = await scheduledMessageSettings();
  const { contactId } = await prisma.conversation.findUniqueOrThrow({ where: { id: input.conversationId }, select: { contactId: true } });
  // Counted and created under a lock on the customer: two clicks (or two attendants) at once never pass the limit.
  const message = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduled:${contactId}`}))`;
    const pending = await tx.scheduledMessage.count({ where: { ...PENDING, conversation: { contactId } } });
    if (pending >= maxPerContact) {
      throw Errors.badRequest(
        maxPerContact === 1
          ? "Este cliente já tem uma mensagem agendada. Cancele o agendamento antes de criar outro."
          : `Este cliente já tem ${pending} mensagens agendadas — o limite é ${maxPerContact}. Cancele uma antes de agendar outra.`
      );
    }
    return tx.scheduledMessage.create({ data: { userId, ...input } });
  });
  await pauseNoReturnForScheduledMessage(input.conversationId);
  return toScheduledDTO(message);
}

export async function cancelScheduledMessage(userId: string, id: string) {
  const scheduled = await prisma.scheduledMessage.findFirst({ where: { id, userId }, select: { conversationId: true } });
  const canceled = await prisma.scheduledMessage.updateMany({ where: { id, userId, sentAt: null, canceledAt: null, failedAt: null }, data: { canceledAt: new Date() } });
  if (canceled.count === 0) throw Errors.notFound("Mensagem agendada não encontrada ou já enviada.");
  await restartNoReturnAfterScheduledMessage(scheduled!.conversationId);
}

// Pacing of the scheduled sends: when each connection may send the next one. Kept in the database, so a restart never
// lets two go out back to back.
const PACING_KEY = "scheduledMessagesPacing";

async function loadPacing(): Promise<Record<string, string>> {
  const row = await prisma.systemSetting.findUnique({ where: { key: PACING_KEY } });
  return (row?.value as Record<string, string> | null) ?? {};
}

async function savePacing(pacing: Record<string, string>) {
  await prisma.systemSetting.upsert({ where: { key: PACING_KEY }, update: { value: pacing }, create: { key: PACING_KEY, value: pacing } });
}

const randomSeconds = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * Sends each scheduled message whose time came, as its attendant — same path as typing it in Atendimento.
 *
 * - One at a time per connection, with a random pause between `intervalMinSeconds` and `intervalMaxSeconds` after
 *   each one (Configurações › Fila): many messages due at the same minute go out spread, never in a burst. One that
 *   has to wait stays scheduled and goes on a later sweep, in the order they were due.
 * - With "enviar mesmo com o atendimento encerrado" on, a message whose conversation was closed goes out anyway,
 *   recorded in that conversation — unless the customer is already in another conversation (queue, flow, assistant
 *   or another attendant): then it fails, so nobody is talked over.
 * - Otherwise one the attendant can no longer send (conversation closed or handed to someone else, connection down)
 *   fails and is reported in the bell.
 */
export async function sendDueScheduledMessages(now = new Date()) {
  const due = await prisma.scheduledMessage.findMany({
    where: { ...PENDING, sendAt: { lte: now } },
    include: { user: { select: { displayName: true } } },
    orderBy: [{ sendAt: "asc" }, { createdAt: "asc" }],
    take: 50,
  });
  if (!due.length) return;
  const settings = await scheduledMessageSettings();
  const pacing = await loadPacing();
  const busy = new Set<string>();
  for (const scheduled of due) {
    const conversation = await getConversationOrThrow(scheduled.conversationId).catch(() => null);
    const connectionKey = conversation ? ((conversation.channel === "WHATSAPP" ? conversation.whatsappConnectionId : conversation.metaConnectionId) ?? "none") : "none";

    // First: can it go out at all? One that can't fails at once (it never waits for the pause).
    let problem: string | null = null;
    let afterClose = false;
    if (!conversation) {
      problem = "A conversa não existe mais.";
    } else if (conversation.status === "CLOSED" && settings.sendAfterClose) {
      // The customer came back meanwhile: their new conversation is someone's (or the queue's) now.
      const active = await prisma.conversation.findFirst({
        where: { contactId: conversation.contactId, id: { not: conversation.id }, status: { notIn: ["CLOSED", "ABANDONED"] }, createdAt: { gt: conversation.createdAt } },
        select: { id: true },
      });
      if (active) problem = "O cliente já está em outro atendimento.";
      else afterClose = true;
    } else {
      try {
        assertCanReplyToConversation(conversation, scheduled.userId);
        if (!(OPEN_STATUSES as readonly string[]).includes(conversation.status)) problem = "A conversa não está mais em atendimento.";
      } catch (err) {
        problem = err instanceof Error ? err.message : "Não foi possível enviar.";
      }
    }
    if (!problem && conversation) {
      const connectionStatus = conversation.channel === "WHATSAPP" ? conversation.whatsappConnection?.status : conversation.metaConnection?.status;
      if (connectionStatus !== "CONNECTED") problem = "A conexão está desconectada.";
    }

    // Then: it can — but this connection sent one a moment ago. It stays scheduled and goes after the pause, in order.
    if (!problem && (busy.has(connectionKey) || (pacing[connectionKey] && Date.parse(pacing[connectionKey]) > now.getTime()))) {
      busy.add(connectionKey);
      continue;
    }

    const claimed = await prisma.scheduledMessage.updateMany({ where: { id: scheduled.id, ...PENDING }, data: { sentAt: now } });
    if (claimed.count === 0) continue;
    let attempted = false;
    try {
      if (problem || !conversation) throw Errors.badRequest(problem ?? "Não foi possível enviar.");
      const message = afterClose
        ? await createOutboundMessageAfterClose({ conversationId: conversation.id, agentId: scheduled.userId, body: scheduled.body })
        : await createOutboundMessage({ conversationId: conversation.id, agentId: scheduled.userId, type: "TEXT", body: scheduled.body });
      attempted = true;
      if (conversation.channel === "WHATSAPP") {
        await whatsappService.sendOutboundText(conversation.whatsappConnectionId!, message.id, conversation.contact.phone!, scheduled.body, scheduled.user.displayName);
      } else {
        await metaService.sendMetaMessage(conversation.channel, message.id, conversation.contact.externalUserId!, scheduled.body);
      }
      realtimeEvents.newMessage(conversation.id, scheduled.userId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Não foi possível enviar.";
      logger.warn({ err, scheduledMessageId: scheduled.id }, "a scheduled message could not be sent");
      await prisma.scheduledMessage.update({ where: { id: scheduled.id }, data: { sentAt: null, failedAt: now, failedReason: reason } });
      await restartNoReturnAfterScheduledMessage(scheduled.conversationId, now).catch(() => undefined);
      const notification = await createNotification({
        userId: scheduled.userId,
        type: "SCHEDULED_MESSAGE_FAILED",
        title: "A mensagem agendada não foi enviada",
        body: `${reason} Texto: "${scheduled.body.slice(0, 120)}"`,
        entityType: "Conversation",
        entityId: scheduled.conversationId,
      });
      realtimeEvents.notificationCreated(scheduled.userId, toNotificationDTO(notification));
    }
    // Whatever reached the connection counts for the pause; a message refused before that does not hold the next one.
    if (attempted) {
      busy.add(connectionKey);
      pacing[connectionKey] = new Date(now.getTime() + randomSeconds(settings.intervalMinSeconds, settings.intervalMaxSeconds) * 1000).toISOString();
      await savePacing(pacing);
    }
    realtimeEvents.agentExtrasChanged(scheduled.userId);
  }
}

export async function getMyDay(userId: string, tzOffsetMinutes: number): Promise<MyDayDTO> {
  const today = resolvePeriod("today", undefined, undefined, tzOffsetMinutes);
  const month = resolvePeriod("month", undefined, undefined, tzOffsetMinutes);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { whatsappConnectionId: true } });
  const [closedToday, firstResponses, scores, goals] = await Promise.all([
    prisma.conversation.count({ where: { assignedAgentId: userId, status: "CLOSED", closedAt: { gte: today.from, lte: today.to } } }),
    prisma.conversation.findMany({
      where: { assignedAgentId: userId, firstResponseAt: { gte: today.from, lte: today.to }, acceptedAt: { not: null } },
      select: { acceptedAt: true, firstResponseAt: true, ...SCHEDULE_SELECT },
    }),
    prisma.satisfactionSurvey.groupBy({
      by: ["score"],
      where: { agentId: userId, score: { not: null }, questionId: { not: null }, sentAt: { gte: month.from, lte: month.to }, contactId: { notIn: await npsExcludedContactIds() } },
      _count: { _all: true },
    }),
    goalsForUser(userId, user.whatsappConnectionId),
  ]);
  // Only the Horário de expediente counts.
  const diffs = await firstResponseDiffs(firstResponses);
  const distribution = Array<number>(11).fill(0);
  for (const row of scores) if (row.score !== null) distribution[row.score] += row._count._all;
  const values = {
    closedToday,
    avgFirstResponseMs: diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null,
    npsThisMonth: calculateNps(distribution).nps,
  };
  return { ...values, goals: goals.map((goal) => goalProgress(goal, values)) };
}
