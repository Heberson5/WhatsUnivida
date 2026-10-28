import { prisma } from "./prisma";
import { getBusinessSettings } from "../modules/settings/settings.service";
import { realtimeEvents } from "../realtime/realtime";
import { conversationSpanMs, SCHEDULE_SELECT } from "./conversation-timings";
import { cachedHolidayLookup } from "./business-time";
import { queueAudiences } from "./queue-routing";

const REMINDER_CADENCE_KEY = "queueReminderLastSentAt";

/**
 * Gate for server.ts's once-a-minute timer — the admin-configured
 * queueReminderIntervalMinutes (default 1) decides how often this actually
 * fires, independent of how often the outer setInterval ticks. Same
 * cadence-marker pattern as holidays.service.ts's runHolidaySyncIfDue.
 * See PROMPT: "notificações a cada um minuto quando tem conversas na
 * fila... parametrizado quanto tempo deverá ser notificado".
 */
export async function sendQueueRemindersIfDue(): Promise<void> {
  const { queueReminderIntervalMinutes } = await getBusinessSettings();
  const intervalMs = (Number(queueReminderIntervalMinutes) || 1) * 60_000;

  const marker = await prisma.systemSetting.findUnique({ where: { key: REMINDER_CADENCE_KEY } });
  const lastSentAt = marker ? new Date((marker.value as { at: string }).at) : null;
  const dueAt = lastSentAt ? new Date(lastSentAt.getTime() + intervalMs) : new Date(0);
  if (new Date() < dueAt) return;

  // Scoped to WhatsApp only — Meta (Instagram/Messenger) channels have no
  // per-connection agent assignment on User to notify against. See PROMPT's
  // plan artifact, "Resumo do escopo".
  const waitingConversations = await prisma.conversation.findMany({
    where: { status: { in: ["NEW", "WAITING"] }, channel: "WHATSAPP", whatsappConnectionId: { not: null } },
    select: { id: true, contactId: true, channel: true, whatsappConnectionId: true },
  });
  // Etiquetas › "Atendida por": a customer reserved for someone online only counts for them.
  const audiences = await queueAudiences(waitingConversations);
  const waiting = [...new Set(waitingConversations.map((c) => c.whatsappConnectionId!))].map((whatsappConnectionId) => ({
    whatsappConnectionId,
    conversations: waitingConversations.filter((c) => c.whatsappConnectionId === whatsappConnectionId),
  }));
  // Nothing waiting — leave the marker untouched so a conversation arriving
  // a second later reminds right away instead of waiting out this cycle.
  if (waiting.length === 0) return;

  const connections = await prisma.whatsAppConnection.findMany({
    where: { id: { in: waiting.map((w) => w.whatsappConnectionId!) } },
    select: { id: true, name: true },
  });
  const connectionNames = new Map(connections.map((c) => [c.id, c.name]));

  for (const { whatsappConnectionId, conversations } of waiting) {
    const connectionId = whatsappConnectionId!;
    const connectionName = connectionNames.get(connectionId) ?? connectionId;
    // Only genuinely ONLINE agents — AWAY (any pause reason) and OFFLINE are
    // both excluded. See PROMPT: "para os atendentes que estão com pausa,
    // não deverão ser notificados, independente da pausa. Só deverão ser
    // notificados os que realmente estiverem online."
    const agents = await prisma.user.findMany({
      where: { role: "AGENT", status: "ACTIVE", presence: "ONLINE", whatsappConnectionId: connectionId },
      select: { id: true },
    });
    for (const agent of agents) {
      const count = conversations.filter((c) => {
        const audience = audiences.get(c.id);
        return !audience || audience.has(agent.id);
      }).length;
      if (count > 0) realtimeEvents.queueReminder(agent.id, connectionId, connectionName, count);
    }
  }

  await prisma.systemSetting.upsert({
    where: { key: REMINDER_CADENCE_KEY },
    update: { value: { at: new Date().toISOString() } },
    create: { key: REMINDER_CADENCE_KEY, value: { at: new Date().toISOString() } },
  });
}

const NO_REPLY_CADENCE_KEY = "noReplyReminderLastSentAt";

/**
 * Each attendant is reminded of every own conversation whose customer has
 * waited longer than the "sem resposta" alert (Configurações › Fila), one
 * notice per conversation naming the customer, repeated on the same "a cada
 * X minutos" interval as the queue reminder.
 */
export async function sendNoReplyRemindersIfDue(now = new Date()): Promise<void> {
  const { queueReminderIntervalMinutes, noReplyWarningMinutes } = await getBusinessSettings();
  const intervalMs = (Number(queueReminderIntervalMinutes) || 1) * 60_000;
  const marker = await prisma.systemSetting.findUnique({ where: { key: NO_REPLY_CADENCE_KEY } });
  const lastSentAt = marker ? new Date((marker.value as { at: string }).at) : null;
  if (lastSentAt && now.getTime() < lastSentAt.getTime() + intervalMs) return;

  const waitingSince = new Date(now.getTime() - (Number(noReplyWarningMinutes) || 5) * 60_000);
  const conversations = await prisma.conversation.findMany({
    where: { status: { in: ["IN_PROGRESS", "TRANSFERRED"] }, assignedAgentId: { not: null }, awaitingReplySince: { lte: waitingSince } },
    select: { id: true, assignedAgentId: true, interventionById: true, awaitingReplySince: true, contact: { select: { name: true, phone: true } }, ...SCHEDULE_SELECT },
  });
  if (conversations.length === 0) return;
  const isHoliday = cachedHolidayLookup();
  for (const c of conversations) {
    // Only the Horário de expediente counts: a customer who wrote right before closing hasn't "waited" all night.
    const waitedMs = (await conversationSpanMs(c, c.awaitingReplySince, now, isHoliday)) ?? 0;
    if (waitedMs < (Number(noReplyWarningMinutes) || 5) * 60_000) continue;
    realtimeEvents.noReplyReminder(c.interventionById ?? c.assignedAgentId!, {
      conversationId: c.id,
      contactName: c.contact.name ?? c.contact.phone ?? "Cliente",
      minutes: Math.floor(waitedMs / 60_000),
    });
  }
  await prisma.systemSetting.upsert({
    where: { key: NO_REPLY_CADENCE_KEY },
    update: { value: { at: now.toISOString() } },
    create: { key: NO_REPLY_CADENCE_KEY, value: { at: now.toISOString() } },
  });
}
