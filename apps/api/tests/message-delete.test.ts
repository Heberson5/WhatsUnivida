import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("ADMIN-only message deletion (local to this app, never touches WhatsApp)", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("only an ADMIN can call DELETE /api/messages/:id", async () => {
    await createTestUser({ email: "manager-del@test.dev", role: "MANAGER" });
    const managerToken = await loginAs("manager-del@test.dev");
    const { conversation } = await createWaitingConversation("5511900001111", connectionId);
    const message = await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Oi" },
    });

    const res = await request(app).delete(`/api/messages/${message.id}`).set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);

    const stillThere = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(stillThere.deletedAt).toBeNull();
  });

  it("an ADMIN can delete a message: it disappears from listMessages but the row (and audit trail) survives, and providerMessageId is untouched", async () => {
    await createTestUser({ email: "admin-del@test.dev", role: "ADMIN" });
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin-del@test.dev" } });
    const adminToken = await loginAs("admin-del@test.dev");
    const { conversation } = await createWaitingConversation("5511900002222", connectionId);
    const keep = await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Fica" },
    });
    const toDelete = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        type: "TEXT",
        status: "SENT",
        body: "Some embora",
        providerMessageId: "wamid-should-stay-unchanged",
      },
    });

    const res = await request(app).delete(`/api/messages/${toDelete.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);

    const deletedRow = await prisma.message.findUniqueOrThrow({ where: { id: toDelete.id } });
    expect(deletedRow.deletedAt).not.toBeNull();
    expect(deletedRow.deletedByUserId).toBe(admin.id);
    // Soft delete only — never rewrites body/providerMessageId, and never
    // calls Baileys, so nothing about the real WhatsApp message changes.
    expect(deletedRow.body).toBe("Some embora");
    expect(deletedRow.providerMessageId).toBe("wamid-should-stay-unchanged");

    const listRes = await request(app)
      .get(`/api/messages/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const ids = listRes.body.items.map((m: { id: string }) => m.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(toDelete.id);

    const audit = await prisma.auditLog.findFirst({ where: { action: "MESSAGE_DELETED", entityId: toDelete.id } });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(admin.id);
  });

  it("deleting an already-deleted message is a harmless no-op (idempotent, no duplicate audit rewrite crash)", async () => {
    await createTestUser({ email: "admin-del2@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-del2@test.dev");
    const { conversation } = await createWaitingConversation("5511900003333", connectionId);
    const message = await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Oi" },
    });

    const first = await request(app).delete(`/api/messages/${message.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(204);
    const second = await request(app).delete(`/api/messages/${message.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(204);
  });

  it("404s for a message id that doesn't exist", async () => {
    await createTestUser({ email: "admin-del3@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-del3@test.dev");
    const res = await request(app)
      .delete("/api/messages/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
