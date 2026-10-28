import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { queueAnnouncementTargets } from "../src/lib/queue-routing";
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
