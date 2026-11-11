import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn().mockResolvedValue({ messageId: "test" });
  const createTransportMock = vi.fn((_options: unknown) => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { notifyOwner, resetOwnerAlertThrottleForTests } from "../src/modules/owner-alerts/owner-alerts.service";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

// See PROMPT: "uma segunda configuração de e-mail, SMS etc., que é somente para o administrador ... quero ser
// notificado de algumas situações".

const app = createApp();
const login = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;

const SETTINGS = {
  events: { LOGIN_LOCKED: true, WHATSAPP_DISCONNECTED: true, SEND_FAILED: true, USER_CREATED: true, SYSTEM_STARTED: true },
  email: { enabled: true, host: "smtp.dono.com", port: 465, secure: true, username: "avisos@dono.com", password: "segredo-do-dono", fromName: "Avisos", fromEmail: "avisos@dono.com", recipients: ["dono@dono.com"] },
  sms: { enabled: false, provider: null, config: {}, recipients: [] },
};

describe("Configurações › Avisos do administrador", () => {
  let admin: string;
  let manager: string;
  const api = (token: string) => ({
    get: () => request(app).get("/api/settings/owner-alerts").set("Authorization", `Bearer ${token}`),
    put: (body: unknown) => request(app).put("/api/settings/owner-alerts").set("Authorization", `Bearer ${token}`).send(body as object),
    test: (channel: string) => request(app).post("/api/settings/owner-alerts/test").set("Authorization", `Bearer ${token}`).send({ channel }),
  });
  const waitForMail = async (count: number) => {
    const end = Date.now() + 3000;
    while (sendMailMock.mock.calls.length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-owner@test.dev", role: "ADMIN", displayName: "Dono" });
    await createTestUser({ email: "gestor-owner@test.dev", role: "MANAGER", displayName: "Gestora" });
    admin = await login("admin-owner@test.dev");
    manager = await login("gestor-owner@test.dev");
  });

  beforeEach(async () => {
    sendMailMock.mockClear();
    sendMailMock.mockResolvedValue({ messageId: "test" });
    createTransportMock.mockClear();
    resetOwnerAlertThrottleForTests();
    await prisma.systemSetting.deleteMany({ where: { key: { in: ["ownerAlerts", "email"] } } });
    // The Gestor is given everything a Gestor can be given in Configurações — and still must not reach this.
    await prisma.rolePermission.deleteMany();
    const { PERMISSION_DEFINITIONS } = await import("@whatsatendende/types");
    await prisma.rolePermission.createMany({ data: PERMISSION_DEFINITIONS.filter((d) => d.editableRoles.includes("MANAGER")).map((d) => ({ role: "MANAGER" as const, permission: d.key, allowed: true })) });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("só o Administrador vê e edita — o Gestor não, nem com todas as permissões de Configurações", async () => {
    expect((await api(manager).get()).status).toBe(403);
    expect((await api(manager).put(SETTINGS)).status).toBe(403);
    expect((await api(manager).test("email")).status).toBe(403);
    expect((await api(admin).get()).status).toBe(200);
  });

  it("guarda a senha criptografada e nunca a devolve; em branco mantém a que estava", async () => {
    const saved = await api(admin).put(SETTINGS);
    expect(saved.status).toBe(200);
    expect(saved.body.email.hasPassword).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain("segredo-do-dono");
    const stored = JSON.stringify((await prisma.systemSetting.findUniqueOrThrow({ where: { key: "ownerAlerts" } })).value);
    expect(stored).not.toContain("segredo-do-dono");
    expect(stored).toContain("enc:v1:");
    // The audit trail has who receives, never the password.
    const audit = JSON.stringify((await prisma.auditLog.findFirstOrThrow({ where: { action: "OWNER_ALERTS_UPDATED" }, orderBy: { createdAt: "desc" } })).metadata);
    expect(audit).toContain("dono@dono.com");
    expect(audit).not.toContain("segredo");

    const { password: _omit, ...withoutPassword } = SETTINGS.email;
    await api(admin).put({ ...SETTINGS, email: { ...withoutPassword, host: "smtp2.dono.com" } }).expect(200);
    expect((await api(admin).test("email")).status).toBe(200);
    expect(createTransportMock.mock.calls.at(-1)![0]).toMatchObject({ host: "smtp2.dono.com", auth: { user: "avisos@dono.com", pass: "segredo-do-dono" } });
  });

  it("usa o servidor do Administrador, separado do e-mail da empresa", async () => {
    await api(admin).put(SETTINGS).expect(200);
    await prisma.systemSetting.create({ data: { key: "email", value: { host: "smtp.empresa.com", port: 587, secure: false, username: null, password: null, fromName: "Empresa", fromEmail: "contato@empresa.com" } } });

    await notifyOwner("WHATSAPP_DISCONNECTED", "Conexão do WhatsApp caiu", ["A conexão Recepção está desconectada."]);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock.mock.calls.at(-1)![0]).toMatchObject({ host: "smtp.dono.com", port: 465 });
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe("dono@dono.com");
    expect(mail.from).toContain("avisos@dono.com");
    expect(mail.subject).toBe("Conexão do WhatsApp caiu");
    expect(mail.text).toContain("A conexão Recepção está desconectada.");
    expect((await api(admin).get()).body.lastSentAt).not.toBeNull();
  });

  it("respeita o que foi desmarcado, não repete o mesmo aviso em seguida e nada sai sem canal ligado", async () => {
    await api(admin).put({ ...SETTINGS, events: { ...SETTINGS.events, USER_CREATED: false } }).expect(200);
    await notifyOwner("USER_CREATED", "Novo usuário criado", ["x"]);
    expect(sendMailMock).not.toHaveBeenCalled();

    await notifyOwner("SEND_FAILED", "Falha ao enviar mensagens", ["x"], { throttleMs: 30 * 60_000 });
    await notifyOwner("SEND_FAILED", "Falha ao enviar mensagens", ["x"], { throttleMs: 30 * 60_000 });
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    await api(admin).put({ ...SETTINGS, email: { ...SETTINGS.email, enabled: false } }).expect(200);
    await notifyOwner("SYSTEM_STARTED", "Sistema reiniciado", ["x"]);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("uma falha no envio não derruba o que causou o aviso e aparece na tela; o teste mostra o erro na hora", async () => {
    await api(admin).put(SETTINGS).expect(200);
    sendMailMock.mockRejectedValue(new Error("535 Authentication failed"));
    await expect(notifyOwner("SEND_FAILED", "Falha ao enviar mensagens", ["x"])).resolves.toBeUndefined();
    const state = (await api(admin).get()).body;
    expect(state.lastError).toMatchObject({ channel: "email", message: "535 Authentication failed" });

    const test = await api(admin).test("email");
    expect(test.status).toBe(400);
    expect(test.body.message).toContain("535 Authentication failed");
  });

  it("valida o que é preciso para ligar cada canal", async () => {
    expect((await api(admin).put({ ...SETTINGS, email: { ...SETTINGS.email, recipients: [] } })).status).toBe(400);
    expect((await api(admin).put({ ...SETTINGS, email: { ...SETTINGS.email, host: "" } })).status).toBe(400);
    expect((await api(admin).put({ ...SETTINGS, sms: { enabled: true, provider: null, config: {}, recipients: ["65999990000"] } })).status).toBe(400);
    expect((await api(admin).put({ ...SETTINGS, sms: { enabled: true, provider: "ZENVIA", config: { token: "t", from: "c" }, recipients: ["123"] } })).status).toBe(400);
    const ok = await api(admin).put({ ...SETTINGS, sms: { enabled: true, provider: "ZENVIA", config: { token: "chave-sms", from: "conta" }, recipients: ["(65) 99999-0000"] } });
    expect(ok.status).toBe(200);
    expect(ok.body.sms.recipients).toEqual(["5565999990000"]);
    expect(ok.body.sms.config.token).toBe("");
    expect(ok.body.sms.secretsSet.token).toBe(true);
  });

  it("avisa quando um usuário é criado e quando um login é bloqueado", async () => {
    await api(admin).put(SETTINGS).expect(200);
    await request(app).post("/api/users").set("Authorization", `Bearer ${admin}`).send({ fullName: "Paula Recepção", displayName: "Paula", email: "paula-owner@test.dev", password: "Girassol#4821", confirmPassword: "Girassol#4821", role: "MANAGER" }).expect(201);
    await waitForMail(1);
    const created = sendMailMock.mock.calls.find((c) => c[0].subject === "Novo usuário criado");
    expect(created![0].text).toContain("Paula Recepção (paula-owner@test.dev), perfil Gestor, criado por Dono");

    for (let i = 1; i <= 10; i++) await request(app).post("/api/auth/login").set("X-Forwarded-For", `60.0.0.${i}`).send({ email: "paula-owner@test.dev", password: "errada" });
    await waitForMail(2);
    const locked = sendMailMock.mock.calls.find((c) => c[0].subject === "Login bloqueado por senhas erradas" && c[0].to === "dono@dono.com");
    expect(locked![0].text).toContain("paula-owner@test.dev: 10 senhas erradas");
  });
});
