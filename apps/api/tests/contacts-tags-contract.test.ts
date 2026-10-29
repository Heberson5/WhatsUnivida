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

describe("Contatos: coluna Etiquetas e contrato digitado", () => {
  let token: string;
  let ids: { vip: string; atacado: string };

  beforeEach(async () => {
    await resetDatabase();
    await prisma.tag.deleteMany();
    const connectionId = (await createTestConnection("Suporte")).id;
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    token = await loginAs("admin@test.dev");
    const vip = await prisma.tag.create({ data: { name: "VIP", color: "#0097B4" } });
    const atacado = await prisma.tag.create({ data: { name: "Atacado", color: "#059669" } });
    ids = { vip: vip.id, atacado: atacado.id };
    const make = (name: string, phone: string, tagIds: string[]) =>
      prisma.contact.create({ data: { name, phone, whatsappConnectionId: connectionId, tags: { create: tagIds.map((tagId) => ({ tagId })) } } });
    await make("Ana", "5511900000001", [vip.id]);
    await make("Bruno", "5511900000002", [atacado.id]);
    await make("Carla", "5511900000003", []);
    await make("Davi", "5511900000004", [vip.id, atacado.id]);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const names = (body: { items: { name: string }[] }) => body.items.map((i) => i.name);

  it("filtra por várias etiquetas (qualquer uma) e por Sem etiqueta", async () => {
    const both = await request(app).get("/api/contacts").query({ tagId: `${ids.vip},${ids.atacado}`, sort: "name", dir: "asc" }).set("Authorization", `Bearer ${token}`);
    expect(names(both.body)).toEqual(["Ana", "Bruno", "Davi"]);
    const none = await request(app).get("/api/contacts").query({ tagId: "none" }).set("Authorization", `Bearer ${token}`);
    expect(names(none.body)).toEqual(["Carla"]);
    const vipOrNone = await request(app).get("/api/contacts").query({ tagId: `${ids.vip},none`, sort: "name", dir: "asc" }).set("Authorization", `Bearer ${token}`);
    expect(names(vipOrNone.body)).toEqual(["Ana", "Carla", "Davi"]);
  });

  it("ordena pela coluna Etiquetas, de A a Z, sem etiqueta por último", async () => {
    const asc = await request(app).get("/api/contacts").query({ sort: "tags", dir: "asc" }).set("Authorization", `Bearer ${token}`);
    // "Atacado" < "Atacado, VIP" < "VIP"; Carla has none.
    expect(names(asc.body)).toEqual(["Bruno", "Davi", "Ana", "Carla"]);
    const desc = await request(app).get("/api/contacts").query({ sort: "tags", dir: "desc" }).set("Authorization", `Bearer ${token}`);
    expect(names(desc.body)).toEqual(["Ana", "Davi", "Bruno", "Carla"]);
  });

  it("o contrato digitado é editado e apagado pelo menu Contatos", async () => {
    const carla = await prisma.contact.findFirstOrThrow({ where: { name: "Carla" } });
    await prisma.contact.update({ where: { id: carla.id }, data: { contractNumber: "123" } });
    const edited = await request(app).patch(`/api/contacts/${carla.id}`).set("Authorization", `Bearer ${token}`).send({ contractNumber: " 456-B " });
    expect(edited.status).toBe(200);
    expect(edited.body.contractNumber).toBe("456-B");
    const cleared = await request(app).patch(`/api/contacts/${carla.id}`).set("Authorization", `Bearer ${token}`).send({ contractNumber: "" });
    expect(cleared.body.contractNumber).toBeNull();
  });
});
