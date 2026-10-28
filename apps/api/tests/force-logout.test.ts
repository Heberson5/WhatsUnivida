import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { PERMISSION } from "@whatsunivida/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginWithCookie(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return { accessToken: res.body.accessToken as string, cookie: res.headers["set-cookie"][0] as string };
}

describe("force-logging out a user from Usuários", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("an ADMIN can force-log-out another user: their refresh cookie stops working and presence flips to OFFLINE", async () => {
    await createTestUser({ email: "admin-fl@test.dev", role: "ADMIN" });
    const target = await createTestUser({ email: "agent-fl@test.dev", role: "AGENT" });
    const adminToken = (await loginWithCookie("admin-fl@test.dev")).accessToken;
    const targetSession = await loginWithCookie("agent-fl@test.dev");

    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(before.presence).toBe("ONLINE");

    const res = await request(app)
      .post(`/api/users/${target.id}/force-logout`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.presence).toBe("OFFLINE");

    // The refresh cookie issued at login no longer works — the session is dead.
    const refreshAttempt = await request(app).post("/api/auth/refresh").set("Cookie", targetSession.cookie);
    expect(refreshAttempt.status).toBe(401);
  });

  it("a non-ADMIN cannot force-log-out an ADMIN account, even with usuarios.gerenciar granted", async () => {
    await createTestUser({ email: "admin-fl2@test.dev", role: "ADMIN" });
    const targetAdmin = await createTestUser({ email: "otheradmin-fl@test.dev", role: "ADMIN" });
    await createTestUser({ email: "manager-fl@test.dev", role: "MANAGER" });
    const adminToken = (await loginWithCookie("admin-fl2@test.dev")).accessToken;

    await request(app)
      .put("/api/permissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ entries: [{ role: "MANAGER", permission: PERMISSION.USUARIOS_GERENCIAR, allowed: true }] });

    const managerToken = (await loginWithCookie("manager-fl@test.dev")).accessToken;
    const res = await request(app)
      .post(`/api/users/${targetAdmin.id}/force-logout`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
  });
});
