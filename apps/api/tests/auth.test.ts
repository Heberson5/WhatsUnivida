import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("auth", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("logs in with correct credentials and returns an access token", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });

    const res = await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe("admin@test.dev");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/refreshToken=/);
  });

  it("returns the same generic error for a wrong password and for a non-existent e-mail (no user enumeration)", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });

    const wrongPassword = await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: "wrong-password" });
    const unknownEmail = await request(app).post("/api/auth/login").send({ email: "nobody@test.dev", password: "wrong-password" });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
  });

  it("blocks login for an inactive (deactivated) user", async () => {
    await createTestUser({ email: "inactive@test.dev", role: "AGENT", status: "INACTIVE" });

    const res = await request(app).post("/api/auth/login").send({ email: "inactive@test.dev", password: TEST_PASSWORD });

    expect(res.status).toBe(403);
  });

  it("rejects requests with no token on protected routes", async () => {
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(401);
  });

  it("never stores the password in plaintext", async () => {
    const user = await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    expect(user.passwordHash).not.toBe(TEST_PASSWORD);
    expect(user.passwordHash.startsWith("$2")).toBe(true); // bcrypt hash prefix
  });

  it("survives two concurrent refresh calls with the same cookie without erroring (regression: minting two refresh JWTs in the same second used to collide on the unique tokenHash)", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD });
    const cookie = loginRes.headers["set-cookie"][0];

    const [first, second] = await Promise.all([
      request(app).post("/api/auth/refresh").set("Cookie", cookie),
      request(app).post("/api/auth/refresh").set("Cookie", cookie),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe("role-based access control", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function loginAs(email: string) {
    const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  }

  it("forbids an AGENT from listing users (ADMIN-only route)", async () => {
    await createTestUser({ email: "agent@test.dev", role: "AGENT" });
    const token = await loginAs("agent@test.dev");

    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 (not 403 or a 500) when accepting a conversation id that does not exist", async () => {
    // MANAGER/ADMIN can attend conversations too — see PROMPT: "o gestor e
    // administrador também devem ter o menu de atendimentos e poderão
    // atender" — so this route is no longer AGENT-only; a nonexistent id
    // should fail cleanly regardless of who asks.
    await createTestUser({ email: "manager@test.dev", role: "MANAGER" });
    const token = await loginAs("manager@test.dev");

    const res = await request(app).post("/api/conversations/00000000-0000-0000-0000-000000000000/accept").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("forbids a MANAGER from renaming/deleting a WhatsApp connection (ADMIN-only route)", async () => {
    await createTestUser({ email: "manager2@test.dev", role: "MANAGER" });
    const token = await loginAs("manager2@test.dev");

    const res = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Nova" });
    expect(res.status).toBe(403);
  });

  it("allows an ADMIN to list users", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const token = await loginAs("admin@test.dev");

    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
