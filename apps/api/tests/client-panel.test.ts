import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";
import { createInboundMessage, createOutboundMessage } from "../src/modules/messages/messages.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("client panel: tags, earlier conversations and internal notes", () => {
  let connectionId: string;
  let ownerToken: string;
  let otherToken: string;
  let conversationId: string;
  let contactId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Vendas")).id;
    ownerId = (await createTestUser({ email: "bruna@test.dev", role: "AGENT", displayName: "Bruna", whatsappConnectionId: connectionId })).id;
    await createTestUser({ email: "leticia@test.dev", role: "AGENT", displayName: "Leticia", whatsappConnectionId: connectionId });
    [ownerToken, otherToken] = await Promise.all([loginAs("bruna@test.dev"), loginAs("leticia@test.dev")]);
    const { contact, conversation } = await createWaitingConversation("5511988887777", connectionId);
    contactId = contact.id;
    conversationId = conversation.id;
    await prisma.conversation.update({ where: { id: conversationId }, data: { status: "IN_PROGRESS", assignedAgentId: ownerId, acceptedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("tags the contact with a registered tag (never creates one) and lists earlier conversations", async () => {
    await prisma.conversation.create({
      data: { contactId, whatsappConnectionId: connectionId, status: "CLOSED", enteredQueueAt: new Date("2026-09-01"), closedAt: new Date("2026-09-01T01:00:00Z"), assignedAgentId: ownerId },
    });

    const vip = await prisma.tag.create({ data: { name: "VIP", color: "#0097B4" } });
    const byName = await request(app).post(`/api/conversations/${conversationId}/contact-tags`).set("Authorization", `Bearer ${ownerToken}`).send({ name: "Novo" });
    expect(byName.status).toBe(400);
    const first = await request(app).post(`/api/conversations/${conversationId}/contact-tags`).set("Authorization", `Bearer ${ownerToken}`).send({ tagId: vip.id });
    expect(first.status).toBe(201);
    const again = await request(app).post(`/api/conversations/${conversationId}/contact-tags`).set("Authorization", `Bearer ${ownerToken}`).send({ tagId: vip.id });
    expect(again.status).toBe(201);
    expect(again.body.tags).toHaveLength(1);
    expect(await prisma.tag.count()).toBe(1);

    const panel = await request(app).get(`/api/conversations/${conversationId}/contact-panel`).set("Authorization", `Bearer ${ownerToken}`);
    expect(panel.status).toBe(200);
    expect(panel.body.tags.map((t: { name: string }) => t.name)).toEqual(["VIP"]);
    expect(panel.body.previousConversationCount).toBe(1);
    expect(panel.body.previousConversations[0]).toMatchObject({ status: "CLOSED", agentName: "Bruna", connectionName: "Vendas" });

    const removed = await request(app)
      .delete(`/api/conversations/${conversationId}/contact-tags/${panel.body.tags[0].id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(removed.body.tags).toHaveLength(0);
  });

  it("keeps another agent's conversation off limits", async () => {
    const panel = await request(app).get(`/api/conversations/${conversationId}/contact-panel`).set("Authorization", `Bearer ${otherToken}`);
    expect(panel.status).toBe(403);
    const vip = await prisma.tag.create({ data: { name: "VIP", color: "#0097B4" } });
    const tag = await request(app).post(`/api/conversations/${conversationId}/contact-tags`).set("Authorization", `Bearer ${otherToken}`).send({ tagId: vip.id });
    expect(tag.status).toBe(403);
    const note = await request(app).post(`/api/conversations/${conversationId}/notes`).set("Authorization", `Bearer ${otherToken}`).send({ body: "oi" });
    expect(note.status).toBe(403);
  });

  it("saves internal notes without sending anything to the customer", async () => {
    const created = await request(app)
      .post(`/api/conversations/${conversationId}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "Cliente pediu desconto no frete" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ authorName: "Bruna", body: "Cliente pediu desconto no frete" });

    const list = await request(app).get(`/api/conversations/${conversationId}/notes`).set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body).toHaveLength(1);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });

  it("starts the no-reply clock on the first unanswered customer message and stops it on the agent's reply", async () => {
    await createInboundMessage({ conversationId, providerMessageId: "in-1", type: "TEXT", body: "Oi" });
    const afterFirst = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(afterFirst.awaitingReplySince).not.toBeNull();

    await createInboundMessage({ conversationId, providerMessageId: "in-2", type: "TEXT", body: "Alguém?" });
    const afterSecond = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(afterSecond.awaitingReplySince?.getTime()).toBe(afterFirst.awaitingReplySince?.getTime());

    const mine = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${ownerToken}`);
    expect(mine.body[0].awaitingReplySince).toBe(afterFirst.awaitingReplySince?.toISOString());

    await createOutboundMessage({ conversationId, agentId: ownerId, type: "TEXT", body: "Olá!" });
    const afterReply = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(afterReply.awaitingReplySince).toBeNull();
  });

  it("conversas anteriores: 3 no painel, as próximas em páginas, com o nome completo do atendente", async () => {
    await prisma.user.update({ where: { id: ownerId }, data: { fullName: "Bruna Carvalho Lopes" } });
    for (let day = 1; day <= 5; day++) {
      await prisma.conversation.create({
        data: { contactId, whatsappConnectionId: connectionId, status: "CLOSED", enteredQueueAt: new Date(`2026-08-0${day}`), closedAt: new Date(`2026-08-0${day}T01:00:00Z`), assignedAgentId: ownerId },
      });
    }
    const panel = (await request(app).get(`/api/conversations/${conversationId}/contact-panel`).set("Authorization", `Bearer ${ownerToken}`)).body;
    expect(panel.previousConversationCount).toBeGreaterThanOrEqual(5);
    expect(panel.previousConversations).toHaveLength(3);
    expect(panel.previousConversations[0].agentName).toBe("Bruna Carvalho Lopes");

    const more = await request(app).get(`/api/conversations/${conversationId}/previous-conversations?skip=3&take=5`).set("Authorization", `Bearer ${ownerToken}`);
    expect(more.status).toBe(200);
    expect(more.body).toHaveLength(panel.previousConversationCount - 3);
    const ids = [...panel.previousConversations, ...more.body].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await request(app).get(`/api/conversations/${conversationId}/previous-conversations?skip=0&take=99`).set("Authorization", `Bearer ${ownerToken}`)).status).toBe(400);
  });

});
