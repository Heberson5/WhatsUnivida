import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("maintenance mode — PROMPT: botão em Configurações, só ADMIN acessa durante manutenção", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("defaults to disabled and is readable without authentication (the login screen must check it before anyone logs in)", async () => {
    const res = await request(app).get("/api/settings/maintenance");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, message: null });
  });

  it("refuses to let a non-ADMIN (even a MANAGER) toggle maintenance mode", async () => {
    await createTestUser({ email: "gestor@test.dev", role: "MANAGER" });
    const token = await loginAs("gestor@test.dev");

    const res = await request(app).patch("/api/settings/maintenance").set("Authorization", `Bearer ${token}`).send({ enabled: true });
    expect(res.status).toBe(403);

    const stillOff = await request(app).get("/api/settings/maintenance");
    expect(stillOff.body.enabled).toBe(false);
  });

  it("lets an ADMIN turn maintenance mode on and off, optionally with a custom message", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const token = await loginAs("admin@test.dev");

    const on = await request(app)
      .patch("/api/settings/maintenance")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true, message: "Voltamos às 14h." });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ enabled: true, message: "Voltamos às 14h." });

    const publicRead = await request(app).get("/api/settings/maintenance");
    expect(publicRead.body).toEqual({ enabled: true, message: "Voltamos às 14h." });

    const off = await request(app).patch("/api/settings/maintenance").set("Authorization", `Bearer ${token}`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
  });

  it("blocks AGENT and MANAGER logins while maintenance is on, even with the correct password", async () => {
    await createTestUser({ email: "admin2@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin2@test.dev");
    await createTestUser({ email: "joao@test.dev", role: "AGENT" });
    await createTestUser({ email: "gestora@test.dev", role: "MANAGER" });

    await request(app).patch("/api/settings/maintenance").set("Authorization", `Bearer ${adminToken}`).send({ enabled: true });

    const agentAttempt = await request(app).post("/api/auth/login").send({ email: "joao@test.dev", password: TEST_PASSWORD });
    expect(agentAttempt.status).toBe(503);
    expect(agentAttempt.body.error).toBe("MAINTENANCE");
    expect(agentAttempt.body.accessToken).toBeUndefined();

    const managerAttempt = await request(app).post("/api/auth/login").send({ email: "gestora@test.dev", password: TEST_PASSWORD });
    expect(managerAttempt.status).toBe(503);
    expect(managerAttempt.body.error).toBe("MAINTENANCE");
  });

  it("still lets ADMIN log in normally while maintenance is on", async () => {
    await createTestUser({ email: "admin3@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin3@test.dev");
    await request(app).patch("/api/settings/maintenance").set("Authorization", `Bearer ${adminToken}`).send({ enabled: true });

    const res = await request(app).post("/api/auth/login").send({ email: "admin3@test.dev", password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("still rejects a WRONG password for an AGENT with the normal generic error, not the maintenance error (no extra info leak)", async () => {
    await createTestUser({ email: "admin4@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin4@test.dev");
    await createTestUser({ email: "joao2@test.dev", role: "AGENT" });
    await request(app).patch("/api/settings/maintenance").set("Authorization", `Bearer ${adminToken}`).send({ enabled: true });

    const res = await request(app).post("/api/auth/login").send({ email: "joao2@test.dev", password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error).not.toBe("MAINTENANCE");
  });

  it("an AGENT blocked by maintenance can log in again normally once it's turned back off", async () => {
    await createTestUser({ email: "admin5@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin5@test.dev");
    await createTestUser({ email: "joao3@test.dev", role: "AGENT" });

    await request(app).patch("/api/settings/maintenance").set("Authorization", `Bearer ${adminToken}`).send({ enabled: true });
    const blocked = await request(app).post("/api/auth/login").send({ email: "joao3@test.dev", password: TEST_PASSWORD });
    expect(blocked.status).toBe(503);

    await request(app).patch("/api/settings/maintenance").set("Authorization", `Bearer ${adminToken}`).send({ enabled: false });
    const allowed = await request(app).post("/api/auth/login").send({ email: "joao3@test.dev", password: TEST_PASSWORD });
    expect(allowed.status).toBe(200);
    expect(allowed.body.accessToken).toBeTruthy();
  });
});
