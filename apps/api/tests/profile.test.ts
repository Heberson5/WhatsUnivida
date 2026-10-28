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

describe("self-service profile", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets a user update their own name and see it reflected on /profile", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao" });
    const token = await loginAs("joao@test.dev");

    const res = await request(app)
      .patch("/api/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Joao Silva", displayName: "Joao S." });

    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe("Joao Silva");
    expect(res.body.displayName).toBe("Joao S.");

    const fetched = await request(app).get("/api/profile").set("Authorization", `Bearer ${token}`);
    expect(fetched.body.displayName).toBe("Joao S.");
  });

  it("changes the user's own password only with the correct current password, and revokes other sessions", async () => {
    const user = await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria" });
    const token = await loginAs("maria@test.dev");

    const wrongCurrent = await request(app)
      .post("/api/profile/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "wrong-password", newPassword: "NovaSenha123", confirmPassword: "NovaSenha123" });
    expect(wrongCurrent.status).toBe(401);

    const ok = await request(app)
      .post("/api/profile/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: "NovaSenha123", confirmPassword: "NovaSenha123" });
    expect(ok.status).toBe(204);

    const revokedAfterChange = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(revokedAfterChange.length).toBeGreaterThan(0);
    expect(revokedAfterChange.every((t) => t.revokedAt !== null)).toBe(true);

    const oldLogin = await request(app).post("/api/auth/login").send({ email: "maria@test.dev", password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post("/api/auth/login").send({ email: "maria@test.dev", password: "NovaSenha123" });
    expect(newLogin.status).toBe(200);
  });

  it("rejects changing password when the new password and confirmation don't match", async () => {
    await createTestUser({ email: "pedro@test.dev", role: "AGENT", displayName: "Pedro" });
    const token = await loginAs("pedro@test.dev");

    const res = await request(app)
      .post("/api/profile/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: "NovaSenha123", confirmPassword: "Diferente123" });
    expect(res.status).toBe(400);
  });
});
