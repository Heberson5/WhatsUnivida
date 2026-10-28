import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("respostas rápidas (menu de \"/\" no atendimento)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("um MANAGER pode cadastrar; o atalho é normalizado (sem \"/\", minúsculo)", async () => {
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "gestora@test.dev", role: "MANAGER", displayName: "Gestora" });
    const token = await loginAs("gestora@test.dev");

    const res = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Boas-vindas", shortcut: "/BoasVindas", text: "Olá! Como posso ajudar?", connectionScope: { allConnections: false, connectionIds: [connection.id] } });

    expect(res.status).toBe(201);
    expect(res.body.shortcut).toBe("boasvindas");
    expect(res.body.connectionScope).toEqual({ allConnections: false, connections: [{ id: connection.id, name: "Suporte" }] });
  });

  it("um ADMIN também pode gerenciar; um AGENT é bloqueado por padrão", async () => {
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    await createTestUser({ email: "agente@test.dev", role: "AGENT", displayName: "Agente", connectionScope: { allConnections: false, connectionIds: [connection.id] } });

    const adminToken = await loginAs("admin@test.dev");
    const adminRes = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Despedida", shortcut: "tchau", text: "Até logo!", connectionScope: { allConnections: false, connectionIds: [connection.id] } });
    expect(adminRes.status).toBe(201);

    const agentToken = await loginAs("agente@test.dev");
    const agentRes = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ name: "Outra", shortcut: "outra", text: "Texto", connectionScope: { allConnections: false, connectionIds: [connection.id] } });
    expect(agentRes.status).toBe(403);
  });

  it("rejeita um atalho duplicado na mesma conexão, mas permite o mesmo atalho em conexões diferentes", async () => {
    const suporte = await createTestConnection("Suporte");
    const vendas = await createTestConnection("Vendas");
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    const token = await loginAs("admin@test.dev");

    const first = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Boas-vindas", shortcut: "oi", text: "Olá!", connectionScope: { allConnections: false, connectionIds: [suporte.id] } });
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Outra saudação", shortcut: "oi", text: "E aí!", connectionScope: { allConnections: false, connectionIds: [suporte.id] } });
    expect(duplicate.status).toBe(409);

    const sameShortcutOtherConnection = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Boas-vindas Vendas", shortcut: "oi", text: "Olá, vendas!", connectionScope: { allConnections: false, connectionIds: [vendas.id] } });
    expect(sameShortcutOtherConnection.status).toBe(201);
  });

  it("um atalho de \"todas as conexões\" conflita com o mesmo atalho em qualquer conexão", async () => {
    const suporte = await createTestConnection("Suporte");
    await createTestConnection("Vendas");
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    const token = await loginAs("admin@test.dev");

    const specific = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Oi suporte", shortcut: "oi", text: "Olá!", connectionScope: { allConnections: false, connectionIds: [suporte.id] } });
    expect(specific.status).toBe(201);

    const everywhere = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Oi geral", shortcut: "oi", text: "Olá a todos!", connectionScope: { allConnections: true, connectionIds: [] } });
    expect(everywhere.status).toBe(409);

    const noConnection = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sem conexão", shortcut: "nada", text: "x", connectionScope: { allConnections: false, connectionIds: [] } });
    expect(noConnection.status).toBe(400);
  });

  it("PATCH edita e DELETE remove; GET / lista todas as conexões (tela de gestão)", async () => {
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    const token = await loginAs("admin@test.dev");

    const created = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Boas-vindas", shortcut: "oi", text: "Olá!", connectionScope: { allConnections: false, connectionIds: [connection.id] } });

    const updated = await request(app)
      .patch(`/api/quick-replies/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Olá! Em que posso ajudar hoje?" });
    expect(updated.status).toBe(200);
    expect(updated.body.text).toBe("Olá! Em que posso ajudar hoje?");
    expect(updated.body.shortcut).toBe("oi"); // unchanged fields survive a partial patch

    const listed = await request(app).get("/api/quick-replies").set("Authorization", `Bearer ${token}`);
    expect(listed.body).toHaveLength(1);

    const deleted = await request(app).delete(`/api/quick-replies/${created.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(204);

    const listedAfter = await request(app).get("/api/quick-replies").set("Authorization", `Bearer ${token}`);
    expect(listedAfter.body).toHaveLength(0);
  });

  it("o atendente vê, ao digitar \"/\" numa conversa, só as respostas da conexão daquela conversa — sem precisar da permissão de gerenciar", async () => {
    const suporte = await createTestConnection("Suporte");
    const vendas = await createTestConnection("Vendas");
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    const adminToken = await loginAs("admin@test.dev");
    await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Boas-vindas Suporte", shortcut: "oi", text: "Olá do suporte!", connectionScope: { allConnections: false, connectionIds: [suporte.id] } });
    await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Boas-vindas Vendas", shortcut: "oi", text: "Olá de vendas!", connectionScope: { allConnections: false, connectionIds: [vendas.id] } });

    const agent = await createTestUser({ email: "agente@test.dev", role: "AGENT", displayName: "Agente", connectionScope: { allConnections: false, connectionIds: [suporte.id] } });
    const contact = await prisma.contact.create({ data: { phone: "5511900001111", whatsappConnectionId: suporte.id } });
    const conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        whatsappConnectionId: suporte.id,
        status: "IN_PROGRESS",
        assignedAgentId: agent.id,
        enteredQueueAt: new Date(),
        lastMessageAt: new Date(),
      },
    });

    await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Despedida", shortcut: "tchau", text: "Até logo!", connectionScope: { allConnections: true, connectionIds: [] } });

    const agentToken = await loginAs("agente@test.dev");
    // No RESPOSTAS_RAPIDAS_GERENCIAR permission was ever granted to this agent.
    const res = await request(app).get(`/api/quick-replies/conversation/${conversation.id}`).set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.map((r: { text: string }) => r.text)).toEqual(["Olá do suporte!", "Até logo!"]);
  });

  it("um AGENT não consegue ver as respostas rápidas de uma conversa que não é sua", async () => {
    const connection = await createTestConnection("Suporte");
    const owner = await createTestUser({ email: "dono@test.dev", role: "AGENT", displayName: "Dono", connectionScope: { allConnections: false, connectionIds: [connection.id] } });
    await createTestUser({ email: "outro@test.dev", role: "AGENT", displayName: "Outro", connectionScope: { allConnections: false, connectionIds: [connection.id] } });
    const contact = await prisma.contact.create({ data: { phone: "5511900002222", whatsappConnectionId: connection.id } });
    const conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        whatsappConnectionId: connection.id,
        status: "IN_PROGRESS",
        assignedAgentId: owner.id,
        enteredQueueAt: new Date(),
        lastMessageAt: new Date(),
      },
    });

    const otherToken = await loginAs("outro@test.dev");
    const res = await request(app).get(`/api/quick-replies/conversation/${conversation.id}`).set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });
});
