import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";
import { importHistoricalMessages } from "../src/modules/conversations/conversations.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("WhatsApp history sync import", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("archives a synced batch as a CLOSED conversation, never touching the live queue", async () => {
    await importHistoricalMessages(connectionId, [
      { providerMessageId: "hist-1", phone: "5511990000001", fromMe: false, type: "TEXT", body: "Oi, tudo bem?", timestamp: new Date("2026-01-01T10:00:00Z") },
      { providerMessageId: "hist-2", phone: "5511990000001", fromMe: true, type: "TEXT", body: "Tudo sim, e voce?", timestamp: new Date("2026-01-01T10:01:00Z") },
    ]);

    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: "5511990000001", whatsappConnectionId: connectionId } });
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(conversation.status).toBe("CLOSED");

    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
    expect(messages).toHaveLength(2);
    expect(messages[0].direction).toBe("INBOUND");
    expect(messages[1].direction).toBe("OUTBOUND");
    expect(messages[1].status).toBe("SENT");
  });

  it("is idempotent by providerMessageId — re-importing the same batch never duplicates", async () => {
    const batch = [{ providerMessageId: "hist-dup", phone: "5511990000002", fromMe: false, type: "TEXT" as const, body: "Ola", timestamp: new Date("2026-01-01T10:00:00Z") }];
    await importHistoricalMessages(connectionId, batch);
    await importHistoricalMessages(connectionId, batch);

    const count = await prisma.message.count({ where: { providerMessageId: "hist-dup" } });
    expect(count).toBe(1);
  });

  it("attaches historical messages to an existing conversation instead of forking a duplicate one", async () => {
    const contact = await prisma.contact.create({ data: { phone: "5511990000003", whatsappConnectionId: connectionId, name: "Cliente" } });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", enteredQueueAt: new Date(), lastMessageAt: new Date("2026-01-05T00:00:00Z") },
    });

    await importHistoricalMessages(connectionId, [
      { providerMessageId: "hist-old", phone: "5511990000003", fromMe: false, type: "TEXT", body: "Mensagem antiga", timestamp: new Date("2026-01-01T00:00:00Z") },
    ]);

    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id } });
    expect(messages.map((m) => m.providerMessageId)).toContain("hist-old");

    // An older imported message must never make the conversation look more
    // recently active than it actually is.
    const refreshed = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(refreshed.status).toBe("IN_PROGRESS");
    expect(refreshed.lastMessageAt.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("refuses to delete a connection that has history, with a clear message instead of a crash", async () => {
    await createTestUser({ email: "admin7@test.dev", role: "ADMIN" });
    const token = await loginAs("admin7@test.dev");

    await importHistoricalMessages(connectionId, [
      { providerMessageId: "hist-block-delete", phone: "5511990000004", fromMe: false, type: "TEXT", body: "Oi", timestamp: new Date() },
    ]);

    const res = await request(app).delete(`/api/whatsapp/connections/${connectionId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/historico/i);
  });
});
