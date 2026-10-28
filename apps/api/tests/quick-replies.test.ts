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
      .send({ name: "Boas-vindas", shortcut: "/BoasVindas", text: "Olá! Como posso ajudar?", whatsappConnectionId: connection.id });

    expect(res.status).toBe(201);
    expect(res.body.shortcut).toBe("boasvindas");
    expect(res.body.whatsappConnectionName).toBe("Suporte");
  });

  it("um ADMIN também pode gerenciar; um AGENT é bloqueado por padrão", async () => {
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    await createTestUser({ email: "agente@test.dev", role: "AGENT", displayName: "Agente", whatsappConnectionId: connection.id });

    const adminToken = await loginAs("admin@test.dev");
    const adminRes = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Despedida", shortcut: "tchau", text: "Até logo!", whatsappConnectionId: connection.id });
    expect(adminRes.status).toBe(201);

    const agentToken = await loginAs("agente@test.dev");
    const agentRes = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ name: "Outra", shortcut: "outra", text: "Texto", whatsappConnectionId: connection.id });
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
      .send({ name: "Boas-vindas", shortcut: "oi", text: "Olá!", whatsappConnectionId: suporte.id });
    expect(first.status).toBe(201);

    const duplicate = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Outra saudação", shortcut: "oi", text: "E aí!", whatsappConnectionId: suporte.id });
    expect(duplicate.status).toBe(409);

    const sameShortcutOtherConnection = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Boas-vindas Vendas", shortcut: "oi", text: "Olá, vendas!", whatsappConnectionId: vendas.id });
    expect(sameShortcutOtherConnection.status).toBe(201);
  });

  it("PATCH edita e DELETE remove; GET / lista todas as conexões (tela de gestão)", async () => {
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    const token = await loginAs("admin@test.dev");

    const created = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Boas-vindas", shortcut: "oi", text: "Olá!", whatsappConnectionId: connection.id });

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
      .send({ name: "Boas-vindas Suporte", shortcut: "oi", text: "Olá do suporte!", whatsappConnectionId: suporte.id });
    await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Boas-vindas Vendas", shortcut: "oi", text: "Olá de vendas!", whatsappConnectionId: vendas.id });

    const agent = await createTestUser({ email: "agente@test.dev", role: "AGENT", displayName: "Agente", whatsappConnectionId: suporte.id });
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

    const agentToken = await loginAs("agente@test.dev");
    // No RESPOSTAS_RAPIDAS_GERENCIAR permission was ever granted to this agent.
    const res = await request(app).get(`/api/quick-replies/conversation/${conversation.id}`).set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].text).toBe("Olá do suporte!");
  });

  it("um AGENT não consegue ver as respostas rápidas de uma conversa que não é sua", async () => {
    const connection = await createTestConnection("Suporte");
    const owner = await createTestUser({ email: "dono@test.dev", role: "AGENT", displayName: "Dono", whatsappConnectionId: connection.id });
    await createTestUser({ email: "outro@test.dev", role: "AGENT", displayName: "Outro", whatsappConnectionId: connection.id });
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
