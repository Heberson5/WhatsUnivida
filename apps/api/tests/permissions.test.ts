import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { PERMISSION } from "@whatsatendende/types";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("granular per-role permissions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("gives every role its hardcoded default until an admin edits something, and ADMIN is always all-true", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    await createTestUser({ email: "manager@test.dev", role: "MANAGER" });
    await createTestUser({ email: "agent@test.dev", role: "AGENT" });

    const adminToken = await loginAs("admin@test.dev");
    const managerToken = await loginAs("manager@test.dev");
    const agentToken = await loginAs("agent@test.dev");

    const adminPerms = await request(app).get("/api/permissions/me").set("Authorization", `Bearer ${adminToken}`);
    expect(Object.values(adminPerms.body).every((v) => v === true)).toBe(true);

    const managerPerms = await request(app).get("/api/permissions/me").set("Authorization", `Bearer ${managerToken}`);
    expect(managerPerms.body[PERMISSION.ATENDIMENTO_ACESSAR]).toBe(true);
    expect(managerPerms.body[PERMISSION.GESTAO_ACESSAR]).toBe(true);
    expect(managerPerms.body[PERMISSION.DASHBOARD_ACESSAR]).toBe(true);
    expect(managerPerms.body[PERMISSION.RELATORIOS_ACESSAR]).toBe(true);
    expect(managerPerms.body[PERMISSION.USUARIOS_VISUALIZAR]).toBe(true);
    expect(managerPerms.body[PERMISSION.CONFIGURACOES_GERENCIAR]).toBe(false);
    expect(managerPerms.body[PERMISSION.AUDITORIA_ACESSAR]).toBe(false);

    const agentPerms = await request(app).get("/api/permissions/me").set("Authorization", `Bearer ${agentToken}`);
    expect(agentPerms.body[PERMISSION.ATENDIMENTO_ACESSAR]).toBe(true);
    expect(agentPerms.body[PERMISSION.GESTAO_ACESSAR]).toBe(false);
    expect(agentPerms.body[PERMISSION.DASHBOARD_ACESSAR]).toBe(false);
    expect(agentPerms.body[PERMISSION.RELATORIOS_ACESSAR]).toBe(false);
  });

  it("blocks non-admins from reading or editing the full permission matrix", async () => {
    await createTestUser({ email: "manager2@test.dev", role: "MANAGER" });
    const token = await loginAs("manager2@test.dev");

    const getRes = await request(app).get("/api/permissions").set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(403);

    const putRes = await request(app)
      .put("/api/permissions")
      .set("Authorization", `Bearer ${token}`)
      .send({ entries: [{ role: "MANAGER", permission: PERMISSION.RELATORIOS_ACESSAR, allowed: false }] });
    expect(putRes.status).toBe(403);
  });

  it("lets an ADMIN revoke a MANAGER's default permission, and it takes effect immediately on that role", async () => {
    await createTestUser({ email: "admin2@test.dev", role: "ADMIN" });
    await createTestUser({ email: "manager3@test.dev", role: "MANAGER" });
    const adminToken = await loginAs("admin2@test.dev");
    const managerToken = await loginAs("manager3@test.dev");

    const before = await request(app).get("/api/reports/attendance").set("Authorization", `Bearer ${managerToken}`).query({ period: "month" });
    expect(before.status).toBe(200);

    const patch = await request(app)
      .put("/api/permissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ entries: [{ role: "MANAGER", permission: PERMISSION.RELATORIOS_ACESSAR, allowed: false }] });
    expect(patch.status).toBe(200);
    expect(patch.body.matrix.MANAGER[PERMISSION.RELATORIOS_ACESSAR]).toBe(false);

    const after = await request(app).get("/api/reports/attendance").set("Authorization", `Bearer ${managerToken}`).query({ period: "month" });
    expect(after.status).toBe(403);
  });

  it("rejects a PUT that targets the ADMIN role instead of silently storing it", async () => {
    await createTestUser({ email: "admin3@test.dev", role: "ADMIN" });
    const token = await loginAs("admin3@test.dev");

    const res = await request(app)
      .put("/api/permissions")
      .set("Authorization", `Bearer ${token}`)
      .send({ entries: [{ role: "ADMIN", permission: PERMISSION.USUARIOS_EDITAR, allowed: false }] });
    expect(res.status).toBe(400);

    const stored = await prisma.rolePermission.findMany({ where: { role: "ADMIN" } });
    expect(stored).toHaveLength(0);
  });

  it("a MANAGER granted usuarios.adicionar/editar can manage AGENT/MANAGER accounts but not create or touch an ADMIN account", async () => {
    await createTestUser({ email: "admin4@test.dev", role: "ADMIN" });
    const targetAdmin = await createTestUser({ email: "otheradmin@test.dev", role: "ADMIN" });
    await createTestUser({ email: "delegatedmanager@test.dev", role: "MANAGER" });
    const adminToken = await loginAs("admin4@test.dev");

    await request(app)
      .put("/api/permissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        entries: [
          { role: "MANAGER", permission: PERMISSION.USUARIOS_ADICIONAR, allowed: true },
          { role: "MANAGER", permission: PERMISSION.USUARIOS_EDITAR, allowed: true },
        ],
      });

    const managerToken = await loginAs("delegatedmanager@test.dev");

    // Can create a regular AGENT.
    const createAgent = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ fullName: "Novo Atendente", displayName: "Novo", email: "novoagente@test.dev", password: "Test@1234", confirmPassword: "Test@1234", role: "AGENT" });
    expect(createAgent.status).toBe(400); // AGENT requires whatsappConnectionId — proves the route was reached and normal validation still runs
    expect(createAgent.body.message).not.toMatch(/administrador/i);

    // Cannot create a new ADMIN.
    const createAdmin = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ fullName: "Admin Forjado", displayName: "Forjado", email: "forjado@test.dev", password: "Test@1234", confirmPassword: "Test@1234", role: "ADMIN" });
    expect(createAdmin.status).toBe(403);

    // Cannot touch an existing ADMIN account.
    const editAdmin = await request(app)
      .patch(`/api/users/${targetAdmin.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ displayName: "Hackeado" });
    expect(editAdmin.status).toBe(403);
  });
});
