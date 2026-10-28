import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
// Smallest valid PNG (1x1).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function loginAs(email: string) {
  return (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;
}

describe("Usuários: setting another user's photo", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets an admin or manager set and remove an agent's photo, but never an admin's from a manager", async () => {
    const admin = await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    await createTestUser({ email: "gestora@test.dev", role: "MANAGER", displayName: "Gestora" });
    const agent = await createTestUser({ email: "paula@test.dev", role: "AGENT", displayName: "Paula" });
    const [adminToken, managerToken, agentToken] = await Promise.all([loginAs("admin@test.dev"), loginAs("gestora@test.dev"), loginAs("paula@test.dev")]);

    const byManager = await request(app)
      .post(`/api/users/${agent.id}/photo`)
      .set("Authorization", `Bearer ${managerToken}`)
      .attach("file", PNG, { filename: "foto.png", contentType: "image/png" });
    expect(byManager.status).toBe(200);
    expect(byManager.body.photoUrl).toMatch(/^\/uploads\/profile\/photo-/);

    const removed = await request(app).delete(`/api/users/${agent.id}/photo`).set("Authorization", `Bearer ${adminToken}`);
    expect(removed.status).toBe(200);
    expect(removed.body.photoUrl).toBeNull();

    const managerOnAdmin = await request(app)
      .post(`/api/users/${admin.id}/photo`)
      .set("Authorization", `Bearer ${managerToken}`)
      .attach("file", PNG, { filename: "foto.png", contentType: "image/png" });
    expect(managerOnAdmin.status).toBe(403);

    const byAgent = await request(app)
      .post(`/api/users/${admin.id}/photo`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("file", PNG, { filename: "foto.png", contentType: "image/png" });
    expect(byAgent.status).toBe(403);
  });
});
