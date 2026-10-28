import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import { realtimeEvents } from "../src/realtime/realtime";
import { sendNoReplyRemindersIfDue } from "../src/lib/queue-reminder";
import { resetDatabase, createTestUser } from "./helpers";

describe("aviso de cliente aguardando resposta", () => {
  let agentId: string;
  let conversationId: string;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.systemSetting.deleteMany({ where: { key: "noReplyReminderLastSentAt" } });
    const connection = await prisma.whatsAppConnection.create({ data: { name: "Aviso" } });
    agentId = (await createTestUser({ email: "ana-aviso@test.dev", role: "AGENT", whatsappConnectionId: connection.id })).id;
    const contact = await prisma.contact.create({ data: { phone: "5565999995555", name: "Cliente Espera", whatsappConnectionId: connection.id } });
    conversationId = (
      await prisma.conversation.create({
        data: {
          contactId: contact.id,
          whatsappConnectionId: connection.id,
          status: "IN_PROGRESS",
          assignedAgentId: agentId,
          enteredQueueAt: new Date(),
          lastMessageAt: new Date(),
          awaitingReplySince: new Date(Date.now() - 7 * 60_000),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("avisa o atendente de cada conversa sem resposta além do alerta, com o nome do cliente, a cada X minutos", async () => {
    const spy = vi.spyOn(realtimeEvents, "noReplyReminder");
    const now = new Date();
    await sendNoReplyRemindersIfDue(now);
    expect(spy).toHaveBeenCalledWith(agentId, { conversationId, contactName: "Cliente Espera", minutes: 7 });

    spy.mockClear();
    await sendNoReplyRemindersIfDue(new Date(now.getTime() + 30_000));
    expect(spy).not.toHaveBeenCalled(); // same interval (1 min by default)
    await sendNoReplyRemindersIfDue(new Date(now.getTime() + 61_000));
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    await prisma.conversation.update({ where: { id: conversationId }, data: { awaitingReplySince: null } });
    await sendNoReplyRemindersIfDue(new Date(now.getTime() + 5 * 60_000));
    expect(spy).not.toHaveBeenCalled();
  });
});
