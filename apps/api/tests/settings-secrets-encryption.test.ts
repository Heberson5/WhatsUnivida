import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { encryptSecret, decryptSecret } from "../src/lib/crypto";
import * as settingsService from "../src/modules/settings/settings.service";
import { resetDatabase } from "./helpers";

describe("lib/crypto — at-rest encryption for secrets stored in SystemSetting", () => {
  it("round-trips a value through encryptSecret/decryptSecret", () => {
    const encrypted = encryptSecret("super-secret-smtp-password");
    expect(encrypted).not.toContain("super-secret-smtp-password");
    expect(decryptSecret(encrypted)).toBe("super-secret-smtp-password");
  });

  it("treats a value with no enc:v1: prefix as legacy plaintext, unchanged", () => {
    expect(decryptSecret("plain-old-password")).toBe("plain-old-password");
  });

  it("produces a different ciphertext each time (random IV), both still decrypting correctly", () => {
    const a = encryptSecret("same-password");
    const b = encryptSecret("same-password");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-password");
    expect(decryptSecret(b)).toBe("same-password");
  });
});

describe("settings.service — SMTP password is never stored in plain text", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("encrypts the password before writing SystemSetting, and getEmailSettings decrypts it back", async () => {
    await settingsService.updateEmailSettings({
      host: "smtp.test.dev",
      port: 587,
      fromEmail: "no-reply@test.dev",
      fromName: "Teste",
      username: "no-reply@test.dev",
      password: "correct horse battery staple",
    });

    const row = await prisma.systemSetting.findUniqueOrThrow({ where: { key: "email" } });
    const storedPassword = (row.value as { password: string | null }).password;
    expect(storedPassword).not.toBeNull();
    expect(storedPassword).not.toBe("correct horse battery staple");
    expect(storedPassword).toMatch(/^enc:v1:/);

    const settings = await settingsService.getEmailSettings();
    expect(settings?.password).toBe("correct horse battery staple");
  });

  it("a legacy plaintext password already in the DB (saved before encryption existed) still works, and gets upgraded to encrypted on the next save", async () => {
    await prisma.systemSetting.create({
      data: {
        key: "email",
        value: { host: "smtp.legacy.dev", port: 587, secure: false, username: "u", password: "legacy-plaintext-password", fromName: "Legacy", fromEmail: "legacy@test.dev" },
      },
    });

    const settings = await settingsService.getEmailSettings();
    expect(settings?.password).toBe("legacy-plaintext-password");

    // Saving again (even an unrelated field) re-encrypts the still-plaintext password.
    await settingsService.updateEmailSettings({ fromName: "Legacy Updated" });
    const row = await prisma.systemSetting.findUniqueOrThrow({ where: { key: "email" } });
    const storedPassword = (row.value as { password: string | null }).password;
    expect(storedPassword).toMatch(/^enc:v1:/);
    expect((await settingsService.getEmailSettings())?.password).toBe("legacy-plaintext-password");
  });

  it("never echoes the password back in the masked settings the API actually returns", async () => {
    await settingsService.updateEmailSettings({ host: "smtp.test.dev", fromEmail: "no-reply@test.dev", password: "super-secret" });
    const masked = await settingsService.getEmailSettingsMasked();
    expect(masked).not.toHaveProperty("password");
    expect(masked.hasPassword).toBe(true);
  });
});

describe("settings.service — Meta (Instagram/Messenger) app secrets are never stored in plain text", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("encrypts appSecret/pageAccessToken/igAccessToken before writing SystemSetting", async () => {
    await settingsService.updateMetaSettings({ appId: "123456", appSecret: "app-secret-value", pageAccessToken: "page-token-value", igAccessToken: "ig-token-value" });

    const row = await prisma.systemSetting.findUniqueOrThrow({ where: { key: "meta" } });
    const stored = row.value as { appSecret: string; pageAccessToken: string; igAccessToken: string };
    expect(stored.appSecret).toMatch(/^enc:v1:/);
    expect(stored.pageAccessToken).toMatch(/^enc:v1:/);
    expect(stored.igAccessToken).toMatch(/^enc:v1:/);

    const settings = await settingsService.getMetaSettings();
    expect(settings.appSecret).toBe("app-secret-value");
    expect(settings.pageAccessToken).toBe("page-token-value");
    expect(settings.igAccessToken).toBe("ig-token-value");
  });

  it("re-saving one field (e.g. appId) without resending a secret keeps the existing secret, not blank", async () => {
    await settingsService.updateMetaSettings({ appId: "111", pageAccessToken: "keep-me" });
    await settingsService.updateMetaSettings({ appId: "222" });
    const settings = await settingsService.getMetaSettings();
    expect(settings.appId).toBe("222");
    expect(settings.pageAccessToken).toBe("keep-me");
  });

  it("never echoes any secret back in the masked settings, only hasX booleans", async () => {
    await settingsService.updateMetaSettings({ appSecret: "x", pageAccessToken: "y", igAccessToken: "z" });
    const masked = await settingsService.getMetaSettingsMasked();
    expect(masked).not.toHaveProperty("appSecret");
    expect(masked).not.toHaveProperty("pageAccessToken");
    expect(masked).not.toHaveProperty("igAccessToken");
    expect(masked.hasAppSecret).toBe(true);
    expect(masked.hasPageAccessToken).toBe(true);
    expect(masked.hasIgAccessToken).toBe(true);
  });

  it("keeps every MetaConnection's status in sync with whether its channel has an access token configured", async () => {
    const messenger = await prisma.metaConnection.create({ data: { channel: "MESSENGER", name: "Página", externalPageId: "p1", status: "DISCONNECTED" } });
    const instagram = await prisma.metaConnection.create({ data: { channel: "INSTAGRAM", name: "Perfil", externalPageId: "i1", status: "DISCONNECTED" } });

    await settingsService.updateMetaSettings({ pageAccessToken: "token" });
    expect((await prisma.metaConnection.findUniqueOrThrow({ where: { id: messenger.id } })).status).toBe("CONNECTED");
    expect((await prisma.metaConnection.findUniqueOrThrow({ where: { id: instagram.id } })).status).toBe("DISCONNECTED");
  });
});
