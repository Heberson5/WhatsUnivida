import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { base32Decode, base32Encode, matchTotpStep, totpCodeForStep, totpStepAt } from "../src/lib/totp";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

// Verificação em duas etapas: the password plus a code from an authenticator app.

const app = createApp();

describe("códigos do aplicativo autenticador (RFC 6238)", () => {
  // The RFC's own test secret ("12345678901234567890") and three of its SHA-1 vectors, cut to 6 digits.
  const secret = base32Encode(Buffer.from("12345678901234567890"));

  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
  ])("no instante %d o código é %s", (seconds, code) => {
    expect(totpCodeForStep(secret, totpStepAt(new Date(seconds * 1000)))).toBe(code);
  });

  it("aceita o código atual e os vizinhos de 30 segundos; recusa os demais e o que não é número", () => {
    const now = new Date(1234567890 * 1000);
    const step = totpStepAt(now);
    expect(matchTotpStep(secret, "005924", now)).toBe(step);
    expect(matchTotpStep(secret, " 005 924 ", now)).toBe(step);
    expect(matchTotpStep(secret, totpCodeForStep(secret, step - 1), now)).toBe(step - 1);
    expect(matchTotpStep(secret, totpCodeForStep(secret, step + 1), now)).toBe(step + 1);
    expect(matchTotpStep(secret, totpCodeForStep(secret, step - 2), now)).toBeNull();
    expect(matchTotpStep(secret, "abcdef", now)).toBeNull();
    expect(matchTotpStep(secret, "12345", now)).toBeNull();
  });

  it("o segredo vai e volta do formato que os aplicativos leem", () => {
    const bytes = Buffer.from("um segredo qualquer!");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });
});

