import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("Usuários: e-mail repetido e desativação", () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await resetDatabase();
    adminId = (await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Carlos" })).id;
    adminToken = (await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const create = (email: string, name = "Nova Pessoa") =>
    request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: name, displayName: name, email, password: "Senha@1234", confirmPassword: "Senha@1234", role: "MANAGER" });

  it("recusa o e-mail de um usuário ativo e diz quem o usa", async () => {
    await createTestUser({ email: "ana@test.dev", role: "AGENT", displayName: "Ana Souza" });
    const res = await create("ana@test.dev");
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("Ana Souza");
  });

  it("aceita o e-mail de usuários inativos; registra quando e quem desativou; o login vai para o ativo", async () => {
    const old = await createTestUser({ email: "ana@test.dev", role: "AGENT", displayName: "Ana Antiga" });
    const off = await request(app).post(`/api/users/${old.id}/deactivate`).set("Authorization", `Bearer ${adminToken}`);
    expect(off.body).toMatchObject({ status: "INACTIVE", deactivatedByName: "Carlos" });
    expect(off.body.deactivatedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "USER_DEACTIVATED", userId: adminId, entityId: old.id } })).toBe(1);

    const use = await request(app).get("/api/users/email-use").set("Authorization", `Bearer ${adminToken}`).query({ email: "ana@test.dev" });
    expect(use.body).toMatchObject({ active: null, inactive: [{ name: "Ana Antiga" }] });

    expect((await create("ana@test.dev", "Ana Nova")).status).toBe(201);
    const login = await request(app).post("/api/auth/login").send({ email: "ana@test.dev", password: "Senha@1234" });
    expect(login.status).toBe(200);
    expect(login.body.user.fullName).toBe("Ana Nova");

    // The old one can't come back while the new one is active.
    const back = await request(app).post(`/api/users/${old.id}/activate`).set("Authorization", `Bearer ${adminToken}`);
    expect(back.status).toBe(409);
    expect(JSON.stringify(back.body)).toContain("Ana Nova");
  });

  it("reativar limpa a data de desativação e fica na Auditoria", async () => {
    const user = await createTestUser({ email: "bia@test.dev", role: "AGENT", displayName: "Bia" });
    await request(app).post(`/api/users/${user.id}/deactivate`).set("Authorization", `Bearer ${adminToken}`);
    const on = await request(app).post(`/api/users/${user.id}/activate`).set("Authorization", `Bearer ${adminToken}`);
    expect(on.body).toMatchObject({ status: "ACTIVE", deactivatedAt: null, deactivatedByName: null });
    expect(await prisma.auditLog.count({ where: { action: "USER_ACTIVATED", entityId: user.id } })).toBe(1);
  });
});
