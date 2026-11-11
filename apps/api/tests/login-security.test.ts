import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess, purgeOldLoginAttempts } from "../src/lib/login-guard";
import { passwordProblem } from "../src/lib/password-policy";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

// See PROMPT: "precisa ter segurança para tentativa de invasão ao tentar vários usuário e senhas".

const app = createApp();
const BLOCKED = "Muitas tentativas de login";

/** A login as it arrives through the proxies: each "visitor" with its own public IP. */
const loginFrom = (ip: string, email: string, password: string) => request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email, password });

describe("proteção contra tentativas de invasão no login", () => {
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    await resetDatabase();
    adminId = (await createTestUser({ email: "admin-sec@test.dev", role: "ADMIN", displayName: "Admin" })).id;
    await createTestUser({ email: "ana-sec@test.dev", role: "AGENT", displayName: "Ana" });
    await createTestUser({ email: "inativo-sec@test.dev", role: "AGENT", displayName: "Inativo", status: "INACTIVE" });
    adminToken = (await loginFrom("200.10.0.1", "admin-sec@test.dev", TEST_PASSWORD)).body.accessToken;
  });

  beforeEach(async () => {
    await prisma.loginLock.deleteMany();
    await prisma.loginAttempt.deleteMany({ where: { email: { not: "admin-sec@test.dev" } } });
    await prisma.notification.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("10 senhas erradas para a mesma conta, cada uma de um IP diferente, bloqueiam a conta para IPs desconhecidos", async () => {
    // The person logged in from the office before: that IP is theirs.
    expect((await loginFrom("200.20.0.1", "ana-sec@test.dev", TEST_PASSWORD)).status).toBe(200);

    for (let i = 1; i <= 10; i++) {
      const res = await loginFrom(`45.0.0.${i}`, "ana-sec@test.dev", "errada");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("E-mail ou senha invalidos");
    }
    // The attacker finally has the right password — from yet another IP: still refused.
    const attacker = await loginFrom("45.0.0.99", "Ana-Sec@Test.dev", TEST_PASSWORD);
    expect(attacker.status).toBe(429);
    expect(attacker.body.message).toContain(BLOCKED);
    // The person, from their own office, keeps working.
    expect((await loginFrom("200.20.0.1", "ana-sec@test.dev", TEST_PASSWORD)).status).toBe(200);
  });

  it("um e-mail que não existe é contado e bloqueado do mesmo jeito: a resposta não revela quais contas existem", async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await loginFrom(`46.0.0.${i}`, "ninguem@test.dev", "qualquer");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("E-mail ou senha invalidos");
    }
    const res = await loginFrom("46.0.0.50", "ninguem@test.dev", "qualquer");
    expect(res.status).toBe(429);
    expect(res.body.message).toContain(BLOCKED);
  });

  it("usuário inativo: senha errada responde igual a qualquer outra; só com a senha certa aparece que está inativo", async () => {
    const wrong = await loginFrom("47.0.0.1", "inativo-sec@test.dev", "errada");
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe("E-mail ou senha invalidos");
    const right = await loginFrom("47.0.0.1", "inativo-sec@test.dev", TEST_PASSWORD);
    expect(right.status).toBe(403);
    expect(right.body.message).toContain("inativo");
  });

  it("o bloqueio cresce quando se repete: 15 minutos, depois 1 hora, depois 24 horas", async () => {
    const email = "escala@test.dev";
    const t0 = new Date("2026-11-11T12:00:00Z");
    const fail = async (at: Date) => {
      for (let i = 0; i < 10; i++) await recordLoginFailure(email, `48.0.0.${i}`, null, at);
    };
    const lockMinutes = async (at: Date) => Math.round(((await prisma.loginLock.findUniqueOrThrow({ where: { email } })).lockedUntil.getTime() - at.getTime()) / 60_000);

    await fail(t0);
    expect(await lockMinutes(t0)).toBe(15);
    await expect(assertLoginAllowed(email, "48.0.0.200", new Date(t0.getTime() + 14 * 60_000))).rejects.toThrow(BLOCKED);
    // The 15 minutes are over: allowed again...
    const t1 = new Date(t0.getTime() + 16 * 60_000);
    await expect(assertLoginAllowed(email, "48.0.0.200", t1)).resolves.toBeUndefined();
    // ...nine more wrong passwords are not yet a new lock (the old ones no longer count)...
    for (let i = 0; i < 9; i++) await recordLoginFailure(email, `48.0.1.${i}`, null, t1);
    await expect(assertLoginAllowed(email, "48.0.0.200", t1)).resolves.toBeUndefined();
    // ...the tenth is, and now for an hour.
    await recordLoginFailure(email, "48.0.1.9", null, t1);
    expect(await lockMinutes(t1)).toBe(60);

    const t2 = new Date(t1.getTime() + 61 * 60_000);
    await fail(t2);
    expect(await lockMinutes(t2)).toBe(24 * 60);
    // It never goes past 24 hours.
    const t3 = new Date(t2.getTime() + 24 * 3_600_000 + 60_000);
    await fail(t3);
    expect(await lockMinutes(t3)).toBe(24 * 60);
  });

  it("entrar com a senha certa zera o bloqueio; tentativas antigas são apagadas pela limpeza diária", async () => {
    const email = "zera@test.dev";
    const now = new Date();
    for (let i = 0; i < 10; i++) await recordLoginFailure(email, `49.0.0.${i}`, null, now);
    expect(await prisma.loginLock.count({ where: { email } })).toBe(1);
    await recordLoginSuccess(email, "49.0.0.1", now);
    expect(await prisma.loginLock.count({ where: { email } })).toBe(0);

    await prisma.loginAttempt.create({ data: { email, ipAddress: "49.0.0.1", success: false, createdAt: new Date(now.getTime() - 100 * 24 * 3_600_000) } });
    const before = await prisma.loginAttempt.count({ where: { email } });
    await purgeOldLoginAttempts(now);
    expect(await prisma.loginAttempt.count({ where: { email } })).toBe(before - 1);
  });

  it("um IP com 100 senhas erradas em 15 minutos é recusado, mesmo trocando de e-mail e com a contagem gravada no banco", async () => {
    const now = new Date();
    await prisma.loginAttempt.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ email: `alvo${i}@test.dev`, ipAddress: "50.0.0.1", success: false, createdAt: now })) });
    const res = await loginFrom("50.0.0.1", "ana-sec@test.dev", TEST_PASSWORD);
    expect(res.status).toBe(429);
    // Another IP is not affected.
    expect((await loginFrom("50.0.0.2", "ana-sec@test.dev", TEST_PASSWORD)).status).toBe(200);
  });

  it("os administradores são avisados e a Auditoria registra; em Usuários aparece o bloqueio e o administrador desbloqueia", async () => {
    for (let i = 1; i <= 10; i++) await loginFrom(`51.0.0.${i}`, "ana-sec@test.dev", "errada");

    const notices = await prisma.notification.findMany({ where: { userId: adminId, type: "SECURITY" } });
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("ana-sec@test.dev");
    expect(notices[0].body).toContain("10 senhas erradas");
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_LOCKED" } })).toBeGreaterThanOrEqual(1);

    const list = await request(app).get("/api/users").set("Authorization", `Bearer ${adminToken}`);
    const ana = list.body.find((u: { email: string }) => u.email === "ana-sec@test.dev");
    expect(new Date(ana.loginLockedUntil).getTime()).toBeGreaterThan(Date.now());
    expect(list.body.find((u: { email: string }) => u.email === "admin-sec@test.dev").loginLockedUntil).toBeNull();

    expect((await loginFrom("51.0.0.77", "ana-sec@test.dev", TEST_PASSWORD)).status).toBe(429);
    expect((await request(app).post(`/api/users/${ana.id}/unlock-login`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(204);
    expect((await loginFrom("51.0.0.77", "ana-sec@test.dev", TEST_PASSWORD)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "USER_LOGIN_UNLOCKED", entityId: ana.id } })).toBe(1);
  });
});

