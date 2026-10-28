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
import { createOutboundMessage } from "../messages/messages.service";
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

export async function scheduleMessage(userId: string, input: { conversationId: string; body: string; sendAt: Date }) {
  if (input.sendAt.getTime() <= Date.now()) throw Errors.badRequest("Escolha um horário no futuro.");
  const message = await prisma.scheduledMessage.create({ data: { userId, ...input } });
  await pauseNoReturnForScheduledMessage(input.conversationId);
  return toScheduledDTO(message);
}

export async function cancelScheduledMessage(userId: string, id: string) {
  const scheduled = await prisma.scheduledMessage.findFirst({ where: { id, userId }, select: { conversationId: true } });
  const canceled = await prisma.scheduledMessage.updateMany({ where: { id, userId, sentAt: null, canceledAt: null, failedAt: null }, data: { canceledAt: new Date() } });
  if (canceled.count === 0) throw Errors.notFound("Mensagem agendada não encontrada ou já enviada.");
  await restartNoReturnAfterScheduledMessage(scheduled!.conversationId);
}

/**
 * Sends each scheduled message whose time came, as its attendant — same path as typing it in Atendimento. One the
 * attendant can no longer send (conversation closed or handed to someone else, connection down) fails and is
 * reported in the bell instead.
 */
export async function sendDueScheduledMessages(now = new Date()) {
  const due = await prisma.scheduledMessage.findMany({
    where: { sentAt: null, canceledAt: null, failedAt: null, sendAt: { lte: now } },
    include: { user: { select: { displayName: true } } },
    take: 50,
  });
  for (const scheduled of due) {
    const claimed = await prisma.scheduledMessage.updateMany({ where: { id: scheduled.id, sentAt: null, canceledAt: null, failedAt: null }, data: { sentAt: now } });
    if (claimed.count === 0) continue;
    try {
      const conversation = await getConversationOrThrow(scheduled.conversationId);
      assertCanReplyToConversation(conversation, scheduled.userId);
      if (!(OPEN_STATUSES as readonly string[]).includes(conversation.status)) throw Errors.badRequest("A conversa não está mais em atendimento.");
      const connectionStatus = conversation.channel === "WHATSAPP" ? conversation.whatsappConnection?.status : conversation.metaConnection?.status;
      if (connectionStatus !== "CONNECTED") throw Errors.badRequest("A conexão está desconectada.");
      const message = await createOutboundMessage({ conversationId: conversation.id, agentId: scheduled.userId, type: "TEXT", body: scheduled.body });
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
