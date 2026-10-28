import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("opening a conversation in the app syncs a WhatsApp read receipt to the linked phone", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("sends a read receipt for the still-unread inbound messages when the agent marks the conversation read", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-read@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-read@test.dev");
    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "SuporteRead" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    await createTestUser({
      email: "agente-read@test.dev",
      role: "AGENT",
      displayName: "Agente Read",
      whatsappConnectionId: created.body.id,
    });
    const agentToken = await loginAs("agente-read@test.dev");

    const { contact, conversation } = await createWaitingConversation("5511990005555", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "INBOUND",
        type: "TEXT",
        status: "DELIVERED",
        body: "Preciso de ajuda",
        providerMessageId: "wa-msg-inbound-1",
      },
    });

    const readRes = await request(app)
      .post(`/api/conversations/${conversation.id}/read`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(readRes.status).toBe(204);

    // syncReadReceiptToDevice is fire-and-forget, not awaited by the route: wait for it (a busy machine takes longer).
    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    for (let i = 0; i < 60 && provider.readReceiptsSent.length === 0; i++) await wait(50);
    expect(provider.readReceiptsSent.at(-1)).toEqual({
      chatId: `${contact.phone}@s.whatsapp.net`,
      providerMessageIds: ["wa-msg-inbound-1"],
    });
  }, 10000);

  it("does not call markRead again once there is nothing new to mark read", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-read2@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-read2@test.dev");
    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "SuporteRead2" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));

    await createTestUser({
      email: "agente-read2@test.dev",
      role: "AGENT",
      displayName: "Agente Read2",
      whatsappConnectionId: created.body.id,
    });
    const agentToken = await loginAs("agente-read2@test.dev");

    const { conversation } = await createWaitingConversation("5511990006666", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);

    await request(app).post(`/api/conversations/${conversation.id}/read`).set("Authorization", `Bearer ${agentToken}`);
    await wait(50);

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    expect(provider.readReceiptsSent).toHaveLength(0); // nothing was ever unread — no wasted call
  }, 10000);
});
