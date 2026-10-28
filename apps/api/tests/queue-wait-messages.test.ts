import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const sent: { phone: string; text: string }[] = [];
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    sendAutomatedText: vi.fn(async (_connectionId: string, _messageId: string, phone: string, text: string) => {
      sent.push({ phone, text });
    }),
  };
});

// Loaded after the mock so every module binds to the mocked whatsapp.service.
import { createApp } from "../src/app";
import { sendQueueWaitMessages } from "../src/modules/queue-wait-messages/queue-wait.sweep";

const app = createApp();

/** What the customer was sent, as the conversation shows it (the wait messages). */
async function sentNow() {
  const rows = await prisma.message.findMany({
    where: { direction: "OUTBOUND", automatedBy: "QUEUE_WAIT" },
    orderBy: { createdAt: "asc" },
    select: { body: true, conversation: { select: { contact: { select: { phone: true } } } } },
  });
  return rows.map((m) => ({ text: m.body, phone: m.conversation.contact.phone }));
}
const MINUTE = 60_000;
const ALL = { allConnections: true, connectionIds: [] as string[] };

describe("Respostas › Espera na fila", () => {
  let connectionId: string;
  let adminToken: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    adminToken = (await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const add = (body: object) => request(app).post("/api/queue-wait-messages").set("Authorization", `Bearer ${adminToken}`).send({ active: true, connectionScope: ALL, ...body });

  async function queued(phone: string, minutesAgo: number, status: "NEW" | "WAITING" | "IN_FLOW" | "IN_PROGRESS" = "NEW", connection = connectionId) {
    const contact = await prisma.contact.create({ data: { phone, name: "Joana Silva", firstName: "Joana", whatsappConnectionId: connection } });
    return prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connection, status, enteredQueueAt: new Date(Date.now() - minutesAgo * MINUTE), lastMessageAt: new Date() },
    });
  }

  it("envia uma mensagem por vez, no tempo de cada uma, e para depois da última", async () => {
    expect((await add({ delayMinutes: 5, text: "{{primeiro_nome}}, você está na fila." })).status).toBe(201);
    expect((await add({ delayMinutes: 10, text: "Ainda estamos aqui, {{cliente}}!" })).status).toBe(201);
    const conversation = await queued("5511900000001", 6);
    const now = Date.now();

    await sendQueueWaitMessages(new Date(now));
    expect((await sentNow()).map((m) => m.text)).toEqual(["Joana, você está na fila."]);
    await sendQueueWaitMessages(new Date(now + 5 * MINUTE));
    expect(await sentNow()).toHaveLength(1);
    await sendQueueWaitMessages(new Date(now + 10 * MINUTE));
    expect((await sentNow()).map((m) => m.text)).toEqual(["Joana, você está na fila.", "Ainda estamos aqui, Joana Silva!"]);
    await sendQueueWaitMessages(new Date(now + 60 * MINUTE));
    expect(await sentNow()).toHaveLength(2);

    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => [m.automatedBy, m.senderAgentId])).toEqual([
      ["QUEUE_WAIT", null],
      ["QUEUE_WAIT", null],
    ]);
  });

  it("não envia no Fluxo, em atendimento, fora do expediente nem para outra conexão", async () => {
    const other = (await createTestConnection("Vendas")).id;
    await add({ delayMinutes: 1, text: "Só para Vendas", connectionScope: { allConnections: false, connectionIds: [other] } });
    await queued("5511900000002", 30, "IN_FLOW", other);
    await queued("5511900000003", 30, "IN_PROGRESS", other);
    await queued("5511900000004", 30, "NEW", connectionId);
    const schedule = await prisma.workSchedule.create({ data: { name: "Fechado", state: "SP", city: "São Paulo", days: {}, closedMessage: "Fechado." } });
    const closed = await prisma.whatsAppConnection.create({ data: { name: "Fechada", status: "CONNECTED", workScheduleId: schedule.id } });
    await prisma.queueWaitMessage.updateMany({ data: { allConnections: true } });
    await queued("5511900000005", 30, "NEW", closed.id);

    await sendQueueWaitMessages();
    // Only the queued conversation of an open connection (the scope was widened to all connections above).
    expect((await sentNow()).map((m) => m.phone)).toEqual(["5511900000004"]);
  });

  it("recomeça a sequência quando a conversa volta para a fila", async () => {
    await add({ delayMinutes: 2, text: "Aguarde, por favor." });
    const conversation = await queued("5511900000006", 3);
    await sendQueueWaitMessages();
    expect(await sentNow()).toHaveLength(1);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { enteredQueueAt: new Date(Date.now() - 3 * MINUTE) } });
    await sendQueueWaitMessages();
    expect(await sentNow()).toHaveLength(2);
  });

  it("lista em ordem e muda a ordem com Subir/Descer", async () => {
    const first = (await add({ delayMinutes: 5, text: "Primeira" })).body;
    const second = (await add({ delayMinutes: 5, text: "Segunda" })).body;
    expect([first.position, second.position]).toEqual([1, 2]);
    const moved = await request(app).post(`/api/queue-wait-messages/${second.id}/move`).set("Authorization", `Bearer ${adminToken}`).send({ direction: "up" });
    expect(moved.body.map((m: { text: string }) => m.text)).toEqual(["Segunda", "Primeira"]);
    await request(app).delete(`/api/queue-wait-messages/${second.id}`).set("Authorization", `Bearer ${adminToken}`).expect(204);
    const list = await request(app).get("/api/queue-wait-messages").set("Authorization", `Bearer ${adminToken}`);
    expect(list.body.map((m: { text: string; position: number }) => [m.text, m.position])).toEqual([["Primeira", 1]]);
  });
});
