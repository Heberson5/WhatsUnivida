import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createAutoMessageTemplate } from "../src/modules/auto-message-templates/auto-message-templates.service";
import {
  findOrCreateContact,
  findOrOpenConversationForDeviceSentMessage,
  requeueUnansweredDeviceConversations,
} from "../src/modules/conversations/conversations.service";
import { createInboundMessage } from "../src/modules/messages/messages.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("conversa iniciada pelo celular", () => {
  let connectionId: string;
  let agentToken: string;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.autoMessageTemplate.deleteMany({ where: { trigger: "ACCEPT" } });
    await createTestUser({ email: "admin-cel@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-cel@test.dev");
    const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Celular" });
    connectionId = connection.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s
    await createTestUser({ email: "ana-cel@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    agentToken = await loginAs("ana-cel@test.dev");
    await createAutoMessageTemplate({
      trigger: "ACCEPT",
      name: "Geral",
      text: "Olá, sou {{atendente}} e vou te atender",
      active: true,
      connectionScope: { allConnections: true, connectionIds: [] },
    });
  }, 15000);

  afterAll(async () => {
    await prisma.autoMessageTemplate.deleteMany({ where: { trigger: "ACCEPT" } });
    await prisma.$disconnect();
  });

  async function phoneConversationAnsweredBy(phone: string) {
    const contact = await findOrCreateContact(connectionId, phone, "Cliente");
    const { conversation } = await findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);
    await createInboundMessage({ conversationId: conversation.id, providerMessageId: `in-${phone}`, type: "TEXT", body: "Oi, e aí?" });
    return conversation;
  }

  it("fica no celular enquanto o prazo não passa e vem para a fila quando o cliente fica sem resposta", async () => {
    const conversation = await phoneConversationAnsweredBy("5511990002001");
    expect(conversation).toMatchObject({ status: "HANDLED_EXTERNALLY", startedOnDevice: true });

    expect(await requeueUnansweredDeviceConversations(new Date(Date.now() + 4 * 60_000))).toHaveLength(0);
    const requeued = await requeueUnansweredDeviceConversations(new Date(Date.now() + 6 * 60_000));
    expect(requeued.map((c) => c.id)).toEqual([conversation.id]);

    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.status).toBe("WAITING");
    const note = await prisma.conversationNote.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(note.body).toContain("5 min sem resposta");
  });

  it("uma resposta pelo celular dentro do prazo mantém a conversa no celular", async () => {
    const conversation = await phoneConversationAnsweredBy("5511990002002");
    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: "5511990002002" } });
    await findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { awaitingReplySince: null } }); // what a phone reply records
    expect(await requeueUnansweredDeviceConversations(new Date(Date.now() + 60 * 60_000))).toHaveLength(0);
  });

  it("com o prazo desligado na conexão, nunca vai para a fila", async () => {
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { deviceReplyTimeoutMinutes: null } });
    await phoneConversationAnsweredBy("5511990002003");
    expect(await requeueUnansweredDeviceConversations(new Date(Date.now() + 60 * 60_000))).toHaveLength(0);
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { deviceReplyTimeoutMinutes: 5 } });
  });

  it("aceitar uma conversa que veio do celular não envia a mensagem de aceite", async () => {
    const conversation = await phoneConversationAnsweredBy("5511990002004");
    await requeueUnansweredDeviceConversations(new Date(Date.now() + 6 * 60_000));
    const provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    const before = provider.sentTexts.length;

    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.startedOnDevice).toBe(true);
    expect(provider.sentTexts.length).toBe(before);
    const notes = await prisma.conversationNote.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
    expect(notes.at(-1)?.body).toContain("a mensagem de aceite não foi enviada");
  }, 10000);
});