describe("regras de senha", () => {
  it.each([
    ["curta1", "pelo menos 8 caracteres"],
    ["somenteletras", "uma letra e um número"],
    ["1234567890", "uma letra e um número"],
    ["Senha@123", "muito comum"],
    ["Password2026!", "muito comum"],
    ["Test@1234", "muito comum"],
    ["Mudar@123", "muito comum"],
    ["a12345678", "menos óbvia"],
    ["a1a1a1a1", "menos óbvia"],
  ])("recusa %s", (password, reason) => {
    expect(passwordProblem(password)).toContain(reason);
  });

  it("recusa o próprio nome ou e-mail como senha", () => {
    expect(passwordProblem("Heberson2026", { fullName: "Heberson Silva" })).toContain("seu nome");
    expect(passwordProblem("joana.souza99", { email: "joana.souza@clinica.com" })).toContain("seu nome");
  });

  it.each(["Girassol#4821", "c4valo-Azul-pula", "Tr0cadilho!Verde", "minha casa tem 3 gatos"])("aceita %s", (password) => {
    expect(passwordProblem(password, { fullName: "Ana Lima", email: "ana@clinica.com" })).toBeNull();
  });
});

describe("senha definida por outra pessoa precisa ser trocada no primeiro acesso", () => {
  let adminToken: string;
  const login = (email: string, password: string) => request(app).post("/api/auth/login").send({ email, password });
  const NEW_USER = { fullName: "Carla Nova", displayName: "Carla", email: "carla-nova@test.dev", password: "Girassol#4821", confirmPassword: "Girassol#4821", role: "MANAGER" };

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-mcp@test.dev", role: "ADMIN", displayName: "Admin" });
    adminToken = (await login("admin-mcp@test.dev", TEST_PASSWORD)).body.accessToken;
  });

  it("senha fraca é recusada ao criar o usuário, com o motivo", async () => {
    const res = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`).send({ ...NEW_USER, email: "fraca@test.dev", password: "Senha@123", confirmPassword: "Senha@123" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("muito comum");
  });

  it("usuário criado pelo administrador entra, mas só consegue trocar a senha; depois de trocar, usa o sistema normalmente", async () => {
    const created = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`).send(NEW_USER);
    expect(created.status).toBe(201);
    expect(created.body.mustChangePassword).toBe(true);

    const first = await login(NEW_USER.email, NEW_USER.password);
    expect(first.status).toBe(200);
    expect(first.body.user.mustChangePassword).toBe(true);
    const token = first.body.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };

    const blocked = await request(app).get("/api/conversations/mine").set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await request(app).get("/api/users").set(auth)).status).toBe(403);
    expect((await request(app).get(`/api/messages/attachments/x/download?token=${token}`)).status).toBe(403);
    // Who they are, and signing out, still work.
    expect((await request(app).get("/api/auth/me").set(auth)).status).toBe(200);

    // The same password again, or a weak one, is not accepted.
    const same = await request(app).post("/api/profile/password").set(auth).send({ currentPassword: NEW_USER.password, newPassword: NEW_USER.password, confirmPassword: NEW_USER.password });
    expect(same.status).toBe(400);
    const weak = await request(app).post("/api/profile/password").set(auth).send({ currentPassword: NEW_USER.password, newPassword: "Carla2026", confirmPassword: "Carla2026" });
    expect(weak.status).toBe(400);
    expect(weak.body.message).toContain("seu nome");

    const changed = await request(app).post("/api/profile/password").set(auth).send({ currentPassword: NEW_USER.password, newPassword: "Tr0cadilho!Verde", confirmPassword: "Tr0cadilho!Verde" });
    expect(changed.status).toBeLessThan(300);

    const second = await login(NEW_USER.email, "Tr0cadilho!Verde");
    expect(second.status).toBe(200);
    expect(second.body.user.mustChangePassword).toBe(false);
    expect((await request(app).get("/api/dashboard/summary").set("Authorization", `Bearer ${second.body.accessToken}`)).status).not.toBe(403);
  });

  it("senha redefinida pelo administrador também precisa ser trocada; a que a própria pessoa define, não", async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: NEW_USER.email } });
    const reset = await request(app).post(`/api/users/${user.id}/reset-password`).set("Authorization", `Bearer ${adminToken}`);
    expect(reset.status).toBe(200);
    const temp = await login(NEW_USER.email, reset.body.temporaryPassword);
    expect(temp.status).toBe(200);
    expect(temp.body.user.mustChangePassword).toBe(true);

    // An administrator typing a new password for someone else: same thing.
    await request(app).patch(`/api/users/${user.id}`).set("Authorization", `Bearer ${adminToken}`).send({ password: "c4valo-Azul-pula", confirmPassword: "c4valo-Azul-pula" }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword).toBe(true);

    // The administrator changing their own password through Usuários is choosing it themselves.
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin-mcp@test.dev" } });
    await request(app).patch(`/api/users/${admin.id}`).set("Authorization", `Bearer ${adminToken}`).send({ password: "Jabuticaba#77x", confirmPassword: "Jabuticaba#77x" }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).mustChangePassword).toBe(false);
  });
});
