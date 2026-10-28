import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";
import { createApp } from "../src/app";
import { enqueueAutoMessage, processDueAutoMessages, sendOutOfHoursNotice, setAutoMessageDelayForTests } from "../src/lib/auto-messages";
import { sendQueueWaitMessages } from "../src/modules/queue-wait-messages/queue-wait.sweep";
import { processNoReturnConversations, resetNoReturnClock } from "../src/modules/conversations/no-return.service";
import { updateBusinessSettings } from "../src/modules/settings/settings.service";

const app = createApp();
const MINUTE = 60_000;
const ALL = { allConnections: true, connectionIds: [] as string[] };

describe("Mensagens automáticas: etiquetas que bloqueiam e espera de 3 a 10 segundos", () => {
  let connectionId: string;
  let agentId: string;
  let adminToken: string;

  beforeEach(async () => {
    await resetDatabase();
    resetNoReturnClock();
    connectionId = (await createTestConnection("Suporte")).id;
    agentId = (await createTestUser({ email: "ana@test.dev", role: "AGENT", displayName: "Ana", presence: "ONLINE", whatsappConnectionId: connectionId })).id;
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    adminToken = (await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterEach(() => setAutoMessageDelayForTests([0, 0]));

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function contactWithTag(phone: string, blocked: string[]) {
    const tag = await prisma.tag.create({ data: { name: `Etiqueta ${phone}`, color: "#000000", blockedAutoMessages: blocked } });
    const contact = await prisma.contact.create({ data: { phone, name: "Joana", firstName: "Joana", whatsappConnectionId: connectionId } });
    await prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    return { contact, tag };
  }

  const outbound = (conversationId: string) =>
    prisma.message.findMany({ where: { conversationId, direction: "OUTBOUND" }, orderBy: { createdAt: "asc" } }).then((rows) => rows.map((m) => m.body));

  it("a etiqueta guarda a lista; só gestor e administrador escolhem", async () => {
    const created = await request(app)
      .post("/api/contacts/tags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Funcionário", color: "#123456", blockedAutoMessages: ["SURVEY", "QUEUE_WAIT", "SURVEY"] });
    expect(created.status).toBe(201);
    expect(created.body.blockedAutoMessages).toEqual(["SURVEY", "QUEUE_WAIT"]);
    const invalid = await request(app).post("/api/contacts/tags").set("Authorization", `Bearer ${adminToken}`).send({ name: "X", color: "#123456", blockedAutoMessages: ["NADA"] });
    expect(invalid.status).toBe(400);

    const agentToken = (await request(app).post("/api/auth/login").send({ email: "ana@test.dev", password: TEST_PASSWORD })).body.accessToken;
    // Even an attendant allowed to edit tags may not set the list.
    await prisma.rolePermission.create({ data: { role: "AGENT", permission: "etiquetas.editar", allowed: true } });
    const denied = await request(app).patch(`/api/contacts/tags/${created.body.id}`).set("Authorization", `Bearer ${agentToken}`).send({ blockedAutoMessages: [] });
    expect(denied.status).toBe(403);
  });

  it("espera na fila bloqueada: não envia e registra no relatório", async () => {
    await prisma.queueWaitMessage.create({ data: { position: 1, delayMinutes: 1, text: "Você está na fila", active: true, allConnections: true } });
    const { contact } = await contactWithTag("5511900000021", ["QUEUE_WAIT"]);
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "NEW", enteredQueueAt: new Date(Date.now() - 5 * MINUTE), lastMessageAt: new Date() },
    });
    await sendQueueWaitMessages();
    expect(await outbound(conversation.id)).toEqual([]);
    expect(await prisma.autoMessageBlockLog.findMany({ select: { kind: true, tagName: true } })).toEqual([{ kind: "QUEUE_WAIT", tagName: "Etiqueta 5511900000021" }]);

    const report = await request(app).get("/api/reports/auto-message-blocks").query({ period: "today" }).set("Authorization", `Bearer ${adminToken}`);
    expect(report.body).toMatchObject({ total: 1, byKind: [{ kind: "QUEUE_WAIT", count: 1 }], items: [{ contactName: "Joana", kind: "QUEUE_WAIT" }] });
    const csv = await request(app).get("/api/reports/auto-message-blocks").query({ period: "today", format: "csv" }).set("Authorization", `Bearer ${adminToken}`);
    expect(csv.text).toContain("Espera na fila");
  });

  it("falta de retorno bloqueada: não lembra nem encerra, e registra uma vez só", async () => {
    await updateBusinessSettings({ noReturnEnabled: true, noReturnReminderMinutes: 10, noReturnCloseMinutes: 15 });
    const { contact } = await contactWithTag("5511900000022", ["NO_RETURN"]);
    const conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        whatsappConnectionId: connectionId,
        status: "IN_PROGRESS",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        lastMessageAt: new Date(Date.now() - 60 * MINUTE),
        lastMessageDirection: "OUTBOUND",
      },
    });
    await processNoReturnConversations();
    await processNoReturnConversations(new Date(Date.now() + 120 * MINUTE));
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("IN_PROGRESS");
    expect(await outbound(conversation.id)).toEqual([]);
    expect(await prisma.autoMessageBlockLog.count({ where: { kind: "NO_RETURN" } })).toBe(1);

    const listed = await request(app).get(`/api/conversations/${conversation.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(listed.body.autoMessageBlocks).toEqual([{ kind: "NO_RETURN", tagName: "Etiqueta 5511900000022" }]);
  });

  it("espera de 3 a 10 segundos, na ordem; cancela se a conversa foi retomada", async () => {
    setAutoMessageDelayForTests([3_000, 10_000]);
    const contact = await prisma.contact.create({ data: { phone: "5511900000023", name: "Joana", whatsappConnectionId: connectionId } });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "CLOSED", assignedAgentId: agentId, closedAt: new Date(), lastMessageAt: new Date() },
    });
    const now = new Date();
    const first = await enqueueAutoMessage({ conversationId: conversation.id, kind: "CLOSING", text: "Primeira", senderAgentId: agentId, condition: "CLOSED" }, now);
    const second = await enqueueAutoMessage({ conversationId: conversation.id, kind: "SURVEY", text: "Segunda", automatedBy: "SURVEY", condition: "ANY" }, now);
    expect(first.getTime() - now.getTime()).toBeGreaterThanOrEqual(3_000);
    expect(first.getTime() - now.getTime()).toBeLessThanOrEqual(10_000);
    expect(second.getTime()).toBeGreaterThan(first.getTime());

    expect(await processDueAutoMessages(new Date(now.getTime() + 2_000))).toBe(0);
    expect(await outbound(conversation.id)).toEqual([]);
    await processDueAutoMessages(new Date(second.getTime() + 1));
    expect(await outbound(conversation.id)).toEqual(["Primeira", "Segunda"]);

    // Taken up again (Desfazer) before its time: the closing message is dropped.
    const third = await enqueueAutoMessage({ conversationId: conversation.id, kind: "CLOSING", text: "Terceira", senderAgentId: agentId, condition: "CLOSED" });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "IN_PROGRESS" } });
    await processDueAutoMessages(new Date(third.getTime() + 1));
    expect(await outbound(conversation.id)).toEqual(["Primeira", "Segunda"]);
    expect((await prisma.pendingAutoMessage.findFirstOrThrow({ where: { payload: { path: ["text"], equals: "Terceira" } } })).outcome).toBe("CANCELED_NO_LONGER_FITS");
  });

  it("fora do expediente: um aviso só, mesmo com várias mensagens do cliente", async () => {
    setAutoMessageDelayForTests([3_000, 10_000]);
    const contact = await prisma.contact.create({ data: { phone: "5511900000024", name: "Joana", whatsappConnectionId: connectionId } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "NEW", lastMessageAt: new Date() } });
    await sendOutOfHoursNotice({ id: conversation.id, contactId: contact.id }, "Estamos fora do expediente.");
    await sendOutOfHoursNotice({ id: conversation.id, contactId: contact.id }, "Estamos fora do expediente.");
    await processDueAutoMessages(new Date(Date.now() + 11_000));
    expect(await outbound(conversation.id)).toEqual(["Estamos fora do expediente."]);
  });

  it("aceite bloqueado: aceita sem enviar a mensagem de aceite", async () => {
    await prisma.autoMessageTemplate.create({ data: { name: "Aceite", trigger: "ACCEPT", text: "Olá, sou {{atendente}}!", active: true, allConnections: true } });
    const { contact } = await contactWithTag("5511900000025", ["ACCEPT"]);
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "NEW", lastMessageAt: new Date() } });
    const agentToken = (await request(app).post("/api/auth/login").send({ email: "ana@test.dev", password: TEST_PASSWORD })).body.accessToken;
    const accepted = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);
    expect(accepted.status).toBe(200);
    expect(await outbound(conversation.id)).toEqual([]);
    expect(await prisma.autoMessageBlockLog.count({ where: { kind: "ACCEPT" } })).toBe(1);
  });
});
