import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import { resetDatabase, createTestConnection, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("mergeConversations (cleaning up a pre-existing duplicate)", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("moves every message from the duplicate into the real conversation, folds the duplicate contact in, and deletes the duplicate", async () => {
    const { contact: realContact, conversation: real } = await createWaitingConversation("5511977776655", connectionId);
    await prisma.message.create({
      data: { conversationId: real.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Oi, tudo bem?" },
    });

    // The duplicate: a second Contact (the @lid-digits one from the bug),
    // its own conversation, with a message that arrived on it.
    const { contact: dupContact, conversation: duplicate } = await createWaitingConversation("199887766554433", connectionId);
    const dupMessage = await prisma.message.create({
      data: { conversationId: duplicate.id, direction: "OUTBOUND", type: "TEXT", status: "SENT", body: "Segue o comprovante" },
    });

    const merged = await conversationsService.mergeConversations(duplicate.id, real.id);
    expect(merged.id).toBe(real.id);

    const movedMessage = await prisma.message.findUniqueOrThrow({ where: { id: dupMessage.id } });
    expect(movedMessage.conversationId).toBe(real.id);

    const messagesOnReal = await prisma.message.count({ where: { conversationId: real.id } });
    expect(messagesOnReal).toBe(2);

    const stillExists = await prisma.conversation.findUnique({ where: { id: duplicate.id } });
    expect(stillExists).toBeNull();

    const dupContactStillExists = await prisma.contact.findUnique({ where: { id: dupContact.id } });
    expect(dupContactStillExists).toBeNull();

    const realContactAfter = await prisma.contact.findUniqueOrThrow({ where: { id: realContact.id } });
    expect(realContactAfter.id).toBe(realContact.id); // untouched, still the survivor

    expect(merged.lastMessageAt.getTime()).toBe(movedMessage.createdAt.getTime());
  });

  it("rejects merging conversations from two different WhatsApp connections", async () => {
    const otherConnectionId = (await createTestConnection("Vendas")).id;
    const { conversation: a } = await createWaitingConversation("5511911112222", connectionId);
    const { conversation: b } = await createWaitingConversation("5511933334444", otherConnectionId);

    await expect(conversationsService.mergeConversations(b.id, a.id)).rejects.toThrow();
  });

  it("only an ADMIN can call the /merge route", async () => {
    await createTestUser({ email: "manager-merge@test.dev", role: "MANAGER" });
    const managerToken = await loginAs("manager-merge@test.dev");
    const { conversation: a } = await createWaitingConversation("5511911113333", connectionId);
    const { conversation: b } = await createWaitingConversation("5511922224444", connectionId);

    const res = await request(app)
      .post(`/api/conversations/${b.id}/merge`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ intoConversationId: a.id });
    expect(res.status).toBe(403);
  });

  it("an ADMIN can merge via the route and the duplicate disappears from the queue", async () => {
    await createTestUser({ email: "admin-merge@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-merge@test.dev");
    const { conversation: a } = await createWaitingConversation("5511911114444", connectionId);
    const { conversation: b } = await createWaitingConversation("5511922225555", connectionId);

    const res = await request(app)
      .post(`/api/conversations/${b.id}/merge`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ intoConversationId: a.id });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(a.id);

    const queue = await conversationsService.listQueue([connectionId]);
    expect(queue.some((c) => c.id === b.id)).toBe(false);
    expect(queue.some((c) => c.id === a.id)).toBe(true);
  });
});
