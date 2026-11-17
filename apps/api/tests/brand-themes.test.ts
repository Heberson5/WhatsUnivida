import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { MONTH_THEMES, resolveBrandColors } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("Identidade visual › Tema (12 temas, um por mês, e Automático pelo mês)", () => {
  let adminToken: string;
  let agentToken: string;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.systemSetting.deleteMany({ where: { key: "branding" } });
    await createTestUser({ email: "admin-tema@test.dev", role: "ADMIN" });
    await createTestUser({ email: "ana-tema@test.dev", role: "AGENT" });
    adminToken = (await request(app).post("/api/auth/login").send({ email: "admin-tema@test.dev", password: TEST_PASSWORD })).body.accessToken;
    agentToken = (await request(app).post("/api/auth/login").send({ email: "ana-tema@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await prisma.systemSetting.deleteMany({ where: { key: "branding" } });
    await prisma.$disconnect();
  });

  const branding = async () => (await request(app).get("/api/settings/branding")).body;
  const choose = (theme: string, token = adminToken) => request(app).patch("/api/settings/branding").set("Authorization", `Bearer ${token}`).send({ theme });

  it("começa nas cores da empresa", async () => {
    const b = await branding();
    expect(b.theme).toBe("CUSTOM");
    expect(b.effective).toMatchObject({ primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, themeName: null });
  });

  it("um tema fixo troca as cores em uso (e a cor do 'lida'); só quem edita a identidade escolhe; tema desconhecido é recusado", async () => {
    expect((await choose("OUTUBRO_ROSA", agentToken)).status).toBe(403);
    expect((await choose("TEMA_INVENTADO")).status).toBe(400);
    expect((await choose("OUTUBRO_ROSA")).status).toBe(200);
    const rosa = MONTH_THEMES.find((t) => t.key === "OUTUBRO_ROSA")!;
    expect((await branding()).effective).toEqual({ primaryColor: rosa.primaryColor, secondaryColor: rosa.secondaryColor, readReceiptColor: rosa.readReceiptColor, themeName: "Outubro Rosa" });
    // A color picked by hand for the "lida" tick always wins over the theme's.
    await request(app).patch("/api/settings/branding").set("Authorization", `Bearer ${adminToken}`).send({ readReceiptColor: "#123456" }).expect(200);
    expect((await branding()).effective.readReceiptColor).toBe("#123456");
    await request(app).patch("/api/settings/branding").set("Authorization", `Bearer ${adminToken}`).send({ readReceiptColor: null }).expect(200);
  });

  it("Automático pelo mês segue o mês do horário da empresa, não o do servidor", async () => {
    await choose("MONTHLY").expect(200);
    // 1º de dezembro, 02:00 UTC = ainda 30 de novembro às 22h no horário da empresa (UTC-4).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T02:00:00Z"));
    expect(env.BUSINESS_TZ_OFFSET_MINUTES).toBe(240);
    expect((await branding()).effective.themeName).toBe("Novembro Azul");
    vi.setSystemTime(new Date("2026-12-01T05:00:00Z"));
    expect((await branding()).effective.themeName).toBe("Dezembro — Natal");
    vi.useRealTimers();
  });

  it("volta para as cores da empresa", async () => {
    await choose("CUSTOM").expect(200);
    expect((await branding()).effective.themeName).toBeNull();
    expect(resolveBrandColors({ primaryColor: "#000000", secondaryColor: "#FFFFFF", readReceiptColor: null, theme: "MONTHLY" }, 1).themeName).toBe("Janeiro Branco");
    expect(MONTH_THEMES.map((t) => t.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
