import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";
import { processWebhookPayload } from "../src/modules/meta/meta.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Meta (Instagram/Messenger) webhook — see PROMPT: prepare tudo para integrar com Instagram e Facebook", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("GET /webhook echoes hub.challenge only when hub.verify_token matches the saved one", async () => {
    await prisma.systemSetting.upsert({
      where: { key: "meta" },
      create: { key: "meta", value: { appId: "123", webhookVerifyToken: "s3cret-verify" } },
      update: { value: { appId: "123", webhookVerifyToken: "s3cret-verify" } },
    });

    const ok = await request(app)
      .get("/api/meta/webhook")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "s3cret-verify", "hub.challenge": "12345" });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("12345");

    const wrong = await request(app)
      .get("/api/meta/webhook")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "12345" });
    expect(wrong.status).toBe(403);
  });

  it("a Messenger webhook event opens a conversation that shows up in the shared queue, reusing the same pipeline as WhatsApp", async () => {
    const connection = await prisma.metaConnection.create({
      data: { channel: "MESSENGER", name: "Página de testes", externalPageId: "page-123", status: "CONNECTED" },
    });

    await processWebhookPayload("page", [
      {
        id: "page-123",
        messaging: [
          {
            sender: { id: "psid-abc" },
            recipient: { id: "page-123" },
            timestamp: Date.now(),
            message: { mid: "mid-1", text: "Olá, preciso de ajuda" },
          },
        ],
      },
    ]);

    const contact = await prisma.contact.findFirstOrThrow({ where: { externalUserId: "psid-abc", metaConnectionId: connection.id } });
    expect(contact.channel).toBe("MESSENGER");
    expect(contact.phone).toBeNull();

    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(conversation.channel).toBe("MESSENGER");
    expect(conversation.metaConnectionId).toBe(connection.id);
    expect(conversation.status).toBe("NEW");

    const message = await prisma.message.findUniqueOrThrow({ where: { providerMessageId: "mid-1" } });
    expect(message.body).toBe("Olá, preciso de ajuda");
    expect(message.direction).toBe("INBOUND");

    // An AGENT with no WhatsApp connection at all still sees this Meta
    // conversation in their queue — see conversations.routes.ts's /queue
    // and listQueue's OR clause.
    await createTestUser({ email: "agente-meta@test.dev", role: "AGENT" });
    const token = await loginAs("agente-meta@test.dev");
    const res = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(conversation.id);
    expect(res.body[0].channel).toBe("MESSENGER");
  });

  it("redelivered webhook events (same mid) are deduped instead of creating a second message", async () => {
    await prisma.metaConnection.create({ data: { channel: "MESSENGER", name: "Página", externalPageId: "page-1", status: "CONNECTED" } });
    const event = { id: "page-1", messaging: [{ sender: { id: "psid-1" }, recipient: { id: "page-1" }, timestamp: Date.now(), message: { mid: "dup-1", text: "oi" } }] };

    await processWebhookPayload("page", [event]);
    await processWebhookPayload("page", [event]);

    const count = await prisma.message.count({ where: { providerMessageId: "dup-1" } });
    expect(count).toBe(1);
  });

  it("an echo of our own sent message (is_echo) is skipped, not stored as a second inbound message", async () => {
    await prisma.metaConnection.create({ data: { channel: "MESSENGER", name: "Página", externalPageId: "page-1", status: "CONNECTED" } });
    await processWebhookPayload("page", [
      { id: "page-1", messaging: [{ sender: { id: "psid-1" }, recipient: { id: "page-1" }, timestamp: Date.now(), message: { mid: "echo-1", text: "oi", is_echo: true } }] },
    ]);
    const count = await prisma.message.count({ where: { providerMessageId: "echo-1" } });
    expect(count).toBe(0);
  });
});
