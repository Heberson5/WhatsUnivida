import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { businessMs, cachedHolidayLookup, conversationSchedule } from "../../lib/business-time";
import { SCHEDULE_SELECT } from "../../lib/conversation-timings";
import { copyReplyMediaFile } from "../../lib/reply-media";
import { renderAutoMessageTemplate } from "../auto-message-templates/auto-message-templates.service";
import { enqueueAutoMessage, isBlocked } from "../../lib/auto-messages";
import { listQueueWaitMessages } from "./queue-wait-messages.service";

type WaitMessage = Awaited<ReturnType<typeof listQueueWaitMessages>>[number];

/** The active messages of this conversation's connection, in order — Instagram/Messenger get the "todas as conexões" ones. */
function sequenceFor(messages: WaitMessage[], whatsappConnectionId: string | null): WaitMessage[] {
  return messages.filter((m) => m.active && (m.allConnections || (whatsappConnectionId !== null && m.connections.some((c) => c.id === whatsappConnectionId))));
}

/** {{saudacao}}, {{cliente}} and {{primeiro_nome}} — a wait message never names an agent (nobody has the conversation yet). */
function renderWaitText(text: string, contact: { name: string | null; phone: string | null; firstName: string | null }) {
  return renderAutoMessageTemplate(text, { atendente: "", atendenteNome: "", atendenteCargo: "", cliente: contact.name ?? contact.phone ?? "", primeiroNome: contact.firstName });
}

/**
 * server.ts's once-a-minute sweep for Respostas › Espera na fila. Only conversations waiting in the queue (Novo /
 * Aguardando — never while still in the Fluxo, never groups): each message goes `delayMinutes` after the previous one
 * (the first, after entering the queue), counting only the connection's Horário de expediente, and nothing goes out
 * while it is closed. After the last one the sequence stops; accepting the conversation stops it too. A new stay in
 * the queue (another enteredQueueAt) starts it over.
 */
export async function sendQueueWaitMessages(now = new Date()): Promise<void> {
  const messages = await listQueueWaitMessages();
  if (!messages.some((m) => m.active)) return;

  const conversations = await prisma.conversation.findMany({
    where: { status: { in: ["NEW", "WAITING"] }, contact: { isGroup: false } },
    select: {
      id: true,
      contactId: true,
      channel: true,
      whatsappConnectionId: true,
      enteredQueueAt: true,
      queueWaitStep: true,
      queueWaitQueueAt: true,
      queueWaitLastAt: true,
      contact: { select: { name: true, phone: true, firstName: true, externalUserId: true } },
      ...SCHEDULE_SELECT,
    },
  });
  const isHoliday = cachedHolidayLookup();

  for (const c of conversations) {
    try {
      const sequence = sequenceFor(messages, c.channel === "WHATSAPP" ? c.whatsappConnectionId : null);
      const sameStay = c.queueWaitQueueAt?.getTime() === c.enteredQueueAt.getTime();
      const step = sameStay ? c.queueWaitStep : 0;
      const next = sequence[step];
      if (!next) continue;
      const schedule = conversationSchedule(c);
      if ((await businessMs(schedule, now, new Date(now.getTime() + 60_000), isHoliday)) === 0) continue;
      const since = step > 0 && c.queueWaitLastAt ? c.queueWaitLastAt : c.enteredQueueAt;
      if ((await businessMs(schedule, since, now, isHoliday)) < next.delayMinutes * 60_000) continue;

      // Claimed first, so a slow send never makes the next minute send the same message twice.
      const claimed = await prisma.conversation.updateMany({
        where: { id: c.id, status: { in: ["NEW", "WAITING"] }, enteredQueueAt: c.enteredQueueAt, queueWaitStep: c.queueWaitStep, queueWaitQueueAt: c.queueWaitQueueAt },
        data: { queueWaitStep: step + 1, queueWaitQueueAt: c.enteredQueueAt, queueWaitLastAt: now },
      });
      if (claimed.count === 0) continue;
      await sendWaitMessage(c, next);
    } catch (err) {
      logger.error({ err, conversationId: c.id }, "espera na fila: failed to send the wait message");
    }
  }
}

async function sendWaitMessage(
  c: { id: string; contactId: string; channel: "WHATSAPP" | "INSTAGRAM" | "MESSENGER"; contact: { name: string | null; phone: string | null; firstName: string | null } },
  message: WaitMessage
) {
  // A tag that stops it: this step counts as done (the next ones are checked again), and the report records it.
  if (await isBlocked(c, "QUEUE_WAIT")) return;
  await enqueueAutoMessage({
    conversationId: c.id,
    kind: "QUEUE_WAIT",
    text: renderWaitText(message.text, c.contact),
    // Instagram/Messenger: the text only.
    media: c.channel === "WHATSAPP" ? copyReplyMediaFile(message) : null,
    automatedBy: "QUEUE_WAIT",
    condition: "IN_QUEUE",
  });
}
