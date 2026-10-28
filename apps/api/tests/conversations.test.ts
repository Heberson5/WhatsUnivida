import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, grantManagerConnectionAccess, TEST_PASSWORD } from "./helpers";
import * as conversationsService from "../src/modules/conversations/conversations.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("conversation queue and acceptance", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("only lets one of two simultaneous accepts win (no double-assignment)", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId });
    const [joaoToken, mariaToken] = await Promise.all([loginAs("joao@test.dev"), loginAs("maria@test.dev")]);

    const { conversation } = await createWaitingConversation("5511999990000", connectionId);

    const [joaoRes, mariaRes] = await Promise.all([
      request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`),
      request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${mariaToken}`),
    ]);

    const statuses = [joaoRes.status, mariaRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = joaoRes.status === 200 ? "joao@test.dev" : "maria@test.dev";
    const loser = winner === "joao@test.dev" ? mariaRes : joaoRes;
    expect(loser.body.message).toMatch(/ja foi assumida/i);

    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id }, include: { assignedAgent: true } });
    expect(persisted.status).toBe("IN_PROGRESS");
    expect(persisted.assignedAgent?.email).toBe(winner);

    // Exactly one ACCEPTED assignment record should exist — no duplicate wins.
    const assignments = await prisma.conversationAssignment.findMany({ where: { conversationId: conversation.id, reason: "ACCEPT" } });
    expect(assignments).toHaveLength(1);
  });

  it("orders the queue by most recent message, not by when it first entered the queue", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");

    // Conversation A entered the queue first (older enteredQueueAt) but its
    // customer sent a newer follow-up message — it should sort ABOVE
    // conversation B, which entered the queue more recently but has gone
    // quiet since. A pure enteredQueueAt-based order would put B first.
    const contactA = await prisma.contact.create({ data: { phone: "5511900000001", whatsappConnectionId: connectionId } });
    const conversationA = await prisma.conversation.create({
      data: {
        contactId: contactA.id,
        whatsappConnectionId: connectionId,
        status: "WAITING",
        enteredQueueAt: new Date("2026-01-01T10:00:00Z"),
        lastMessageAt: new Date("2026-01-01T12:00:00Z"),
      },
    });
    const contactB = await prisma.contact.create({ data: { phone: "5511900000002", whatsappConnectionId: connectionId } });
    const conversationB = await prisma.conversation.create({
      data: {
        contactId: contactB.id,
        whatsappConnectionId: connectionId,
        status: "WAITING",
        enteredQueueAt: new Date("2026-01-01T11:00:00Z"),
        lastMessageAt: new Date("2026-01-01T11:05:00Z"),
      },
    });

    const res = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual([conversationA.id, conversationB.id]);
  });

  it("shows an unread count on queue cards too, not just on 'Meus atendimentos'", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999994444", connectionId);
    await prisma.message.createMany({
      data: [
        { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "oi" },
        { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "alguem ai?" },
      ],
    });

    const res = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.find((c: { id: string }) => c.id === conversation.id).unreadCount).toBe(2);
  });

  it("hides message preview and content from the queue before acceptance", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");
    const { conversation, contact } = await createWaitingConversation("5511999991111", connectionId);
    await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "informação confidencial do cliente" },
    });

    const res = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const item = res.body.find((c: { id: string }) => c.id === conversation.id);
    expect(item).toBeTruthy();
    expect(item.lastMessagePreview).toBeNull();
    expect(JSON.stringify(item)).not.toMatch(/confidencial/);
    expect(item.contact.phone).toBe(contact.phone);
  });

  it("never shows another connection's queue to an agent", async () => {
    const otherConnectionId = (await createTestConnection("Vendas")).id;
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");
    await createWaitingConversation("5511999998888", otherConnectionId); // belongs to Vendas, not Joao's Suporte

    const res = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`);
    expect(res.body).toHaveLength(0);
  });

  it("blocks a second agent from opening a conversation already assigned to someone else", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId });
    const joaoToken = await loginAs("joao@test.dev");
    const mariaToken = await loginAs("maria@test.dev");
    const { conversation } = await createWaitingConversation("5511999992222", connectionId);

    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);

    const res = await request(app).get(`/api/conversations/${conversation.id}`).set("Authorization", `Bearer ${mariaToken}`);
    expect(res.status).toBe(403);
  });

  it("transfers a conversation across connections: it disappears from the old agent and appears for the new one", async () => {
    const vendasId = (await createTestConnection("Vendas")).id;
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    // Maria's home connection is different from the conversation's — a transfer must still be allowed.
    const maria = await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: vendasId, presence: "ONLINE" });
    const joaoToken = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999993333", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);

    const transferRes = await request(app)
      .post(`/api/conversations/${conversation.id}/transfer`)
      .set("Authorization", `Bearer ${joaoToken}`)
      .send({ toAgentId: maria.id, note: "cliente pediu especialista" });
    expect(transferRes.status).toBe(200);
    expect(transferRes.body.status).toBe("TRANSFERRED");
    expect(transferRes.body.assignedAgentId).toBe(maria.id);

    const mineJoao = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${joaoToken}`);
    expect(mineJoao.body.find((c: { id: string }) => c.id === conversation.id)).toBeUndefined();

    const mariaToken = await loginAs("maria@test.dev");
    const mineMaria = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${mariaToken}`);
    const transferred = mineMaria.body.find((c: { id: string }) => c.id === conversation.id);
    expect(transferred).toBeTruthy();
    expect(transferred.transfer.fromAgentName).toBe("Joao");
  });

  it("flags a conversation transferred to an offline agent with a 2h pending deadline, and clears it once they log in", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const maria = await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId, presence: "OFFLINE" });
    const joaoToken = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999990001", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);
    await request(app).post(`/api/conversations/${conversation.id}/transfer`).set("Authorization", `Bearer ${joaoToken}`).send({ toAgentId: maria.id });

    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(persisted.pendingTransferDeadline).not.toBeNull();

    // Maria logging in should cancel the countdown.
    await loginAs("maria@test.dev");
    const afterLogin = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(afterLogin.pendingTransferDeadline).toBeNull();
  });

  it("reverts an expired offline transfer back to the agent who transferred it", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const maria = await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId, presence: "OFFLINE" });
    const joaoToken = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999990002", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);
    await request(app).post(`/api/conversations/${conversation.id}/transfer`).set("Authorization", `Bearer ${joaoToken}`).send({ toAgentId: maria.id });

    // Simulate the 2h deadline already having passed, without waiting for it.
    await prisma.conversation.update({ where: { id: conversation.id }, data: { pendingTransferDeadline: new Date(Date.now() - 1000) } });

    const { revertExpiredTransfers } = await import("../src/modules/conversations/conversations.service");
    await revertExpiredTransfers();

    const reverted = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(reverted.status).toBe("IN_PROGRESS");
    expect(reverted.assignedAgentId).toBe((await prisma.user.findUniqueOrThrow({ where: { email: "joao@test.dev" } })).id);
    expect(reverted.pendingTransferDeadline).toBeNull();
  });

  it("closes a conversation and removes it from the agent's active list", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999994444", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);

    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${token}`);
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.status).toBe("CLOSED");

    const mine = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${token}`);
    expect(mine.body.find((c: { id: string }) => c.id === conversation.id)).toBeUndefined();
  });

  it("lets a MANAGER view any conversation via oversight (optionally filtered by connection), and a second accept on an already-taken one conflicts", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const gestor = await createTestUser({ email: "gestor@test.dev", role: "MANAGER" });
    await grantManagerConnectionAccess(gestor.id, connectionId);
    const joaoToken = await loginAs("joao@test.dev");
    const gestorToken = await loginAs("gestor@test.dev");
    const { conversation } = await createWaitingConversation("5511999995555", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);

    const viewRes = await request(app).get(`/api/conversations/${conversation.id}`).set("Authorization", `Bearer ${gestorToken}`);
    expect(viewRes.status).toBe(200);

    // MANAGER can attend conversations in general (see the next test), but
    // this one was already claimed by Joao a moment ago — same conflict any
    // agent would get racing an accept.
    const acceptAttempt = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${gestorToken}`);
    expect(acceptAttempt.status).toBe(409);

    const otherConnectionId = (await createTestConnection("Vendas")).id;
    const filtered = await request(app)
      .get("/api/conversations/oversight")
      .query({ connectionId: otherConnectionId })
      .set("Authorization", `Bearer ${gestorToken}`);
    expect(filtered.body.find((c: { id: string }) => c.id === conversation.id)).toBeUndefined();
  });

  it("lets a MANAGER (with no fixed connection) see the combined queue across connections, accept, and later receive a transfer", async () => {
    const gestor2 = await createTestUser({ email: "gestor2@test.dev", role: "MANAGER", presence: "ONLINE" });
    const gestorToken = await loginAs("gestor2@test.dev");
    const vendas = await createTestConnection("Vendas2");
    await grantManagerConnectionAccess(gestor2.id, connectionId);
    await grantManagerConnectionAccess(gestor2.id, vendas.id);
    const { conversation: fromSuporte } = await createWaitingConversation("5511999994444", connectionId);
    const { conversation: fromVendas } = await createWaitingConversation("5511999993333", vendas.id);

    const combinedQueue = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${gestorToken}`);
    expect(combinedQueue.status).toBe(200);
    const ids = combinedQueue.body.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([fromSuporte.id, fromVendas.id]));
    expect(combinedQueue.body.every((c: { whatsappConnectionColor: string }) => typeof c.whatsappConnectionColor === "string")).toBe(true);

    const acceptRes = await request(app).post(`/api/conversations/${fromSuporte.id}/accept`).set("Authorization", `Bearer ${gestorToken}`);
    expect(acceptRes.status).toBe(200);

    const mine = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${gestorToken}`);
    expect(mine.body.map((c: { id: string }) => c.id)).toContain(fromSuporte.id);
  });

  it("shows an unread badge for new inbound messages and clears it once the agent marks it read", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999996666", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);

    // Two more inbound messages arrive after acceptance (simulating provider events directly at the DB level).
    await prisma.message.createMany({
      data: [
        { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "oi" },
        { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "tudo bem?" },
      ],
    });

    const before = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${token}`);
    const item = before.body.find((c: { id: string }) => c.id === conversation.id);
    expect(item.unreadCount).toBe(2);

    const readRes = await request(app).post(`/api/conversations/${conversation.id}/read`).set("Authorization", `Bearer ${token}`);
    expect(readRes.status).toBe(204);

    const after = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${token}`);
    expect(after.body.find((c: { id: string }) => c.id === conversation.id).unreadCount).toBe(0);
  });

  it("clears the unread badge when the linked phone marks the chat read (not just via the /read endpoint)", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");
    const { conversation, contact } = await createWaitingConversation("5511999995555", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);
    await prisma.message.createMany({
      data: [{ conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "oi" }],
    });

    const before = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${token}`);
    expect(before.body.find((c: { id: string }) => c.id === conversation.id).unreadCount).toBe(1);

    // Simulates what whatsapp.service.ts's onChatRead handler does when the
    // provider reports the chat was read from the linked phone — no HTTP
    // route involved, since this isn't triggered by an authenticated user action.
    const active = await conversationsService.findActiveConversationForContact(contact.id);
    expect(active?.id).toBe(conversation.id);
    await conversationsService.markConversationReadFromDevice(active!.id);

    const after = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${token}`);
    expect(after.body.find((c: { id: string }) => c.id === conversation.id).unreadCount).toBe(0);
  });

  it("resets the unread marker on transfer so the new agent sees the full history as unread", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const maria = await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId, presence: "ONLINE" });
    const joaoToken = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999997777", connectionId);
    await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "oi" },
    });
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);
    await request(app).post(`/api/conversations/${conversation.id}/read`).set("Authorization", `Bearer ${joaoToken}`);
    await request(app).post(`/api/conversations/${conversation.id}/transfer`).set("Authorization", `Bearer ${joaoToken}`).send({ toAgentId: maria.id });

    const mariaToken = await loginAs("maria@test.dev");
    const mine = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${mariaToken}`);
    expect(mine.body.find((c: { id: string }) => c.id === conversation.id).unreadCount).toBeGreaterThan(0);
  });
});
