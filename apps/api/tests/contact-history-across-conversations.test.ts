import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("chat history merges across a contact's past (closed) conversations, like one continuous WhatsApp thread", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("shows messages from a contact's earlier CLOSED conversation when they message again and a new conversation opens", async () => {
    const agent = await createTestUser({ email: "agente-hist@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    const agentToken = await loginAs("agente-hist@test.dev");

    const contact = await prisma.contact.create({ data: { phone: "5511977778888", name: "Cliente Antigo", whatsappConnectionId: connectionId } });

    // First attendance: accepted, a couple of messages exchanged, then closed.
    const firstConversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        whatsappConnectionId: connectionId,
        status: "CLOSED",
        assignedAgentId: agent.id,
        enteredQueueAt: new Date(Date.now() - 60_000),
        acceptedAt: new Date(Date.now() - 55_000),
        closedAt: new Date(Date.now() - 30_000),
        lastMessageAt: new Date(Date.now() - 40_000),
      },
    });
    const oldInbound = await prisma.message.create({
      data: {
        conversationId: firstConversation.id,
        direction: "INBOUND",
        type: "TEXT",
        status: "DELIVERED",
        body: "Preciso de ajuda com meu pedido",
        createdAt: new Date(Date.now() - 50_000),
      },
    });
    const oldOutbound = await prisma.message.create({
      data: {
        conversationId: firstConversation.id,
        direction: "OUTBOUND",
        type: "TEXT",
        status: "SENT",
        senderAgentId: agent.id,
        body: "Resolvido, qualquer coisa é só chamar",
        createdAt: new Date(Date.now() - 40_000),
      },
    });

    // The contact writes again — closed conversations are never reopened,
    // this intentionally opens a brand-new one (its own queue card/metrics).
    const { conversation: newConversation, isNewConversation } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id
    );
    expect(isNewConversation).toBe(true);
    expect(newConversation.id).not.toBe(firstConversation.id);

    const newInbound = await prisma.message.create({
      data: {
        conversationId: newConversation.id,
        direction: "INBOUND",
        type: "TEXT",
        status: "DELIVERED",
        body: "Oi, de novo aqui",
        createdAt: new Date(),
      },
    });

    await request(app).post(`/api/conversations/${newConversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);

    const res = await request(app)
      .get(`/api/messages/conversations/${newConversation.id}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.items.map((m: { id: string }) => m.id);
    // The whole thread — both the new conversation's own message and both
    // from the earlier, now-closed one — comes back together.
    expect(ids).toEqual(expect.arrayContaining([oldInbound.id, oldOutbound.id, newInbound.id]));

    // Chronological order (createdAt ascending) is preserved across the boundary.
    const oldInboundIdx = ids.indexOf(oldInbound.id);
    const oldOutboundIdx = ids.indexOf(oldOutbound.id);
    const newInboundIdx = ids.indexOf(newInbound.id);
    expect(oldInboundIdx).toBeLessThan(oldOutboundIdx);
    expect(oldOutboundIdx).toBeLessThan(newInboundIdx);
  });

  it("never leaks a different contact's history into this one", async () => {
    const agent = await createTestUser({ email: "agente-hist2@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    const agentToken = await loginAs("agente-hist2@test.dev");

    const contactA = await prisma.contact.create({ data: { phone: "5511911112222", name: "Cliente A", whatsappConnectionId: connectionId } });
    const contactB = await prisma.contact.create({ data: { phone: "5511933334444", name: "Cliente B", whatsappConnectionId: connectionId } });

    const convoA = await prisma.conversation.create({
      data: { contactId: contactA.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: agent.id, enteredQueueAt: new Date(), lastMessageAt: new Date() },
    });
    await prisma.message.create({ data: { conversationId: convoA.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Mensagem do Cliente A" } });

    const convoB = await prisma.conversation.create({
      data: { contactId: contactB.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: agent.id, enteredQueueAt: new Date(), lastMessageAt: new Date() },
    });
    await prisma.message.create({ data: { conversationId: convoB.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Mensagem do Cliente B" } });

    const res = await request(app)
      .get(`/api/messages/conversations/${convoA.id}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    const bodies = res.body.items.map((m: { body: string }) => m.body);
    expect(bodies).toContain("Mensagem do Cliente A");
    expect(bodies).not.toContain("Mensagem do Cliente B");
  });
});
