import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { firstNameOf, normalizeContactName } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { findOrCreateContact } from "../src/modules/conversations/conversations.service";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("Contatos: nomes padronizados", () => {
  it("segue as regras combinadas", () => {
    const cases: [string, string][] = [
      ["456 Cnp ANA LIMA", "Ana Lima 456-CNP"],
      ["123 João Pereira TGS", "João Pereira 123-TGS"],
      ["Maria 123 tgs", "Maria 123-TGS"],
      ["MARIA DA SILVA DOS SANTOS", "Maria da Silva dos Santos"],
      ["dr carlos souza", "Dr. Carlos Souza"],
      ["DRA. ana paula", "Dra. Ana Paula"],
      ["padaria pão quente ltda", "Padaria Pão Quente LTDA"],
      ["comercio bom preço me", "Comercio Bom Preço ME"],
      ["jose e maria", "Jose e Maria"],
      ["bbg", "BBG"],
      ["12345", "12345"],
      ["MCDONALD souza", "Mcdonald Souza"],
      ["Ana McDonald", "Ana McDonald"],
    ];
    for (const [raw, expected] of cases) expect(normalizeContactName(raw), raw).toBe(expected);
    expect(firstNameOf("dr carlos souza")).toBe("Dr. Carlos");
    expect(firstNameOf("456 Cnp ANA LIMA")).toBe("Ana");
  });
});

describe("Contatos: Padronizar nomes e contratos da lista", () => {
  let adminToken: string;
  let agentToken: string;

  const login = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.dataSource.deleteMany();
    await createTestUser({ email: "admin-names@test.dev", role: "ADMIN" });
    await createTestUser({ email: "agent-names@test.dev", role: "AGENT" });
    adminToken = await login("admin-names@test.dev");
    agentToken = await login("agent-names@test.dev");
  });

  afterAll(async () => {
    await prisma.dataSource.deleteMany();
    await prisma.$disconnect();
  });

  it("prévia, aplicar só os marcados e desfazer — sem desfazer um nome trocado depois", async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const ana = await prisma.contact.create({ data: { name: "456 Cnp ANA LIMA", phone: "5565999990001" } });
    const joao = await prisma.contact.create({ data: { name: "123 João Pereira TGS", phone: "5565999990002" } });
    const ok = await prisma.contact.create({ data: { name: "Maria Souza", phone: "5565999990003" } });
    const group = await prisma.contact.create({ data: { name: "EQUIPE TGS", isGroup: true, providerChatId: "1203630001@g.us" } });

    expect((await request(app).get("/api/contacts/name-standardization").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
    const preview = (await request(app).get("/api/contacts/name-standardization").set(auth)).body;
    expect(preview.lastBatch).toBeNull();
    expect(preview.items.map((i: { contactId: string; proposed: string }) => [i.contactId, i.proposed])).toEqual(
      expect.arrayContaining([
        [ana.id, "Ana Lima 456-CNP"],
        [joao.id, "João Pereira 123-TGS"],
      ])
    );
    expect(preview.items.map((i: { contactId: string }) => i.contactId)).not.toContain(ok.id);
    expect(preview.items.map((i: { contactId: string }) => i.contactId)).not.toContain(group.id);

    const applied = (await request(app).post("/api/contacts/name-standardization").set(auth).send({ contactIds: [ana.id, joao.id] })).body;
    expect(applied.count).toBe(2);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: ana.id } })).name).toBe("Ana Lima 456-CNP");
    expect((await request(app).get("/api/contacts/name-standardization").set(auth)).body.lastBatch).toMatchObject({ batchId: applied.batchId, count: 2, undone: false });

    // Someone renames João afterwards: undo keeps that.
    await prisma.contact.update({ where: { id: joao.id }, data: { name: "João P." } });
    const undone = (await request(app).post(`/api/contacts/name-standardization/${applied.batchId}/undo`).set(auth)).body;
    expect(undone.count).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: ana.id } })).name).toBe("456 Cnp ANA LIMA");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: joao.id } })).name).toBe("João P.");
    expect((await request(app).post(`/api/contacts/name-standardization/${applied.batchId}/undo`).set(auth)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: { in: ["CONTACT_NAMES_STANDARDIZED", "CONTACT_NAMES_STANDARDIZATION_UNDONE"] } } })).toBe(2);
  });

  it("contato novo do WhatsApp já entra com o nome padronizado", async () => {
    const connection = await createTestConnection("Nomes");
    const contact = await findOrCreateContact(connection.id, "5565999990009", "maria 123 tgs");
    expect(contact?.name).toBe("Maria 123-TGS");
  });

  it("lista enviada: todos os contratos do telefone, com a situação, substituindo o que havia", async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const contact = await prisma.contact.create({ data: { name: "Cliente Contratos", phone: "5565988880001", contractNumber: "MANUAL-1" } });
    const csv = [
      "telefone_whatsapp,codigo_cliente,nome_cliente,numero_contrato,situacao_contrato,data_cancelamento,motivo_cancelamento",
      "5565988880001,1,Cliente Contratos,C-CANC,Cancelado,05/03/2026,Mudou de cidade",
      "5565988880001,1,Cliente Contratos,C-SUSP,Suspenso,,",
      "5565988880001,1,Cliente Contratos,C-ATIVO,Ativo,,",
    ].join("\n");
    const source = (await request(app).post("/api/data-sources").set(auth).send({ name: "Lista", kind: "UPLOAD" })).body;
    const uploaded = await request(app).post(`/api/data-sources/${source.id}/upload`).set(auth).attach("file", Buffer.from(csv), { filename: "lista.csv", contentType: "text/csv" });
    expect(uploaded.body.lastSyncError).toBeNull();
    expect(uploaded.body.columnMap).toMatchObject({ cancelDate: "data_cancelamento", cancelReason: "motivo_cancelamento" });

    const row = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(row.contractNumber).toBe("C-ATIVO, C-SUSP, C-CANC");
    expect(row.contracts).toEqual([
      { number: "C-ATIVO", status: "ACTIVE", canceledAt: null, cancelReason: null },
      { number: "C-SUSP", status: "SUSPENDED", canceledAt: null, cancelReason: null },
      { number: "C-CANC", status: "CANCELED", canceledAt: "05/03/2026", cancelReason: "Mudou de cidade" },
    ]);
    const listed = (await request(app).get("/api/contacts?search=Cliente Contratos").set(auth)).body.items[0];
    expect(listed.contracts.map((c: { status: string }) => c.status)).toEqual(["ACTIVE", "SUSPENDED", "CANCELED"]);

    // The next list without this phone takes its contracts away.
    const other = "telefone_whatsapp,codigo_cliente,nome_cliente,numero_contrato,situacao_contrato\n5565988880002,2,Outro,C-9,Ativo";
    await request(app).post(`/api/data-sources/${source.id}/upload`).set(auth).attach("file", Buffer.from(other), { filename: "lista.csv", contentType: "text/csv" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).contracts).toBeNull();
  });
});
