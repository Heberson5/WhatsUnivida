import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { PERMISSION } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import * as usersService from "../src/modules/users/users.service";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("DELETE /users/:id — ADMIN-only account deletion", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("an ADMIN can delete a user with no history", async () => {
    await createTestUser({ email: "admin-del@test.dev", role: "ADMIN" });
    const target = await createTestUser({ email: "agent-del@test.dev", role: "AGENT" });
    const adminToken = await loginAs("admin-del@test.dev");

    const res = await request(app).delete(`/api/users/${target.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
  });

  it("a MANAGER with usuarios.inativar granted still cannot delete — ADMIN-only, not the configurable permission", async () => {
    await createTestUser({ email: "admin-del2@test.dev", role: "ADMIN" });
    const target = await createTestUser({ email: "agent-del2@test.dev", role: "AGENT" });
    await createTestUser({ email: "manager-del@test.dev", role: "MANAGER" });
    const adminToken = await loginAs("admin-del2@test.dev");

    await request(app)
      .put("/api/permissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ entries: [{ role: "MANAGER", permission: PERMISSION.USUARIOS_INATIVAR, allowed: true }] });

    const managerToken = await loginAs("manager-del@test.dev");
    const res = await request(app).delete(`/api/users/${target.id}`).set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it("an AGENT gets 403 outright (no usuarios.gerenciar at all)", async () => {
    const target = await createTestUser({ email: "agent-del3@test.dev", role: "AGENT" });
    const agentToken = await loginAs("agent-del3@test.dev");
    const res = await request(app).delete(`/api/users/${target.id}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it("an ADMIN cannot delete their own account", async () => {
    const admin = await createTestUser({ email: "admin-del4@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-del4@test.dev");
    const res = await request(app).delete(`/api/users/${admin.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { id: admin.id } })).not.toBeNull();
  });

  // Exercised at the service level, not through the route: reaching this
  // guard over HTTP would require an ADMIN requester distinct from an
  // ADMIN target who is nonetheless the system's only admin — impossible,
  // since the requester itself is necessarily that same only admin (the
  // route already requires requireRole("ADMIN")). The self-delete check
  // above catches that exact case first in practice. This guard stays as
  // defense-in-depth regardless — asserted directly here so it's still
  // proven correct on its own terms.
  it("usersService.deleteUser refuses to delete the system's only ADMIN, independent of who's asking", async () => {
    const onlyAdmin = await createTestUser({ email: "admin-del5@test.dev", role: "ADMIN" });
    const someoneElse = await createTestUser({ email: "agent-del6@test.dev", role: "AGENT" });
    await expect(usersService.deleteUser(onlyAdmin.id, someoneElse.id)).rejects.toThrow(/único administrador/i);
    expect(await prisma.user.findUnique({ where: { id: onlyAdmin.id } })).not.toBeNull();
  });

  it("usersService.deleteUser allows deleting a non-last ADMIN", async () => {
    await createTestUser({ email: "admin-del6@test.dev", role: "ADMIN" });
    const secondAdmin = await createTestUser({ email: "admin-del7@test.dev", role: "ADMIN" });
    const someoneElse = await createTestUser({ email: "agent-del7@test.dev", role: "AGENT" });
    await usersService.deleteUser(secondAdmin.id, someoneElse.id);
    expect(await prisma.user.findUnique({ where: { id: secondAdmin.id } })).toBeNull();
  });

  it("a user with real history (assigned/accepted a conversation) cannot be hard-deleted — friendly 400, not a 500", async () => {
    await createTestUser({ email: "admin-del8@test.dev", role: "ADMIN" });
    const connectionId = (await createTestConnection("Suporte")).id;
    const agent = await createTestUser({ email: "agent-del4@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    const agentToken = await loginAs("agent-del4@test.dev");
    const { conversation } = await createWaitingConversation("5511990002222", connectionId);
    const acceptRes = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);
    expect(acceptRes.status).toBe(200);

    const adminToken = await loginAs("admin-del8@test.dev");
    const res = await request(app).delete(`/api/users/${agent.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Inativar|histórico/i);
    expect(await prisma.user.findUnique({ where: { id: agent.id } })).not.toBeNull();
  });

  it("deleting a user removes their refresh tokens (cascade) without error", async () => {
    await createTestUser({ email: "admin-del9@test.dev", role: "ADMIN" });
    const target = await createTestUser({ email: "agent-del5@test.dev", role: "AGENT" });
    await loginAs("agent-del5@test.dev"); // mints a real RefreshToken row for this user
    const adminToken = await loginAs("admin-del9@test.dev");

    const res = await request(app).delete(`/api/users/${target.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    expect(await prisma.refreshToken.count({ where: { userId: target.id } })).toBe(0);
  });
});
