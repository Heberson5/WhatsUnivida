import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { normalizeImportPhone } from "../src/modules/contacts/contacts.service";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Contatos e etiquetas", () => {
  let connectionId: string;
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    await prisma.tag.deleteMany();
    connectionId = (await createTestConnection("Suporte")).id;
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    token = await loginAs("admin@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("importa CSV sem duplicar (quem já existe mantém o nome), aponta linhas com erro, busca e exporta", async () => {
    await prisma.contact.create({ data: { phone: "5511900000001", name: null, whatsappConnectionId: connectionId } });
    // Already saved without the 9 (as WhatsApp keeps it) and with a name: the planilha neither duplicates nor renames it.
    await prisma.contact.create({ data: { phone: "556599990000", name: "Carlos (cliente)", whatsappConnectionId: connectionId } });
    await prisma.tag.createMany({ data: [{ name: "VIP", color: "#0097B4" }, { name: "Atacado", color: "#059669" }] });
    const csv = ["Nome;Telefone;Etiquetas", "Ana Souza;(11) 90000-0001;VIP, Atacado", "Bruno;11 90000-0002;vip, Inexistente", "Sem número;abc;", "Carlos;(65) 99999-0000;VIP"].join("\n");

    const imported = await request(app).post("/api/contacts/import").set("Authorization", `Bearer ${token}`).send({ whatsappConnectionId: connectionId, csv });
    expect(imported.status).toBe(200);
    expect(imported.body).toEqual({
      created: 1,
      existing: 2,
      errors: [
        { line: 3, reason: 'Etiqueta "Inexistente" não está cadastrada em Automação › Etiquetas' },
        { line: 4, reason: 'Telefone inválido: "abc"' },
      ],
    });
    expect(await prisma.tag.count()).toBe(2); // import never creates tags; "vip" matches "VIP"
    const carlos = await prisma.contact.findMany({ where: { phone: { in: ["556599990000", "5565999990000"] } }, include: { tags: true } });
    expect(carlos).toHaveLength(1);
    expect(carlos[0]).toMatchObject({ name: "Carlos (cliente)" });
    expect(carlos[0].tags).toHaveLength(1);

    const search = await request(app).get("/api/contacts").query({ search: "ana" }).set("Authorization", `Bearer ${token}`);
    expect(search.body.total).toBe(1);
    expect(search.body.items[0]).toMatchObject({ name: "Ana Souza", phone: "5511900000001", connectionName: "Suporte" });
    expect(search.body.items[0].tags.map((t: { name: string }) => t.name)).toEqual(["VIP", "Atacado"]);

    const vip = await prisma.tag.findFirstOrThrow({ where: { name: "VIP" } });
    const byTag = await request(app).get("/api/contacts").query({ tagId: vip.id }).set("Authorization", `Bearer ${token}`);
    expect(byTag.body.total).toBe(3);

    const exported = await request(app).get("/api/contacts/export").set("Authorization", `Bearer ${token}`);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("Ana Souza;5511900000001;;Suporte;VIP, Atacado;0;");
  });

  it("edita nome e etiquetas; renomeia, muda cor e exclui etiqueta", async () => {
    const contact = await prisma.contact.create({ data: { phone: "5511900000003", whatsappConnectionId: connectionId } });
    const tag = await request(app).post("/api/contacts/tags").set("Authorization", `Bearer ${token}`).send({ name: "Cliente novo", color: "#DB2777" });
    expect(tag.status).toBe(201);

    const updated = await request(app).patch(`/api/contacts/${contact.id}`).set("Authorization", `Bearer ${token}`).send({ name: "Carla", tagIds: [tag.body.id] });
    expect(updated.body).toMatchObject({ name: "Carla", tags: [{ name: "Cliente novo", color: "#DB2777" }], conversations: [] });

    const duplicate = await request(app).post("/api/contacts/tags").set("Authorization", `Bearer ${token}`).send({ name: "cliente NOVO", color: "#000000" });
    expect(duplicate.status).toBe(409);

    await request(app).patch(`/api/contacts/tags/${tag.body.id}`).set("Authorization", `Bearer ${token}`).send({ name: "Recorrente", color: "#059669" });
    const tags = await request(app).get("/api/contacts/tags").set("Authorization", `Bearer ${token}`);
    expect(tags.body).toEqual([{ id: tag.body.id, name: "Recorrente", color: "#059669", blockedAutoMessages: [], queueUserIds: [], contactCount: 1 }]);

    expect((await request(app).delete(`/api/contacts/tags/${tag.body.id}`).set("Authorization", `Bearer ${token}`)).status).toBe(204);
    expect(await prisma.contactTag.count()).toBe(0);
  });

  it("o atendente acessa Contatos por padrão, só da própria conexão, e não importa nem exporta", async () => {
    const other = await createTestConnection("Vendas");
    await prisma.contact.create({ data: { phone: "5511900000010", name: "Da Suporte", whatsappConnectionId: connectionId } });
    await prisma.contact.create({ data: { phone: "5511900000011", name: "Da Vendas", whatsappConnectionId: other.id } });
    await createTestUser({ email: "agente@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    const agentToken = await loginAs("agente@test.dev");
    const list = await request(app).get("/api/contacts").set("Authorization", `Bearer ${agentToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { name: string }) => c.name)).toEqual(["Da Suporte"]);
    expect(list.body.items[0].whatsappConnectionId).toBe(connectionId);
    expect((await request(app).get("/api/contacts/export").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
    // Still something an administrator can take away in Perfis de acesso.
    await prisma.rolePermission.create({ data: { role: "AGENT", permission: "contatos.acessar", allowed: false } });
    expect((await request(app).get("/api/contacts").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
  });

  it("ordena cada coluna pelo tipo do dado: nome A–Z, telefone, conexão, conversas e datas", async () => {
    const vendas = await createTestConnection("Atacado");
    const day = (d: number) => new Date(`2026-10-0${d}T12:00:00Z`);
    const carla = await prisma.contact.create({ data: { phone: "5511900000300", name: "Carla", whatsappConnectionId: connectionId, firstConversationAt: day(3), lastInteractionAt: day(5) } });
    const ana = await prisma.contact.create({ data: { phone: "5511900000100", name: "ana", whatsappConnectionId: vendas.id, firstConversationAt: day(1), lastInteractionAt: day(9) } });
    const bruno = await prisma.contact.create({ data: { phone: "5511900000200", name: "Bruno", whatsappConnectionId: connectionId, firstConversationAt: day(2), lastInteractionAt: day(7) } });
    const semNome = await prisma.contact.create({ data: { phone: "5511900000050", name: null, whatsappConnectionId: connectionId, firstConversationAt: day(4), lastInteractionAt: day(1) } });
    for (let i = 0; i < 2; i++) await prisma.conversation.create({ data: { contactId: bruno.id, whatsappConnectionId: connectionId, status: "CLOSED" } });
    await prisma.conversation.create({ data: { contactId: carla.id, whatsappConnectionId: connectionId, status: "CLOSED" } });

    const order = async (sort: string, dir: string) =>
      (await request(app).get("/api/contacts").query({ sort, dir }).set("Authorization", `Bearer ${token}`)).body.items.map((c: { id: string }) => c.id);
    expect(await order("name", "asc")).toEqual([ana.id, bruno.id, carla.id, semNome.id]); // A–Z ignoring case, no name last
    expect(await order("name", "desc")).toEqual([carla.id, bruno.id, ana.id, semNome.id]);
    expect(await order("phone", "asc")).toEqual([semNome.id, ana.id, bruno.id, carla.id]);
    expect((await order("connection", "asc"))[0]).toBe(ana.id); // "Atacado" before "Suporte"
    expect((await order("conversations", "desc")).slice(0, 2)).toEqual([bruno.id, carla.id]);
    expect(await order("firstConversationAt", "asc")).toEqual([ana.id, bruno.id, carla.id, semNome.id]);
    expect(await order("lastInteractionAt", "desc")).toEqual([ana.id, bruno.id, carla.id, semNome.id]);
    expect((await request(app).get("/api/contacts").query({ sort: "firstName" }).set("Authorization", `Bearer ${token}`)).status).toBe(400);
  });

  it("normaliza telefones com e sem DDI", () => {
    expect(normalizeImportPhone("(11) 98765-4321")).toBe("5511987654321");
    expect(normalizeImportPhone("+55 11 98765-4321")).toBe("5511987654321");
    expect(normalizeImportPhone("1 23")).toBeNull();
  });
});