describe("verificação em duas etapas no login", () => {
  let adminToken: string;
  const EMAIL = "ana-2fa@test.dev";
  const login = (body: Record<string, unknown>, ip = "200.30.0.1") => request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: EMAIL, password: TEST_PASSWORD, ...body });
  const codeNow = (secret: string, offsetSteps = 0) => totpCodeForStep(secret, totpStepAt(new Date()) + offsetSteps);

  /** Switches it on for Ana through the API, as Meu Perfil does. */
  async function enable(): Promise<{ secret: string; recoveryCodes: string[] }> {
    const token = (await login({})).body.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };
    const setup = await request(app).post("/api/profile/two-factor/setup").set(auth);
    expect(setup.status).toBe(200);
    expect(setup.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
    // Nothing changes until a code is confirmed: the QR Code alone doesn't lock anybody out. (A new login replaces
    // the session, so the rest goes on with its token.)
    const relogin = await login({});
    expect(relogin.status).toBe(200);
    const again = { Authorization: `Bearer ${relogin.body.accessToken as string}` };
    expect((await request(app).post("/api/profile/two-factor/confirm").set(again).send({ code: "000000" })).status).toBe(400);
    const confirm = await request(app).post("/api/profile/two-factor/confirm").set(again).send({ code: codeNow(setup.body.secret, -1) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    return { secret: setup.body.secret, recoveryCodes: confirm.body.recoveryCodes };
  }

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-2fa@test.dev", role: "ADMIN", displayName: "Admin" });
    adminToken = (await request(app).post("/api/auth/login").send({ email: "admin-2fa@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  beforeEach(async () => {
    await prisma.loginLock.deleteMany();
    await prisma.loginAttempt.deleteMany();
    await prisma.refreshToken.deleteMany({ where: { user: { email: EMAIL } } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await createTestUser({ email: EMAIL, role: "AGENT", displayName: "Ana" });
    await prisma.systemSetting.deleteMany({ where: { key: "business" } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("com ela ligada, a senha sozinha não entra: pede o código, recusa o errado e aceita o certo", async () => {
    const { secret } = await enable();

    const onlyPassword = await login({});
    expect(onlyPassword.status).toBe(401);
    expect(onlyPassword.body.error).toBe("TOTP_REQUIRED");
    expect(onlyPassword.body.accessToken).toBeUndefined();
    expect(onlyPassword.headers["set-cookie"]).toBeUndefined();

    const wrong = await login({ totpCode: "123456" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("TOTP_INVALID");

    const right = await login({ totpCode: codeNow(secret) });
    expect(right.status).toBe(200);
    expect(right.body.user.twoFactorEnabled).toBe(true);
    // The secret and the recovery codes never leave the server.
    expect(JSON.stringify(right.body)).not.toContain(secret);
    expect(JSON.stringify(right.body)).not.toMatch(/totp|recovery/i);
    // A wrong password still answers as a wrong password — never asking for the code.
    expect((await request(app).post("/api/auth/login").send({ email: EMAIL, password: "errada" })).body.message).toBe("E-mail ou senha invalidos");
  });

  it("o mesmo código não vale duas vezes", async () => {
    const { secret } = await enable();
    const code = codeNow(secret);
    expect((await login({ totpCode: code })).status).toBe(200);
    const replay = await login({ totpCode: code });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("TOTP_INVALID");
  });

  it("código de recuperação entra uma única vez", async () => {
    const { recoveryCodes } = await enable();
    expect((await login({ totpCode: recoveryCodes[0].toLowerCase().replace("-", "") })).status).toBe(200);
    expect((await login({ totpCode: recoveryCodes[0] })).status).toBe(401);
    expect((await login({ totpCode: recoveryCodes[1] })).status).toBe(200);
    expect((await prisma.user.findFirstOrThrow({ where: { email: EMAIL } })).totpRecoveryCodes).toHaveLength(8);
  });

  it("códigos errados contam para o bloqueio do login, como senhas erradas", async () => {
    const { secret } = await enable();
    for (let i = 1; i <= 10; i++) expect((await login({ totpCode: "000000" }, `70.0.0.${i}`)).status).toBe(401);
    // Locked for places the person never logged in from — even with the right code.
    expect((await login({ totpCode: codeNow(secret) }, "70.0.0.99")).status).toBe(429);
  });

  it("desativar pede a senha e um código; o administrador remove a de quem perdeu o celular", async () => {
    const { secret } = await enable();
    const token = (await login({ totpCode: codeNow(secret) })).body.accessToken as string;
    const disable = (body: object) => request(app).post("/api/profile/two-factor/disable").set("Authorization", `Bearer ${token}`).send(body);
    expect((await disable({ password: "errada", code: codeNow(secret, 1) })).status).toBe(401);
    expect((await disable({ password: TEST_PASSWORD, code: "000000" })).status).toBe(400);
    expect((await login({})).status).toBe(401); // still on

    const user = await prisma.user.findFirstOrThrow({ where: { email: EMAIL } });
    expect((await request(app).get("/api/users").set("Authorization", `Bearer ${adminToken}`)).body.find((u: { id: string }) => u.id === user.id).twoFactorEnabled).toBe(true);
    expect((await request(app).post(`/api/users/${user.id}/reset-two-factor`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(204);
    expect((await login({})).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "USER_TWO_FACTOR_RESET", entityId: user.id } })).toBe(1);
    const cleared = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect([cleared.totpSecret, cleared.totpEnabledAt, cleared.totpRecoveryCodes]).toEqual([null, null, []]);
  });

  it("exigir dos administradores: só quem já tem ligada pode exigir, e o administrador sem ela só consegue ativar", async () => {
    const patch = (token: string, value: boolean) => request(app).patch("/api/settings/business").set("Authorization", `Bearer ${token}`).send({ requireAdminTwoFactor: value });
    // The administrator doesn't have it yet: can't demand it (it would lock every administrator out).
    const refused = await patch(adminToken, true);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("Ative primeiro");

    // Switches it on for themselves, then demands it.
    const setup = await request(app).post("/api/profile/two-factor/setup").set("Authorization", `Bearer ${adminToken}`);
    await request(app).post("/api/profile/two-factor/confirm").set("Authorization", `Bearer ${adminToken}`).send({ code: codeNow(setup.body.secret, -1) }).expect(200);
    expect((await patch(adminToken, true)).status).toBe(200);
    // While required, an administrator can't switch their own off.
    const off = await request(app).post("/api/profile/two-factor/disable").set("Authorization", `Bearer ${adminToken}`).send({ password: TEST_PASSWORD, code: codeNow(setup.body.secret) });
    expect(off.status).toBe(403);

    // Another administrator, without it: gets in, but only to switch it on.
    await prisma.user.deleteMany({ where: { email: "admin2-2fa@test.dev" } });
    await createTestUser({ email: "admin2-2fa@test.dev", role: "ADMIN", displayName: "Admin 2" });
    const second = await request(app).post("/api/auth/login").send({ email: "admin2-2fa@test.dev", password: TEST_PASSWORD });
    expect(second.status).toBe(200);
    expect(second.body.user.mustSetUpTwoFactor).toBe(true);
    const auth = { Authorization: `Bearer ${second.body.accessToken}` };
    const blocked = await request(app).get("/api/users").set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("TWO_FACTOR_SETUP_REQUIRED");
    const own = await request(app).post("/api/profile/two-factor/setup").set(auth);
    expect(own.status).toBe(200);
    await request(app).post("/api/profile/two-factor/confirm").set(auth).send({ code: codeNow(own.body.secret, -1) }).expect(200);
    const after = await request(app).post("/api/auth/login").send({ email: "admin2-2fa@test.dev", password: TEST_PASSWORD, totpCode: codeNow(own.body.secret) });
    expect(after.status).toBe(200);
    expect(after.body.user.mustSetUpTwoFactor).toBe(false);
    expect((await request(app).get("/api/users").set("Authorization", `Bearer ${after.body.accessToken}`)).status).toBe(200);

    // A Gestor with access to Configurações can't change this rule; an Atendente is never asked to set it up.
    await createTestUser({ email: "gestor-2fa@test.dev", role: "MANAGER" });
    await prisma.rolePermission.create({ data: { role: "MANAGER", permission: "configuracoes.gerenciar", allowed: true } });
    const manager = (await request(app).post("/api/auth/login").send({ email: "gestor-2fa@test.dev", password: TEST_PASSWORD })).body;
    expect(manager.user.mustSetUpTwoFactor).toBe(false);
    expect((await patch(manager.accessToken, false)).status).toBe(403);
  });
});
