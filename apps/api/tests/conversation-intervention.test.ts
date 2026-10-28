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

describe("Gestão › Intervir na conversa", () => {
  let conversationId: string;
  let agentToken: string;
  let managerToken: string;
  let adminToken: string;
  let agentId: string;
  let managerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const connection = await createTestConnection("Suporte");
    agentId = (await createTestUser({ email: "ana@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connection.id })).id;
    managerId = (await createTestUser({ email: "carlos@test.dev", role: "ADMIN", displayName: "Carlos" })).id;
    await createTestUser({ email: "bia@test.dev", role: "ADMIN", displayName: "Bia" });
    const { conversation } = await createWaitingConversation("5511990001111", connection.id);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "IN_PROGRESS", assignedAgentId: agentId, acceptedAt: new Date() } });
    conversationId = conversation.id;
    agentToken = await loginAs("ana@test.dev");
    managerToken = await loginAs("carlos@test.dev");
    adminToken = await loginAs("bia@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const sendText = (token: string, body: string) =>
    request(app).post(`/api/messages/conversations/${conversationId}/text`).set("Authorization", `Bearer ${token}`).send({ body });

  it("durante a intervenção só o gestor responde; a atendente só deixa notas, que avisam o gestor", async () => {
    const res = await request(app).post(`/api/conversations/${conversationId}/intervene`).set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.intervention).toMatchObject({ userId: managerId, name: "Carlos" });

    // The agent is told, and can no longer write to the customer, transfer or close.
    expect(await prisma.notification.count({ where: { userId: agentId } })).toBe(1);
    expect((await sendText(agentToken, "oi")).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${conversationId}/close`).set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);

    // The manager writes to the customer.
    expect((await sendText(managerToken, "Olá, aqui é o Carlos")).status).toBe(201);

    // The agent's note reaches the manager's bell.
    const note = await request(app).post(`/api/conversations/${conversationId}/notes`).set("Authorization", `Bearer ${agentToken}`).send({ body: "Cliente já pediu reembolso" });
    expect(note.status).toBe(201);
    expect(await prisma.notification.findFirst({ where: { userId: managerId } })).toMatchObject({ body: "Cliente já pediu reembolso" });

    // Another manager can't take it at the same time.
    expect((await request(app).post(`/api/conversations/${conversationId}/intervene`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(409);
  });

  it("Devolver: a atendente volta a responder", async () => {
    await request(app).post(`/api/conversations/${conversationId}/intervene`).set("Authorization", `Bearer ${managerToken}`);
    const res = await request(app).post(`/api/conversations/${conversationId}/intervention/end`).set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.intervention).toBeNull();
    expect((await sendText(agentToken, "voltei")).status).toBe(201);
    expect((await sendText(managerToken, "não devo")).status).toBe(403);
    const events = await prisma.conversationEvent.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["INTERVENTION_STARTED", "INTERVENTION_ENDED"]);
  });

  it("transferir pela Gestão encerra a intervenção", async () => {
    const other = await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "João", presence: "ONLINE" });
    await request(app).post(`/api/conversations/${conversationId}/intervene`).set("Authorization", `Bearer ${managerToken}`);
    const res = await request(app).post(`/api/conversations/${conversationId}/gestao-transfer`).set("Authorization", `Bearer ${managerToken}`).send({ toAgentId: other.id });
    expect(res.status).toBe(200);
    expect(res.body.intervention).toBeNull();
  });

  it("não intervém em conversa que não está em atendimento", async () => {
    await prisma.conversation.update({ where: { id: conversationId }, data: { status: "WAITING", assignedAgentId: null } });
    expect((await request(app).post(`/api/conversations/${conversationId}/intervene`).set("Authorization", `Bearer ${managerToken}`)).status).toBe(400);
  });
});
