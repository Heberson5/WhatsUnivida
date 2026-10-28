import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { endIdleSessions } from "../src/modules/auth/auth.service";
import { updateBusinessSettings } from "../src/modules/settings/settings.service";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
const HOUR = 60 * 60 * 1000;

async function login() {
  const user = await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
  const res = await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD });
  return { user, token: res.body.accessToken as string, cookie: res.headers["set-cookie"][0] as string };
}

/** Pretends the person last used the system `ms` ago. */
async function lastUsedAgo(userId: string, ms: number) {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { lastActivityAt: new Date(Date.now() - ms) } });
}

describe("logoff por inatividade (Configurações › Sessão)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("uma sessão parada de um dia para o outro é encerrada pelo servidor, mesmo com a aba aberta", async () => {
    const { user, token } = await login();
    await lastUsedAgo(user.id, 14 * HOUR); // padrão: 8 horas

    expect(await endIdleSessions()).toBe(1);

    const after = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).presence).toBe("OFFLINE");
    expect(await prisma.auditLog.count({ where: { userId: user.id, action: "LOGOUT_INACTIVITY" } })).toBe(1);
  });

  it("a renovação silenciosa do token não conta como uso: a sessão parada não renova", async () => {
    const { user, cookie } = await login();
    await lastUsedAgo(user.id, 9 * HOUR);

    const refreshed = await request(app).post("/api/auth/refresh").set("Cookie", cookie);

    expect(refreshed.status).toBe(401);
    expect(refreshed.body.message).toMatch(/inatividade/);
  });

  it("renovar o token mantém a hora do último uso — não reinicia a contagem", async () => {
    const { user, cookie } = await login();
    await lastUsedAgo(user.id, 3 * HOUR);

    const refreshed = await request(app).post("/api/auth/refresh").set("Cookie", cookie);
    expect(refreshed.status).toBe(200);

    const session = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id, revokedAt: null } });
    expect(Date.now() - session.lastActivityAt.getTime()).toBeGreaterThan(2.9 * HOUR);
  });

  it("quem está usando o sistema avisa o servidor e continua conectado", async () => {
    const { user, token } = await login();
    await lastUsedAgo(user.id, 14 * HOUR);

    const report = await request(app).post("/api/auth/activity").set("Authorization", `Bearer ${token}`);
    expect(report.status).toBe(204);

    expect(await endIdleSessions()).toBe(0);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });

  it("respeita o tempo configurado: dentro do limite (com a folga de 2 minutos) a sessão continua", async () => {
    await updateBusinessSettings({ inactivityTimeoutMinutes: 30 });
    const { user, token } = await login();

    await lastUsedAgo(user.id, 31 * 60 * 1000);
    expect(await endIdleSessions()).toBe(0);

    await lastUsedAgo(user.id, 33 * 60 * 1000);
    expect(await endIdleSessions()).toBe(1);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });
});
