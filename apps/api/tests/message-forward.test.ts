import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Encaminhar mensagem", () => {
  let connectionId: string;
  let agentToken: string;
  let otherToken: string;
  let provider: MockWhatsAppProvider;
  const conversationIds: string[] = [];

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-fwd@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-fwd@test.dev");
    const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Encaminhar" });
    connectionId = connection.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    await createTestUser({ email: "ana-fwd@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    await createTestUser({ email: "bia-fwd@test.dev", role: "AGENT", displayName: "Bia", whatsappConnectionId: connectionId });
    agentToken = await loginAs("ana-fwd@test.dev");
    otherToken = await loginAs("bia-fwd@test.dev");
    for (const phone of ["5511990003001", "5511990003002", "5511990003003"]) {
      const { conversation } = await createWaitingConversation(phone, connectionId);
      await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`).expect(200);
      conversationIds.push(conversation.id);
    }
  }, 20000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("encaminha um texto para várias conversas e registra a origem", async () => {
    const sent = await request(app).post(`/api/messages/conversations/${conversationIds[0]}/text`).set("Authorization", `Bearer ${agentToken}`).send({ body: "Segue o horário: 8h às 18h" });
    const before = provider.sentTexts.length;
    const res = await request(app)
      .post(`/api/messages/${sent.body.id}/forward`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ conversationIds: [conversationIds[1], conversationIds[2]] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(provider.sentTexts.length - before).toBe(2);
    const copies = await prisma.message.findMany({ where: { forwardedFromMessageId: sent.body.id } });
    expect(copies.map((m) => m.conversationId).sort()).toEqual([conversationIds[1], conversationIds[2]].sort());
    const list = await request(app).get(`/api/messages/conversations/${conversationIds[1]}`).set("Authorization", `Bearer ${agentToken}`);
    expect(list.body.items.find((m: { id: string }) => m.id === copies[0].id || m.id === copies[1].id).forwarded).toBe(true);
  });

  it("encaminha uma foto com o arquivo copiado", async () => {
    const sent = await request(app)
      .post(`/api/messages/conversations/${conversationIds[0]}/file`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("file", PNG, { filename: "foto.png", contentType: "image/png" });
    const before = provider.sentFiles.length;
    const res = await request(app).post(`/api/messages/${sent.body.id}/forward`).set("Authorization", `Bearer ${agentToken}`).send({ conversationIds: [conversationIds[1]] });
    expect(res.status).toBe(201);
    expect(provider.sentFiles.length - before).toBe(1);
    const copy = await prisma.message.findFirstOrThrow({ where: { forwardedFromMessageId: sent.body.id }, include: { attachments: true } });
    expect(copy.type).toBe("IMAGE");
    expect(copy.attachments[0].fileName).toBe("foto.png");
  });

  it("não deixa encaminhar para a conversa de outro atendente", async () => {
    const sent = await request(app).post(`/api/messages/conversations/${conversationIds[0]}/text`).set("Authorization", `Bearer ${agentToken}`).send({ body: "Oi" });
    const { conversation } = await createWaitingConversation("5511990003009", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${otherToken}`).expect(200);
    const res = await request(app).post(`/api/messages/${sent.body.id}/forward`).set("Authorization", `Bearer ${agentToken}`).send({ conversationIds: [conversation.id] });
    expect(res.status).toBe(403);
  });
});
