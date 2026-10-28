import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function login(email: string) {
  return (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;
}

const GESTAO = [
  { key: "client", visible: true },
  { key: "status", visible: true },
  { key: "lastActivity", visible: true },
  { key: "agent", visible: true },
  { key: "connection", visible: false },
  { key: "waiting", visible: true },
];

describe("Visões de colunas", () => {
  let adminToken: string;
  let managerToken: string;
  let agentToken: string;
  let adminId: string;

  beforeEach(async () => {
    await resetDatabase();
    adminId = (await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" })).id;
    await createTestUser({ email: "gestor@test.dev", role: "MANAGER", displayName: "Gestora" });
    await createTestUser({ email: "agente@test.dev", role: "AGENT", displayName: "Ana" });
    adminToken = await login("admin@test.dev");
    managerToken = await login("gestor@test.dev");
    agentToken = await login("agente@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("salva a visão própria; a própria vence a compartilhada, que vence o padrão", async () => {
    const saved = await request(app).put("/api/column-views/mine/gestao").set("Authorization", `Bearer ${managerToken}`).send({ name: "Fila do dia", columns: GESTAO });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: "Fila do dia", ownerName: "Gestora", shareAll: false });

    // Not shared yet: the admin falls back to the system's default.
    expect((await request(app).get("/api/column-views/effective").set("Authorization", `Bearer ${adminToken}`)).body.gestao).toBeUndefined();

    const shared = await request(app)
      .patch(`/api/column-views/${saved.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Fila do dia", columns: GESTAO, shareAll: false, sharedWithIds: [adminId] });
    expect(shared.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "COLUMN_VIEW_UPDATED", userId: adminId } })).toBe(1);

    const effective = await request(app).get("/api/column-views/effective").set("Authorization", `Bearer ${adminToken}`);
    expect(effective.body.gestao).toMatchObject({ source: "shared", name: "Fila do dia" });
    expect(effective.body.gestao.columns.map((c: { key: string }) => c.key)).toEqual(GESTAO.map((c) => c.key));

    await request(app).put("/api/column-views/mine/gestao").set("Authorization", `Bearer ${adminToken}`).send({ columns: GESTAO.slice().reverse() });
    expect((await request(app).get("/api/column-views/effective").set("Authorization", `Bearer ${adminToken}`)).body.gestao.source).toBe("own");

    // The attendant wasn't chosen and doesn't get it.
    expect((await request(app).get("/api/column-views/effective").set("Authorization", `Bearer ${agentToken}`)).body.gestao).toBeUndefined();
  });

  it("não deixa esconder coluna essencial nem usar coluna de outra tela", async () => {
    const hidden = await request(app)
      .put("/api/column-views/mine/gestao")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ columns: [{ key: "client", visible: false }] });
    expect(hidden.status).toBe(400);
    const unknown = await request(app)
      .put("/api/column-views/mine/gestao")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ columns: [{ key: "email", visible: true }] });
    expect(unknown.status).toBe(400);
  });

  it("a visão do atendente é só dele", async () => {
    const saved = await request(app)
      .put("/api/column-views/mine/contatos")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ columns: [{ key: "name", visible: true }, { key: "phone", visible: false }] });
    expect(saved.status).toBe(200);
    const share = await request(app)
      .patch(`/api/column-views/${saved.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "x", columns: saved.body.columns, shareAll: true, sharedWithIds: [] });
    expect(share.status).toBe(400);
  });

  it("Configurações › Visões de colunas exige a permissão própria", async () => {
    expect((await request(app).get("/api/column-views").set("Authorization", `Bearer ${managerToken}`)).status).toBe(403);
    expect((await request(app).get("/api/column-views").set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
  });
});
