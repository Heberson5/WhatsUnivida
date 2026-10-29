import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { queueAnnouncementTargets } from "../src/lib/queue-routing";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import * as flowsService from "../src/modules/flows/flows.service";
import { resetDatabase, createTestConnection, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

const login = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;
const presence = (id: string, value: "ONLINE" | "AWAY" | "OFFLINE") => prisma.user.update({ where: { id }, data: { presence: value } });

describe("Etiquetas › Atendida por: a fila só para os usuários designados", () => {
  let connectionId: string;
  let maria: { id: string; token: string };
  let joao: { id: string; token: string };
  let adminToken: string;
  let adminId: string;
  let contactId: string;
  let conversationId: string;
  let tagId: string;

  const queueOf = async (token: string) =>
    ((await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`)).body as { id: string; tags: { name: string }[] }[]);
  const sees = async (token: string) => (await queueOf(token)).some((c) => c.id === conversationId);

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
    const m = await createTestUser({ email: "maria-q@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId });
    const j = await createTestUser({ email: "joao-q@test.dev", role: "AGENT", displayName: "João", whatsappConnectionId: connectionId });
    adminId = (await createTestUser({ email: "admin-q@test.dev", role: "ADMIN" })).id;
    maria = { id: m.id, token: await login("maria-q@test.dev") };
    joao = { id: j.id, token: await login("joao-q@test.dev") };
    adminToken = await login("admin-q@test.dev");
    const waiting = await createWaitingConversation("5565988887777", connectionId);
    contactId = waiting.contact.id;
    conversationId = waiting.conversation.id;
    const tag = await request(app)
      .post("/api/contacts/tags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Inadimplente", color: "#E24B4A", queueUserIds: [maria.id] });
    expect(tag.status).toBe(201);
    expect(tag.body.queueUserIds).toEqual([maria.id]);
    tagId = tag.body.id;
    await prisma.contactTag.create({ data: { contactId, tagId } });
    await presence(maria.id, "ONLINE");
    await presence(joao.id, "ONLINE");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("com a designada online, só ela vê o cliente; o outro não aceita; a gestão vê tudo; o card traz a etiqueta", async () => {
    expect(await sees(maria.token)).toBe(true);
    expect(await sees(joao.token)).toBe(false);
    expect(await sees(adminToken)).toBe(true);
    expect((await queueOf(maria.token)).find((c) => c.id === conversationId)?.tags.map((t) => t.name)).toEqual(["Inadimplente"]);

    const blocked = await request(app).post(`/api/conversations/${conversationId}/accept`).set("Authorization", `Bearer ${joao.token}`);
    expect(blocked.status).toBe(403);
    expect(await queueAnnouncementTargets(conversationId)).toEqual([maria.id]);
    await request(app).post(`/api/conversations/${conversationId}/accept`).set("Authorization", `Bearer ${maria.token}`).expect(200);
  });

  it("designada pausada ou offline: vai para todos; ficando online, volta só para ela", async () => {
    await presence(maria.id, "AWAY");
    expect(await sees(joao.token)).toBe(true);
    expect(await queueAnnouncementTargets(conversationId)).toBeNull();
    await presence(maria.id, "OFFLINE");
    expect(await sees(joao.token)).toBe(true);
    await presence(maria.id, "ONLINE");
    expect(await sees(joao.token)).toBe(false);
  });

  it("duas etiquetas somam os designados; designado de outra conexão não segura o cliente", async () => {
    const other = await createTestConnection("Vendas");
    const pedro = await createTestUser({ email: "pedro-q@test.dev", role: "AGENT", displayName: "Pedro", whatsappConnectionId: other.id, presence: "ONLINE" });
    const vip = await request(app)
      .post("/api/contacts/tags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "VIP", color: "#7F77DD", queueUserIds: [joao.id, pedro.id] });
    await prisma.contactTag.create({ data: { contactId, tagId: vip.body.id } });
    expect(await sees(maria.token)).toBe(true);
    expect(await sees(joao.token)).toBe(true);

    // Only Pedro (another connection) online among the designated: everyone on this connection sees the customer.
    await presence(maria.id, "OFFLINE");
    await presence(joao.id, "OFFLINE");
    const ana = await createTestUser({ email: "ana-q@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId, presence: "ONLINE" });
    const anaToken = await login("ana-q@test.dev");
    await presence(ana.id, "ONLINE");
    expect(await sees(anaToken)).toBe(true);
  });

  it("só gestor e administrador escolhem quem atende; usuário inválido é recusado; sem ninguém = todos", async () => {
    const agentEdit = await request(app).patch(`/api/contacts/tags/${tagId}`).set("Authorization", `Bearer ${maria.token}`).send({ queueUserIds: [] });
    expect(agentEdit.status).toBe(403);
    const invalid = await request(app)
      .patch(`/api/contacts/tags/${tagId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ queueUserIds: ["00000000-0000-4000-8000-000000000000"] });
    expect(invalid.status).toBe(400);
    await request(app).patch(`/api/contacts/tags/${tagId}`).set("Authorization", `Bearer ${adminToken}`).send({ queueUserIds: [] }).expect(200);
    expect(await sees(joao.token)).toBe(true);
    expect(adminId).toBeTruthy();
  });
});

