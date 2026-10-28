import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("alertas de tempo e sons", () => {
  let adminToken: string;
  let agentToken: string;

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-alert@test.dev", role: "ADMIN" });
    await createTestUser({ email: "ana-alert@test.dev", role: "AGENT" });
    adminToken = await loginAs("admin-alert@test.dev");
    agentToken = await loginAs("ana-alert@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("os limites de amarelo/vermelho são configuráveis e o atendente os lê", async () => {
    const defaults = await request(app).get("/api/settings/business").set("Authorization", `Bearer ${agentToken}`);
    expect(defaults.body).toMatchObject({ noReplyWarningMinutes: 5, noReplyDangerMinutes: 15, queueWarningMinutes: 5, queueDangerMinutes: 10 });

    await request(app).patch("/api/settings/queue").set("Authorization", `Bearer ${adminToken}`).send({ queueWarningMinutes: 3, queueDangerMinutes: 8 }).expect(200);
    const updated = await request(app).get("/api/settings/business").set("Authorization", `Bearer ${agentToken}`);
    expect(updated.body).toMatchObject({ queueWarningMinutes: 3, queueDangerMinutes: 8 });

    const invalid = await request(app).patch("/api/settings/queue").set("Authorization", `Bearer ${adminToken}`).send({ noReplyWarningMinutes: 10, noReplyDangerMinutes: 10 });
    expect(invalid.status).toBe(400);
  });

  it("cada usuário escolhe os próprios sons e o volume", async () => {
    const res = await request(app).patch("/api/profile/sounds").set("Authorization", `Bearer ${agentToken}`).send({ soundNewQueue: false, soundVolume: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ soundNewMessage: true, soundNewQueue: false, soundVolume: 30 });
    const tooLoud = await request(app).patch("/api/profile/sounds").set("Authorization", `Bearer ${agentToken}`).send({ soundVolume: 150 });
    expect(tooLoud.status).toBe(400);
  });
});
