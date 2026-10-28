import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("contexto do cliente: conversas anteriores e observação fixa", () => {
  let managerToken: string;
  let agentToken: string;
  let currentId: string;
  let previousId: string;

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-ctx@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-ctx@test.dev");
    const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Contexto" });
    const connectionId = connection.body.id;
    const agent = await createTestUser({ email: "ana-ctx@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    await createTestUser({ email: "gestor-ctx@test.dev", role: "MANAGER", displayName: "Gestor" });
    agentToken = await loginAs("ana-ctx@test.dev");
    managerToken = await loginAs("gestor-ctx@test.dev");

    const { contact, conversation: previous } = await createWaitingConversation("5511990004001", connectionId);
    await prisma.conversation.update({ where: { id: previous.id }, data: { status: "CLOSED", assignedAgentId: agent.id, closedAt: new Date() } });
    await prisma.message.create({ data: { conversationId: previous.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Meu boleto venceu" } });
    await prisma.conversationNote.create({ data: { conversationId: previous.id, authorId: agent.id, body: "Enviado novo boleto" } });
    await prisma.satisfactionSurvey.create({ data: { conversationId: previous.id, contactId: contact.id, whatsappConnectionId: connectionId, agentId: agent.id, score: 9, expiresAt: new Date() } });
    const current = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: agent.id, enteredQueueAt: new Date(), lastMessageAt: new Date() },
    });
    currentId = current.id;
    previousId = previous.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("abre a conversa anterior com mensagens, notas e a nota da pesquisa", async () => {
    const res = await request(app).get(`/api/conversations/${currentId}/previous/${previousId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(["Meu boleto venceu"]);
    expect(res.body.notes[0].body).toBe("Enviado novo boleto");
    expect(res.body.survey).toEqual({ score: 9, answerText: null });
  });

  it("não abre conversa de outro contato", async () => {
    const res = await request(app).get(`/api/conversations/${currentId}/previous/${currentId.replace(/.$/, "0")}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("a observação fixa só é editada com a permissão e aparece no painel", async () => {
    const denied = await request(app).put(`/api/conversations/${currentId}/contact-pinned-note`).set("Authorization", `Bearer ${agentToken}`).send({ text: "Prefere à tarde" });
    expect(denied.status).toBe(403);
    const saved = await request(app).put(`/api/conversations/${currentId}/contact-pinned-note`).set("Authorization", `Bearer ${managerToken}`).send({ text: "Prefere à tarde" });
    expect(saved.status).toBe(200);
    const panel = await request(app).get(`/api/conversations/${currentId}/contact-panel`).set("Authorization", `Bearer ${agentToken}`);
    expect(panel.body.pinnedNote).toMatchObject({ text: "Prefere à tarde", updatedByName: "Gestor" });
    await request(app).put(`/api/conversations/${currentId}/contact-pinned-note`).set("Authorization", `Bearer ${managerToken}`).send({ text: null }).expect(200);
    expect((await prisma.contact.findFirstOrThrow({ where: { phone: "5511990004001" } })).pinnedNote).toBeNull();
  });
});