describe("Etiquetas › Atendida por: o cliente novo vai direto para quem atende", () => {
  let connectionId: string;
  let maria: { id: string };
  let joao: { id: string };
  let tagId: string;

  const taggedContact = async (phone: string) => {
    const contact = await prisma.contact.create({ data: { phone, whatsappConnectionId: connectionId } });
    await prisma.contactTag.create({ data: { contactId: contact.id, tagId } });
    return contact;
  };

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
    maria = await createTestUser({ email: "maria-d@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId, presence: "ONLINE" });
    joao = await createTestUser({ email: "joao-d@test.dev", role: "AGENT", displayName: "João", whatsappConnectionId: connectionId, presence: "ONLINE" });
    tagId = (await prisma.tag.create({ data: { name: "Pós Funeral", queueUserIds: [maria.id] } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("com a designada online, a conversa nova abre no Meus dela, sem passar pela fila, com a nota da etiqueta", async () => {
    const contact = await taggedContact("5565988880001");
    const { conversation, isNewConversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "Bom dia");

    expect(isNewConversation).toBe(true);
    expect(autoAssignedAgentId).toBe(maria.id);
    expect(conversation.status).toBe("IN_PROGRESS");
    expect(conversation.assignedAgentId).toBe(maria.id);
    expect(conversation.acceptedAt).not.toBeNull();
    expect((await prisma.conversationAssignment.findFirstOrThrow({ where: { conversationId: conversation.id } })).reason).toBe("TAG");
    expect((await prisma.conversationNote.findMany({ where: { conversationId: conversation.id } })).map((n) => n.body)).toEqual([
      "Direcionada para Maria pela etiqueta Pós Funeral",
    ]);
  });

  it("vários designados online: vai para o que tem menos conversas em andamento", async () => {
    await prisma.tag.update({ where: { id: tagId }, data: { queueUserIds: [maria.id, joao.id] } });
    const busy = await prisma.contact.create({ data: { phone: "5565988880009", whatsappConnectionId: connectionId } });
    await prisma.conversation.create({ data: { contactId: busy.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: maria.id } });

    const contact = await taggedContact("5565988880002");
    const { autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "Oi");
    expect(autoAssignedAgentId).toBe(joao.id);
  });

  it("designada pausada, offline ou de outra conexão: vai para a fila, como antes", async () => {
    await prisma.user.update({ where: { id: maria.id }, data: { presence: "AWAY" } });
    const paused = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, (await taggedContact("5565988880003")).id, "Oi");
    expect(paused.autoAssignedAgentId).toBeNull();
    expect(paused.conversation.status).toBe("NEW");

    const other = await createTestConnection("Vendas");
    await prisma.user.update({ where: { id: maria.id }, data: { presence: "ONLINE", whatsappConnectionId: other.id } });
    const elsewhere = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, (await taggedContact("5565988880004")).id, "Oi");
    expect(elsewhere.autoAssignedAgentId).toBeNull();
    expect(elsewhere.conversation.status).toBe("NEW");
  });

  it("@menção do cliente vale mais que a etiqueta", async () => {
    const contact = await taggedContact("5565988880005");
    const { autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "Quero falar com @João");
    expect(autoAssignedAgentId).toBe(joao.id);
  });

  it("com um Fluxo ativo na conexão, o cliente com etiqueta vai direto para a designada, sem o Fluxo", async () => {
    const adminId = (await createTestUser({ email: "admin-d@test.dev", role: "ADMIN" })).id;
    const flow = await flowsService.createFlow({ name: "Univida", connectionIds: [connectionId] }, adminId);
    await flowsService.saveFlowGraph(
      flow.id,
      [
        { id: "s", type: "START", positionX: 0, positionY: 0, data: {} },
        { id: "x", type: "TRANSFER_TO_AGENT", positionX: 100, positionY: 0, data: { name: "Fila", mode: "any", assignedAgentIds: [] } },
      ],
      [{ sourceNodeId: "s", targetNodeId: "x", sourceHandle: null }]
    );
    await flowsService.updateFlowMeta(flow.id, { active: true });

    const { conversation, flowId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, (await taggedContact("5565988880006")).id, "Oi");
    expect(flowId).toBeNull();
    expect(conversation.assignedAgentId).toBe(maria.id);
  });

  it("contato salvo com o 9 e a mensagem chegando sem o 9: é o mesmo cliente, com a etiqueta", async () => {
    const saved = await taggedContact("5565988880007");
    const found = await conversationsService.findOrCreateContact(connectionId, "556588880007", "Cliente", "556588880007@s.whatsapp.net");
    expect(found.id).toBe(saved.id);
    expect(found.phone).toBe("556588880007");
    expect(await prisma.contact.count({ where: { whatsappConnectionId: connectionId } })).toBe(1);
    const { autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, found.id, "Oi");
    expect(autoAssignedAgentId).toBe(maria.id);
  });
});
