import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { parseUserAgent, pingVisit, purgeOldVisits } from "../src/modules/site-analytics/site-analytics.service";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
const CHROME_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const loginAs = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;

/** The page reporting its visit, as the browser does: JSON sent as text/plain (sendBeacon / no preflight). */
const start = (body: Record<string, unknown>, ua = CHROME_DESKTOP, origin = "https://www.sauberlich.com.br") =>
  request(app).post("/api/public/site/visits").set("User-Agent", ua).set("Origin", origin).set("Content-Type", "text/plain").send(JSON.stringify(body));

describe("Acessos ao site", () => {
  let adminToken: string;
  let managerToken: string;
  let agentToken: string;
  const admin = () => ({ Authorization: `Bearer ${adminToken}` });

  beforeAll(async () => {
    await resetDatabase();
    await prisma.siteVisit.deleteMany();
    await prisma.systemSetting.deleteMany({ where: { key: "siteAnalytics" } });
    await createTestUser({ email: "admin-site@test.dev", role: "ADMIN" });
    await createTestUser({ email: "gestor-site@test.dev", role: "MANAGER" });
    await createTestUser({ email: "ana-site@test.dev", role: "AGENT" });
    adminToken = await loginAs("admin-site@test.dev");
    managerToken = await loginAs("gestor-site@test.dev");
    agentToken = await loginAs("ana-site@test.dev");
  });

  afterAll(async () => {
    await prisma.siteVisit.deleteMany();
    await prisma.$disconnect();
  });

  it("lê aparelho, navegador e sistema, e reconhece robôs", () => {
    expect(parseUserAgent(CHROME_DESKTOP)).toMatchObject({ bot: false, device: "Computador", browser: "Chrome", os: "Windows" });
    expect(parseUserAgent(SAFARI_IPHONE)).toMatchObject({ bot: false, device: "Celular", browser: "Safari", os: "iOS" });
    expect(parseUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)").bot).toBe(true);
    expect(parseUserAgent("WhatsApp/2.23").bot).toBe(true);
    expect(parseUserAgent(undefined).bot).toBe(true);
  });

  it("a página registra a visita sem login, de qualquer site; robô e dado inválido não contam", async () => {
    const res = await start({ visitorId: "visitante-aaaa-1", url: "https://whatsatendente.sauberlich.com.br/login?utm_source=instagram&utm_campaign=natal", title: "Entrar", referrer: "https://www.google.com/search?q=x" });
    expect(res.status).toBe(201);
    // Another site may call it: any origin, never with credentials.
    expect(res.headers["access-control-allow-origin"]).toBe("https://www.sauberlich.com.br");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    const visit = await prisma.siteVisit.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(visit).toMatchObject({ site: "whatsatendente.sauberlich.com.br", path: "/login", referrer: "google.com", utmSource: "instagram", utmCampaign: "natal", device: "Computador", browser: "Chrome", os: "Windows" });

    expect((await start({ visitorId: "robo-aaaaaaaa", url: "https://whatsatendente.sauberlich.com.br/login" }, "Googlebot/2.1")).status).toBe(204);
    expect((await start({ visitorId: "x", url: "https://whatsatendente.sauberlich.com.br/" })).status).toBe(400);
    // Not a web page: not counted.
    expect((await start({ visitorId: "visitante-aaaa-1", url: "javascript:alert(1)" })).status).toBe(204);
    // Moving inside the same site is not an origin.
    const inside = await start({ visitorId: "visitante-aaaa-1", url: "https://whatsatendente.sauberlich.com.br/reset-password", referrer: "https://whatsatendente.sauberlich.com.br/login" });
    expect((await prisma.siteVisit.findUniqueOrThrow({ where: { id: inside.body.id } })).referrer).toBeNull();
    expect(await prisma.siteVisit.count()).toBe(2);
  });

  it("o código para outros sites é servido com permissão de ser carregado por eles", async () => {
    const res = await request(app).get("/api/public/site/tracker.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.text).toContain("/api/public/site");
    expect(res.text).toContain("doNotTrack");
  });

  it("o tempo na página vem dos sinais de vida, nunca mais que o tempo desde o início; visita velha não revive", async () => {
    const { body } = await start({ visitorId: "visitante-bbbb-2", url: "https://whatsatendente.sauberlich.com.br/login" }, SAFARI_IPHONE);
    const started = (await prisma.siteVisit.findUniqueOrThrow({ where: { id: body.id } })).startedAt.getTime();
    await request(app).post(`/api/public/site/visits/${body.id}/ping`).set("Content-Type", "text/plain").send(JSON.stringify({ seconds: 30 })).expect(204);
    // 30 seconds asked right after the start: capped at the time that really passed.
    expect((await prisma.siteVisit.findUniqueOrThrow({ where: { id: body.id } })).durationSeconds).toBeLessThanOrEqual(10);
    await pingVisit(body.id, 45, new Date(started + 60_000));
    expect((await prisma.siteVisit.findUniqueOrThrow({ where: { id: body.id } })).durationSeconds).toBe(45);
    // A smaller number later never lowers it.
    await pingVisit(body.id, 20, new Date(started + 70_000));
    expect((await prisma.siteVisit.findUniqueOrThrow({ where: { id: body.id } })).durationSeconds).toBe(45);
    // 40 minutes without a sign: that visit is over.
    expect(await pingVisit(body.id, 3000, new Date(started + 70_000 + 40 * 60_000))).toBe(false);
    await request(app).post(`/api/public/site/visits/${body.id}/login`).expect(204);
    expect((await prisma.siteVisit.findUniqueOrThrow({ where: { id: body.id } })).loggedIn).toBe(true);
  });

  it("só o administrador vê o painel", async () => {
    for (const token of [agentToken, managerToken]) {
      expect((await request(app).get("/api/site-analytics/summary").set("Authorization", `Bearer ${token}`)).status).toBe(403);
      expect((await request(app).get("/api/site-analytics/live").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    }
    expect((await request(app).get("/api/site-analytics/summary")).status).toBe(401);
    expect((await request(app).get("/api/site-analytics/summary").set(admin())).status).toBe(200);
  });

  it("resumo: visitas, visitantes novos e de retorno, tempo médio, saídas rápidas, entrada no sistema, origens e aparelhos", async () => {
    await prisma.siteVisit.deleteMany();
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    // A returning visitor: came 10 days ago too.
    await prisma.siteVisit.create({ data: { visitorId: "antigo-1", site: "whatsatendente.sauberlich.com.br", path: "/login", device: "Computador", startedAt: new Date(now - 10 * 86_400_000), lastSeenAt: new Date(now - 10 * 86_400_000) } });
    await prisma.siteVisit.createMany({
      data: [
        { visitorId: "antigo-1", site: "whatsatendente.sauberlich.com.br", path: "/login", device: "Computador", browser: "Chrome", os: "Windows", durationSeconds: 60, loggedIn: true, startedAt: at(30), lastSeenAt: at(29), city: "Cuiabá", region: "Mato Grosso", country: "Brasil" },
        { visitorId: "novo-1", site: "whatsatendente.sauberlich.com.br", path: "/login", device: "Celular", browser: "Safari", os: "iOS", durationSeconds: 5, referrer: "google.com", startedAt: at(20), lastSeenAt: at(20) },
        { visitorId: "novo-1", site: "www.sauberlich.com.br", path: "/", device: "Celular", browser: "Safari", os: "iOS", durationSeconds: 115, utmSource: "instagram", utmCampaign: "natal", startedAt: at(10), lastSeenAt: new Date(now - 20_000) },
      ],
    });
    const s = (await request(app).get("/api/site-analytics/summary").set(admin()).query({ period: "last7days", tzOffsetMinutes: 240 })).body;
    expect(s.totals).toMatchObject({ visits: 3, visitors: 2, newVisitors: 1, avgDurationSeconds: 60 });
    expect(s.totals.bounceRate).toBeCloseTo(1 / 3);
    expect(s.totals.loginRate).toBeCloseTo(1 / 2);
    expect(s.sites).toEqual(["whatsatendente.sauberlich.com.br", "www.sauberlich.com.br"]);
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay.reduce((sum: number, d: { visits: number }) => sum + d.visits, 0)).toBe(3);
    expect(s.byHour.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(s.referrers).toEqual([
      { key: "Acesso direto", visits: 2 },
      { key: "google.com", visits: 1 },
    ]);
    expect(s.campaigns).toEqual([{ key: "natal · instagram", visits: 1 }]);
    expect(s.devices[0]).toEqual({ key: "Celular", visits: 2 });
    expect(s.places).toContainEqual({ key: "Cuiabá, Mato Grosso, Brasil", visits: 1 });
    expect(s.pages[0]).toMatchObject({ path: "/login", visits: 2, avgDurationSeconds: 33 });

    const onlySite = (await request(app).get("/api/site-analytics/summary").set(admin()).query({ period: "last7days", site: "www.sauberlich.com.br" })).body;
    expect(onlySite.totals.visits).toBe(1);
    expect(onlySite.totals.loginRate).toBeNull();

    const live = (await request(app).get("/api/site-analytics/live").set(admin())).body;
    expect(live.now).toBe(1);
    // The tab closed (its last sign of life): no longer on the site now; back to the tab, it counts again.
    const onSite = await prisma.siteVisit.findFirstOrThrow({ where: { site: "www.sauberlich.com.br" } });
    await request(app).post(`/api/public/site/visits/${onSite.id}/ping`).set("Content-Type", "text/plain").send(JSON.stringify({ seconds: 116, ended: true })).expect(204);
    expect((await request(app).get("/api/site-analytics/live").set(admin())).body.now).toBe(0);
    await request(app).post(`/api/public/site/visits/${onSite.id}/ping`).set("Content-Type", "text/plain").send(JSON.stringify({ seconds: 117 })).expect(204);
    expect(live.visits[0]).toMatchObject({ site: "www.sauberlich.com.br", campaign: "natal · instagram", returning: true });

    const list = (await request(app).get("/api/site-analytics/visits").set(admin()).query({ period: "last7days", pageSize: 10 })).body;
    expect(list.total).toBe(3);
    expect(list.visits.map((v: { returning: boolean }) => v.returning)).toEqual([true, false, true]);

    const file = await request(app).get("/api/site-analytics/export").set(admin()).query({ period: "last7days" }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.body as Buffer);
    const sheet = book.getWorksheet("Acessos ao site")!;
    expect(sheet.rowCount).toBe(4);
    expect(sheet.getRow(1).getCell(10).value).toBe("Local");
    expect(sheet.getRow(2).getCell(10).value).toBe("Cuiabá, Mato Grosso, Brasil");
  });

  it("as visitas mais antigas que o prazo de guarda são apagadas", async () => {
    expect((await request(app).put("/api/site-analytics/settings").set(admin()).send({ retentionDays: 5 })).status).toBe(400);
    await request(app).put("/api/site-analytics/settings").set(admin()).send({ retentionDays: 30 }).expect(200);
    await prisma.siteVisit.create({ data: { visitorId: "muito-antigo", site: "x.com.br", path: "/", device: "Computador", startedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const before = await prisma.siteVisit.count();
    expect(await purgeOldVisits()).toBe(1);
    expect(await prisma.siteVisit.count()).toBe(before - 1);
  });
});
