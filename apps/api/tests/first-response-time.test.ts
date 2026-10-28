import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { createAutoMessageTemplate } from "../src/modules/auto-message-templates/auto-message-templates.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import { transferConversation } from "../src/modules/conversations/conversations.service";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const ALL_CONNECTIONS = { allConnections: true, connectionIds: [] };

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

// See PROMPT: "no dashboard o tempo da primeira resposta, não deve considerar o envio da mensagem de aceite. deve
// considerar o que o atendente envia depois."
describe("Dashboard › 1ª resposta: só conta o que o atendente escreve", () => {
  let adminToken: string;
  let agentToken: string;
  let agentId: string;
  let connectionId: string;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.autoMessageTemplate.deleteMany({ where: { trigger: "ACCEPT" } });
    await createTestUser({ email: "admin-1a-resposta@test.dev", role: "ADMIN" });
    adminToken = await loginAs("admin-1a-resposta@test.dev");
    const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "1ª resposta" });
    connectionId = connection.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s
    agentId = (await createTestUser({ email: "ana-1a-resposta@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId })).id;
    agentToken = await loginAs("ana-1a-resposta@test.dev");
    await createAutoMessageTemplate({ trigger: "ACCEPT", name: "Boas-vindas", text: "Olá! Sou {{atendente}} e vou te atender.", active: true, connectionScope: ALL_CONNECTIONS });
    await createClosingMessage({ name: "Até logo", text: "Obrigado pelo contato!", active: true, userIds: [agentId], connectionScope: ALL_CONNECTIONS });
  }, 15000);

  afterAll(async () => {
    await prisma.autoMessageTemplate.deleteMany({ where: { trigger: "ACCEPT" } });
    await prisma.$disconnect();
  });

  async function accept(phone: string) {
    const { conversation } = await createWaitingConversation(phone, connectionId);
    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    return conversation.id;
  }

  const outbound = (conversationId: string) =>
    prisma.message.findMany({ where: { conversationId, direction: "OUTBOUND" }, orderBy: { createdAt: "asc" }, select: { body: true, senderAgentId: true, createdAt: true } });

  async function avgFirstResponseMs() {
    const res = await request(app).get("/api/dashboard").query({ period: "today" }).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return res.body.timings.avgFirstResponseMs as number | null;
  }

  it("a mensagem de aceite não é a 1ª resposta; a mensagem que o atendente escreve depois é", async () => {
    const conversationId = await accept("5511990007001");
    const [acceptMessage] = await outbound(conversationId);
    expect(acceptMessage).toMatchObject({ body: "Olá! Sou Ana e vou te atender.", senderAgentId: agentId });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).firstResponseAt).toBeNull();
    expect(await avgFirstResponseMs()).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const reply = await request(app).post(`/api/messages/conversations/${conversationId}/text`).set("Authorization", `Bearer ${agentToken}`).send({ body: "Como posso ajudar?" });
    expect(reply.status).toBe(201);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const written = (await outbound(conversationId)).find((m) => m.body === "Como posso ajudar?")!;
    expect(conversation.firstResponseAt!.getTime()).toBeGreaterThanOrEqual(written.createdAt.getTime());
    expect(conversation.firstResponseAt!.getTime() - written.createdAt.getTime()).toBeLessThan(1000);
    const expected = conversation.firstResponseAt!.getTime() - conversation.acceptedAt!.getTime();
    expect(expected).toBeGreaterThanOrEqual(1200);
    expect(await avgFirstResponseMs()).toBe(expected);
  }, 15000);

  it("encerrar sem ter escrito nada: a mensagem de encerramento automática também não conta", async () => {
    const conversationId = await accept("5511990007002");
    const close = await request(app).post(`/api/conversations/${conversationId}/close`).set("Authorization", `Bearer ${agentToken}`);
    expect(close.status).toBe(200);

    expect((await outbound(conversationId)).map((m) => m.body)).toEqual(["Olá! Sou Ana e vou te atender.", "Obrigado pelo contato!"]);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).firstResponseAt).toBeNull();
  }, 15000);

  it("transferida: a 1ª resposta conta a partir do novo aceite, nunca fica negativa", async () => {
    const bruno = await createTestUser({ email: "bruno-1a-resposta@test.dev", role: "AGENT", displayName: "Bruno", whatsappConnectionId: connectionId });
    const conversationId = await accept("5511990007003");
    await request(app).post(`/api/messages/conversations/${conversationId}/text`).set("Authorization", `Bearer ${agentToken}`).send({ body: "Já te passo para o financeiro" });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).firstResponseAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 300));
    await transferConversation(conversationId, agentId, bruno.id, agentId, undefined);
    const transferred = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(transferred.firstResponseAt).toBeNull(); // Bruno hasn't answered yet

    const brunoToken = await loginAs("bruno-1a-resposta@test.dev");
    await request(app).post(`/api/messages/conversations/${conversationId}/text`).set("Authorization", `Bearer ${brunoToken}`).send({ body: "Oi, sou o Bruno" });
    const answered = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(answered.firstResponseAt!.getTime()).toBeGreaterThanOrEqual(answered.acceptedAt!.getTime());
    expect(await avgFirstResponseMs()).toBeGreaterThanOrEqual(0);
  }, 15000);

  it("conversas antigas com a resposta antes do aceite ficam fora da média", async () => {
    await prisma.conversation.updateMany({ data: { firstResponseAt: null } });
    const conversationId = await accept("5511990007004");
    const { acceptedAt } = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    await prisma.conversation.update({ where: { id: conversationId }, data: { firstResponseAt: new Date(acceptedAt!.getTime() - 260_000) } });
    expect(await avgFirstResponseMs()).toBeNull();
  }, 15000);
});
