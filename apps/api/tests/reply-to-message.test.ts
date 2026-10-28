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

describe("replying to a specific message forwards a real quote (not just a bare key) to the provider", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("sends the original message's own providerMessageId and text alongside the reply, so WhatsApp can build the quoted-reply stanza", async () => {
    // Regression: BaileysWhatsAppProvider.sendText used to pass Baileys a
    // quoted key with no quoted.message content — Baileys' own message
    // builder reads quoted.message to render the reply preview and throws
    // when it's missing, silently failing every reply (caught and
    // swallowed by sendOutboundText, which just marked the message FAILED).
    await resetDatabase();
    await createTestUser({ email: "admin-reply@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-reply@test.dev");
    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "SuporteReply" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    await createTestUser({
      email: "agente-reply@test.dev",
      role: "AGENT",
      displayName: "Agente Reply",
      whatsappConnectionId: created.body.id,
    });
    const agentToken = await loginAs("agente-reply@test.dev");

    const { conversation } = await createWaitingConversation("5511990004444", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);

    const original = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "INBOUND",
        type: "TEXT",
        status: "DELIVERED",
        body: "Qual o horario de funcionamento?",
        providerMessageId: "wa-msg-original-1",
      },
    });

    const res = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/text`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ body: "Funcionamos das 9h as 18h", replyToMessageId: original.id });
    expect(res.status).toBe(201);
    expect(res.body.status).not.toBe("FAILED");

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    const sent = provider.sentTexts.at(-1);
    expect(sent?.replyToProviderMessageId).toBe("wa-msg-original-1");
    expect(sent?.replyToText).toBe("Qual o horario de funcionamento?");
  }, 10000);
});
