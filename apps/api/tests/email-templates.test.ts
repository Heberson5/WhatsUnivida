import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn().mockResolvedValue({ messageId: "test" });
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";
import * as settingsService from "../src/modules/settings/settings.service";
import * as usersService from "../src/modules/users/users.service";
import * as authService from "../src/modules/auth/auth.service";
import * as profileService from "../src/modules/profile/profile.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

/** Configures SMTP so sendTemplatedMail actually reaches the (mocked) nodemailer transport instead of short-circuiting on "not configured". */
async function configureSmtp() {
  await settingsService.updateEmailSettings({ host: "smtp.test.dev", port: 587, fromEmail: "no-reply@test.dev", fromName: "Teste" });
}

function lastSentMail() {
  const call = sendMailMock.mock.calls.at(-1);
  if (!call) throw new Error("sendMail was never called");
  return call[0] as { to: string; subject: string; html: string; text: string };
}

describe("e-mail de modelos automáticos (redefinição de senha, boas-vindas, conta desativada)", () => {
  beforeEach(async () => {
    await resetDatabase();
    sendMailMock.mockClear();
    createTransportMock.mockClear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("traz os 4 modelos com valores padrão sensatos, todos habilitados, editáveis como texto puro (sem HTML)", async () => {
    const templates = await settingsService.getEmailTemplates();
    expect(Object.keys(templates).sort()).toEqual(["PASSWORD_CHANGED", "PASSWORD_RESET", "USER_DEACTIVATED", "USER_WELCOME"].sort());
    for (const type of ["PASSWORD_RESET", "USER_WELCOME", "USER_DEACTIVATED", "PASSWORD_CHANGED"] as const) {
      expect(templates[type].enabled).toBe(true);
      expect(templates[type].subject.length).toBeGreaterThan(0);
      expect(templates[type].title.length).toBeGreaterThan(0);
      expect(templates[type].bodyText).not.toContain("<p>"); // plain text, not markup
      // renderEmailTemplateHtml is what turns the plain-text fields into the
      // actual markup — used both by mail.ts and the admin's live preview.
      expect(settingsService.renderEmailTemplateHtml(type, templates[type])).toContain("{{empresa}}");
    }
    expect(templates.PASSWORD_RESET.buttonText.length).toBeGreaterThan(0);
    expect(settingsService.renderEmailTemplateHtml("PASSWORD_RESET", templates.PASSWORD_RESET)).toContain("{{link_redefinicao}}");
    expect(templates.USER_WELCOME.buttonText.length).toBeGreaterThan(0);
    expect(settingsService.renderEmailTemplateHtml("USER_WELCOME", templates.USER_WELCOME)).toContain("{{link_login}}");
    // No button field is meaningful for these two — nothing renders even if buttonText were set.
    expect(templates.USER_DEACTIVATED.buttonText).toBe("");
    expect(templates.PASSWORD_CHANGED.buttonText).toBe("");
  });

  it("persiste um patch (assunto, título, texto, botão, ativo) e o retorna depois", async () => {
    await settingsService.updateEmailTemplate("PASSWORD_RESET", {
      enabled: false,
      subject: "Assunto customizado",
      title: "Título customizado",
      bodyText: "Olá, {{nome}}.\n\nUse o link: {{link_redefinicao}}",
      buttonText: "Trocar senha",
    });

    const templates = await settingsService.getEmailTemplates();
    expect(templates.PASSWORD_RESET).toEqual({
      enabled: false,
      subject: "Assunto customizado",
      title: "Título customizado",
      bodyText: "Olá, {{nome}}.\n\nUse o link: {{link_redefinicao}}",
      buttonText: "Trocar senha",
    });
    // The other templates are untouched by a patch to one type.
    expect(templates.USER_WELCOME.enabled).toBe(true);
  });

  it("um texto sem botão configurado (buttonText vazio) não gera nenhum link/botão no HTML renderizado", async () => {
    await settingsService.updateEmailTemplate("PASSWORD_RESET", { buttonText: "" });
    const templates = await settingsService.getEmailTemplates();
    const html = settingsService.renderEmailTemplateHtml("PASSWORD_RESET", templates.PASSWORD_RESET);
    expect(html).not.toContain("{{link_redefinicao}}");
    expect(html).not.toContain("<a href");
  });

  it("escapa caracteres HTML digitados no título/texto, para o admin não precisar entender HTML", async () => {
    await settingsService.updateEmailTemplate("USER_DEACTIVATED", {
      title: "Tí<tulo> & \"especial\"",
      bodyText: "Texto com <script>alert(1)</script> & aspas \"assim\".",
    });
    const templates = await settingsService.getEmailTemplates();
    const html = settingsService.renderEmailTemplateHtml("USER_DEACTIVATED", templates.USER_DEACTIVATED);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Tí&lt;tulo&gt; &amp; &quot;especial&quot;");
  });

  it("envia o e-mail de boas-vindas ao criar um usuário, com as tags substituídas", async () => {
    await configureSmtp();
    const user = await usersService.createUser({
      fullName: "Ana Paula",
      displayName: "Ana",
      email: "ana@test.dev",
      password: "Test@1234",
      role: "AGENT",
      whatsappConnectionId: (await prisma.whatsAppConnection.create({ data: { name: "Suporte" } })).id,
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = lastSentMail();
    expect(mail.to).toBe(user.email);
    expect(mail.subject).not.toContain("{{");
    expect(mail.html).toContain("Ana");
    expect(mail.html).toContain("ana@test.dev");
    expect(mail.html).toContain("/login");
    expect(mail.html).not.toContain("{{nome}}");
    expect(mail.html).not.toContain("{{email}}");
    expect(mail.html).not.toContain("{{link_login}}");
  });

  it("não envia o e-mail de boas-vindas quando o modelo está desativado", async () => {
    await configureSmtp();
    await settingsService.updateEmailTemplate("USER_WELCOME", { enabled: false });

    await usersService.createUser({
      fullName: "Bruno",
      displayName: "Bruno",
      email: "bruno@test.dev",
      password: "Test@1234",
      role: "MANAGER",
    });

    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("envia o e-mail de conta desativada apenas na transição ATIVO->INATIVO, nunca em uma chamada repetida", async () => {
    await configureSmtp();
    const user = await usersService.createUser({
      fullName: "Carla",
      displayName: "Carla",
      email: "carla@test.dev",
      password: "Test@1234",
      role: "MANAGER",
    });
    sendMailMock.mockClear(); // drop the welcome e-mail from creation

    await usersService.setUserStatus(user.id, "INACTIVE");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(lastSentMail().html).toContain("Carla");

    await usersService.setUserStatus(user.id, "INACTIVE"); // repeat — already inactive
    expect(sendMailMock).toHaveBeenCalledTimes(1); // no second e-mail
  });

  it("renderiza o link e o nome no e-mail de redefinição de senha", async () => {
    await configureSmtp();
    await createTestUser({ email: "duda@test.dev", role: "AGENT", displayName: "Duda" });

    const result = await authService.requestPasswordReset("duda@test.dev");
    expect(result?.token).toBeTruthy();
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = lastSentMail();
    expect(mail.html).toContain("Duda");
    expect(mail.html).toContain(`token=${result!.token}`);
    expect(mail.html).not.toContain("{{nome}}");
    expect(mail.html).not.toContain("{{link_redefinicao}}");
  });

  it("envia o e-mail de confirmação de senha alterada ao concluir uma redefinição de senha", async () => {
    await configureSmtp();
    await createTestUser({ email: "fefe@test.dev", role: "AGENT", displayName: "Fefe" });

    const result = await authService.requestPasswordReset("fefe@test.dev");
    sendMailMock.mockClear(); // drop the reset-request e-mail

    await authService.resetPassword(result!.token, "NovaSenha@1234");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = lastSentMail();
    expect(mail.to).toBe("fefe@test.dev");
    expect(mail.subject).toContain("senha foi alterada");
    expect(mail.html).toContain("Fefe");
    expect(mail.html).not.toContain("{{nome}}");
  });

  it("envia o e-mail de confirmação de senha alterada quando o próprio usuário troca a senha em Meu Perfil", async () => {
    await configureSmtp();
    const user = await createTestUser({ email: "gigi@test.dev", role: "AGENT", displayName: "Gigi" });
    sendMailMock.mockClear();

    await profileService.changeOwnPassword(user.id, TEST_PASSWORD, "OutraSenha@1234");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = lastSentMail();
    expect(mail.to).toBe("gigi@test.dev");
    expect(mail.html).toContain("Gigi");
  });

  it("não envia o e-mail de senha alterada quando o modelo está desativado", async () => {
    await configureSmtp();
    await settingsService.updateEmailTemplate("PASSWORD_CHANGED", { enabled: false });
    const user = await createTestUser({ email: "hugo@test.dev", role: "AGENT", displayName: "Hugo" });
    sendMailMock.mockClear();

    await profileService.changeOwnPassword(user.id, TEST_PASSWORD, "OutraSenha@1234");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("resolve as tags comuns (empresa/cor primária) a partir da Identidade visual", async () => {
    await configureSmtp();
    await settingsService.updateBranding({ companyName: "Acme Atendimento", primaryColor: "#123456" });

    await usersService.createUser({
      fullName: "Eva",
      displayName: "Eva",
      email: "eva@test.dev",
      password: "Test@1234",
      role: "MANAGER",
    });

    const mail = lastSentMail();
    expect(mail.html).toContain("Acme Atendimento");
    expect(mail.html).toContain("#123456");
    expect(mail.html).not.toContain("{{empresa}}");
    expect(mail.html).not.toContain("{{cor_primaria}}");
  });

  it("GET/PATCH /settings/email-templates exige a permissão de gerenciar configurações e persiste via API", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    const token = await loginAs("admin@test.dev");

    const listed = await request(app).get("/api/settings/email-templates").set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.templates.PASSWORD_RESET.enabled).toBe(true);
    expect(listed.body.tags.PASSWORD_RESET.some((t: { tag: string }) => t.tag === "{{link_redefinicao}}")).toBe(true);
    expect(listed.body.commonTags.some((t: { tag: string }) => t.tag === "{{empresa}}")).toBe(true);
    expect(listed.body.hasButton).toEqual({ PASSWORD_RESET: true, USER_WELCOME: true, USER_DEACTIVATED: false, PASSWORD_CHANGED: false });

    const previewed = await request(app)
      .post("/api/settings/email-templates/PASSWORD_RESET/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Assunto {{empresa}}", title: "Título de teste", bodyText: "Olá, {{nome}}.", buttonText: "Clique aqui" });
    expect(previewed.status).toBe(200);
    expect(previewed.body.subject).not.toContain("{{"); // {{empresa}} resolved from Identidade visual
    expect(previewed.body.html).toContain("Título de teste");
    expect(previewed.body.html).toContain("Clique aqui");
    expect(previewed.body.html).toContain("Maria Souza"); // PREVIEW_SAMPLE_VARS.PASSWORD_RESET.nome

    const patched = await request(app)
      .patch("/api/settings/email-templates/USER_DEACTIVATED")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.USER_DEACTIVATED.enabled).toBe(false);

    const rejectedType = await request(app)
      .patch("/api/settings/email-templates/NOT_A_TYPE")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: false });
    expect(rejectedType.status).toBe(400);
  });

  it("bloqueia um AGENT sem a permissão de gerenciar configurações", async () => {
    await createTestUser({ email: "agente@test.dev", role: "AGENT", displayName: "Agente" });
    const token = await loginAs("agente@test.dev");

    const res = await request(app).get("/api/settings/email-templates").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
