import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { realtimeEvents } from "../src/realtime/realtime";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { fireDueReminders, sendDueScheduledMessages } from "../src/modules/agent-tools/agent-tools.service";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const loginAs = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;
const past = () => new Date(Date.now() - 1000);
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

describe("Atendimento: fixar, lembrar de retornar, agendar envio, Meu dia e digitando", () => {
  let connectionId: string;
  let provider: MockWhatsAppProvider;
  let adminToken: string;
  let agentId: string;
  let agentToken: string;
  let otherToken: string;
  let phoneCounter = 0;

  /** A conversation the agent already accepted — one per test so they never see each other's data. */
  async function acceptedConversation() {
    phoneCounter += 1;
    const { conversation, contact } = await createWaitingConversation(`556599100${String(phoneCounter).padStart(4, "0")}`, connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`).expect(200);
    return { conversation, contact };
  }
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-tools@test.dev", role: "ADMIN" });
    adminToken = await loginAs("admin-tools@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set(as(adminToken)).send({ name: "SuporteFerramentas" });
    connectionId = created.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set(as(adminToken));
    await wait(2300); // mock provider: QR -> CONNECTED takes ~1.9s
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    agentId = (await createTestUser({ email: "ana-tools@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId })).id;
    await createTestUser({ email: "beto-tools@test.dev", role: "AGENT", displayName: "Beto", whatsappConnectionId: connectionId });
    agentToken = await loginAs("ana-tools@test.dev");
    otherToken = await loginAs("beto-tools@test.dev");
  }, 20000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("fixa e desafixa uma conversa — só a própria", async () => {
    const { conversation } = await acceptedConversation();
    await request(app).put(`/api/agent-tools/pins/${conversation.id}`).set(as(agentToken)).send({ pinned: true }).expect(204);
    expect((await request(app).get("/api/agent-tools/extras").set(as(agentToken))).body.pinnedConversationIds).toContain(conversation.id);

    const other = await request(app).put(`/api/agent-tools/pins/${conversation.id}`).set(as(otherToken)).send({ pinned: true });
    expect(other.status).toBeGreaterThanOrEqual(400);

    await request(app).put(`/api/agent-tools/pins/${conversation.id}`).set(as(agentToken)).send({ pinned: false }).expect(204);
    expect((await request(app).get("/api/agent-tools/extras").set(as(agentToken))).body.pinnedConversationIds).not.toContain(conversation.id);
  });

  it("o lembrete na hora certa avisa uma vez no sino e pode ser adiado", async () => {
    const { conversation } = await acceptedConversation();
    const pastRes = await request(app).post("/api/agent-tools/reminders").set(as(agentToken)).send({ conversationId: conversation.id, remindAt: past().toISOString() });
    expect(pastRes.status).toBe(400);

    const created = await request(app)
      .post("/api/agent-tools/reminders")
      .set(as(agentToken))
      .send({ conversationId: conversation.id, remindAt: inAnHour(), note: "Confirmar pagamento" })
      .expect(201);
    await prisma.conversationReminder.update({ where: { id: created.body.id }, data: { remindAt: past() } });
    const due = vi.spyOn(realtimeEvents, "reminderDue");

    await fireDueReminders();
    await fireDueReminders();
    const notifications = await prisma.notification.findMany({ where: { userId: agentId, type: "CONVERSATION_REMINDER", entityId: conversation.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ title: expect.stringContaining("Hora de retornar para"), body: "Confirmar pagamento" });
    expect(due).toHaveBeenCalledWith(agentId, expect.objectContaining({ id: created.body.id, conversationId: conversation.id }));

    const snoozed = await request(app).post(`/api/agent-tools/reminders/${created.body.id}/snooze`).set(as(agentToken)).send({ minutes: 15 }).expect(200);
    expect(snoozed.body.firedAt).toBeNull();
    expect(new Date(snoozed.body.remindAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    due.mockRestore();
  });

  it("o lembrete de uma conversa encerrada é descartado sem avisar", async () => {
    const { conversation } = await acceptedConversation();
    const created = await request(app).post("/api/agent-tools/reminders").set(as(agentToken)).send({ conversationId: conversation.id, remindAt: inAnHour() }).expect(201);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.conversationReminder.update({ where: { id: created.body.id }, data: { remindAt: past() } });

    await fireDueReminders();
    expect(await prisma.conversationReminder.count({ where: { id: created.body.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: agentId, type: "CONVERSATION_REMINDER", entityId: conversation.id } })).toBe(0);
  });

  it("a mensagem agendada sai na hora com o atendente; cancelada não sai", async () => {
    const { conversation } = await acceptedConversation();
    const scheduled = await request(app)
      .post("/api/agent-tools/scheduled-messages")
      .set(as(agentToken))
      .send({ conversationId: conversation.id, body: "Seu pedido saiu para entrega", sendAt: inAnHour() })
      .expect(201);
    const canceled = await request(app)
      .post("/api/agent-tools/scheduled-messages")
      .set(as(agentToken))
      .send({ conversationId: conversation.id, body: "Esta não vai", sendAt: inAnHour() })
      .expect(201);
    await request(app).delete(`/api/agent-tools/scheduled-messages/${canceled.body.id}`).set(as(agentToken)).expect(204);
    await prisma.scheduledMessage.updateMany({ where: { conversationId: conversation.id }, data: { sendAt: past() } });

    await sendDueScheduledMessages();
    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id, direction: "OUTBOUND", type: "TEXT" } });
    expect(messages.map((m) => m.body)).toContain("Seu pedido saiu para entrega");
    expect(messages.map((m) => m.body)).not.toContain("Esta não vai");
    expect(messages.find((m) => m.body === "Seu pedido saiu para entrega")?.senderAgentId).toBe(agentId);
    expect((await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: scheduled.body.id } })).sentAt).not.toBeNull();
    expect((await request(app).get("/api/agent-tools/extras").set(as(agentToken))).body.scheduledMessages).toHaveLength(0);
  });

  it("se a conversa já foi encerrada, a mensagem agendada falha e o atendente é avisado", async () => {
    const { conversation } = await acceptedConversation();
    const scheduled = await request(app)
      .post("/api/agent-tools/scheduled-messages")
      .set(as(agentToken))
      .send({ conversationId: conversation.id, body: "Bom dia!", sendAt: inAnHour() })
      .expect(201);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.scheduledMessage.update({ where: { id: scheduled.body.id }, data: { sendAt: past() } });

    await sendDueScheduledMessages();
    const row = await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: scheduled.body.id } });
    expect(row).toMatchObject({ sentAt: null, failedReason: "A conversa não está mais em atendimento." });
    expect(row.failedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: agentId, type: "SCHEDULED_MESSAGE_FAILED", entityId: conversation.id } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId: conversation.id, body: "Bom dia!" } })).toBe(0);
  });

  it("Meu dia conta os encerrados de hoje e mostra a meta configurada", async () => {
    const goal = await request(app).post("/api/goals").set(as(adminToken)).send({ type: "CLOSED_PER_DAY", target: 12 }).expect(201);
    const { conversation } = await acceptedConversation();
    const before = (await request(app).get("/api/agent-tools/my-day").set(as(agentToken))).body;
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "CLOSED", closedAt: new Date() } });
    const after = (await request(app).get("/api/agent-tools/my-day").set(as(agentToken))).body;
    expect(after.goals).toEqual([{ type: "CLOSED_PER_DAY", target: 12, current: before.closedToday + 1, achieved: false }]);
    expect(after.closedToday).toBe(before.closedToday + 1);

    await request(app).put(`/api/goals/${goal.body.id}`).set(as(adminToken)).send({ type: "CLOSED_PER_DAY", target: 12, active: false }).expect(200);
    expect((await request(app).get("/api/agent-tools/my-day").set(as(agentToken))).body.goals).toEqual([]);
    await request(app).delete(`/api/goals/${goal.body.id}`).set(as(adminToken)).expect(204);
  });

  it("a meta mais específica vale: atendente > conexão > todos", async () => {
    const created = [
      await request(app).post("/api/goals").set(as(adminToken)).send({ type: "CLOSED_PER_DAY", target: 10 }),
      await request(app).post("/api/goals").set(as(adminToken)).send({ type: "CLOSED_PER_DAY", target: 20, scope: "CONNECTIONS", connectionIds: [connectionId] }),
      await request(app).post("/api/goals").set(as(adminToken)).send({ type: "NPS", target: 70 }),
    ];
    const goalsOf = async (token: string) => (await request(app).get("/api/agent-tools/my-day").set(as(token))).body.goals as { type: string; target: number }[];
    expect((await goalsOf(agentToken)).find((g) => g.type === "CLOSED_PER_DAY")?.target).toBe(20);
    const forAgent = await request(app).post("/api/goals").set(as(adminToken)).send({ type: "CLOSED_PER_DAY", target: 30, scope: "AGENTS", agentIds: [agentId] });
    expect((await goalsOf(agentToken)).find((g) => g.type === "CLOSED_PER_DAY")?.target).toBe(30);
    expect((await goalsOf(agentToken)).find((g) => g.type === "NPS")?.target).toBe(70);
    const agentOnlyToConnection = await request(app).post("/api/goals").set(as(adminToken)).send({ type: "AVG_FIRST_RESPONSE", target: 3, scope: "AGENTS", agentIds: [] });
    expect(agentOnlyToConnection.status).toBe(400);
    for (const g of [...created, forAgent]) await request(app).delete(`/api/goals/${g.body.id}`).set(as(adminToken)).expect(204);
  });

  it("repassa \"digitando…\" do cliente para a conversa aberta", async () => {
    const { conversation, contact } = await acceptedConversation();
    const typing = vi.spyOn(realtimeEvents, "customerTyping");
    provider.simulateTyping({ chatId: `${contact.phone}@s.whatsapp.net`, typing: true });
    await wait(200);
    expect(typing).toHaveBeenCalledWith(conversation.id, agentId, true, "typing");
    provider.simulateTyping({ chatId: `${contact.phone}@s.whatsapp.net`, typing: true, kind: "recording" });
    await wait(200);
    expect(typing).toHaveBeenLastCalledWith(conversation.id, agentId, true, "recording");
    typing.mockRestore();
  });

  it("mostra ao cliente quando o atendente digita ou grava — e para de mostrar se desligado em Configurações", async () => {
    const { conversation, contact } = await acceptedConversation();
    provider.sentPresences.length = 0;
    await request(app).post(`/api/conversations/${conversation.id}/presence`).set(as(agentToken)).send({ presence: "composing" }).expect(204);
    await request(app).post(`/api/conversations/${conversation.id}/presence`).set(as(agentToken)).send({ presence: "recording" }).expect(204);
    await request(app).post(`/api/conversations/${conversation.id}/presence`).set(as(agentToken)).send({ presence: "paused" }).expect(204);
    expect(provider.sentPresences.map((p) => p.presence)).toEqual(["composing", "recording", "paused"]);
    expect(provider.sentPresences[0].chatId).toContain(contact.phone!);

    await request(app).patch("/api/settings/queue").set(as(adminToken)).send({ typingToCustomer: false }).expect(200);
    try {
      await request(app).post(`/api/conversations/${conversation.id}/presence`).set(as(agentToken)).send({ presence: "composing" }).expect(204);
      expect(provider.sentPresences).toHaveLength(3);
    } finally {
      await request(app).patch("/api/settings/queue").set(as(adminToken)).send({ typingToCustomer: true }).expect(200);
    }
  });
});
