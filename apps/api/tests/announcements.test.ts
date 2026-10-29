import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";
import { todayKey } from "../src/modules/announcements/announcement-days";
import { purgeExpiredTrash } from "../src/modules/announcements/announcements.service";

const app = createApp();
const TZ = 240;

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

function notice(overrides: Record<string, unknown> = {}) {
  return {
    title: "Sistema fora do ar às 19h",
    body: "Manutenção de *20 minutos*.",
    kind: "URGENT",
    layout: "COVER",
    display: "POPUP_AND_BOARD",
    category: "Sistema",
    requireAck: false,
    pinned: false,
    linkUrl: null,
    linkLabel: null,
    startDate: todayKey(TZ),
    endDate: null,
    recurrence: "ONCE",
    audience: { all: true, roles: [], connectionIds: [], userIds: [] },
    ...overrides,
  };
}

describe("Pop Up › Avisos e Comunicados", () => {
  let managerToken: string;
  let agentEmail: string;

  beforeEach(async () => {
    await resetDatabase();
    const connection = await createTestConnection("Comercial");
    await createTestUser({ email: "gestor@test.dev", role: "MANAGER", displayName: "Gestora Ana" });
    agentEmail = "atendente@test.dev";
    await createTestUser({ email: agentEmail, role: "AGENT", displayName: "Bruno", whatsappConnectionId: connection.id });
    managerToken = await loginAs("gestor@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("o atendente não cria aviso, só recebe", async () => {
    const agentToken = await loginAs(agentEmail);
    const res = await request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${agentToken}`).send(notice());
    expect(res.status).toBe(403);
  });

  it("aparece no máximo 2 vezes no dia, uma por login, e o ciente encerra", async () => {
    const created = await request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${managerToken}`).send(notice({ requireAck: true }));
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // 1st login: pending, then shown.
    let token = await loginAs(agentEmail);
    let pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body.map((a: { id: string }) => a.id)).toEqual([id]);
    await request(app).post("/api/announcements/shown").set("Authorization", `Bearer ${token}`).send({ ids: [id], tz: TZ });
    // Same session: no second time.
    pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body).toHaveLength(0);

    // 2nd login: once more.
    token = await loginAs(agentEmail);
    pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body).toHaveLength(1);
    await request(app).post("/api/announcements/shown").set("Authorization", `Bearer ${token}`).send({ ids: [id], tz: TZ });

    // 3rd login: the day's limit was reached.
    token = await loginAs(agentEmail);
    pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body).toHaveLength(0);

    // A reminder brings it back once; the "ciente" stops it for good.
    const remind = await request(app).post(`/api/announcements/admin/${id}/remind`).set("Authorization", `Bearer ${managerToken}`);
    expect(remind.body.count).toBeGreaterThanOrEqual(1);
    pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body).toHaveLength(1);
    await request(app).post(`/api/announcements/${id}/ack`).set("Authorization", `Bearer ${token}`);
    pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body).toHaveLength(0);

    const receipts = await request(app).get(`/api/announcements/admin/${id}/receipts`).set("Authorization", `Bearer ${managerToken}`);
    const bruno = receipts.body.find((r: { name: string }) => r.name === "Bruno");
    expect(bruno.ackAt).not.toBeNull();
    expect(bruno.shownCount).toBe(2);

    const xlsx = await request(app).get(`/api/announcements/admin/${id}/receipts?format=xlsx`).set("Authorization", `Bearer ${managerToken}`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
  });

  it("'Só no mural' não vira pop-up, mas entra nos Comunicados; o público filtra por perfil", async () => {
    await request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${managerToken}`).send(notice({ title: "Mural", display: "BOARD_ONLY", kind: "INFO" }));
    await request(app)
      .post("/api/announcements/admin")
      .set("Authorization", `Bearer ${managerToken}`)
      .send(notice({ title: "Só gestores", audience: { all: false, roles: ["MANAGER"], connectionIds: [], userIds: [] } }));
    const token = await loginAs(agentEmail);
    const pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body).toHaveLength(0);
    const board = await request(app).get(`/api/announcements/board?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(board.body.items.map((a: { title: string }) => a.title)).toEqual(["Mural"]);
    expect(board.body.unread).toBe(1);
    expect(board.body.settings.name).toBe("Comunicados");
  });

  it("vai para a Lixeira, volta e é apagado de vez depois do prazo", async () => {
    const created = await request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${managerToken}`).send(notice());
    const id = created.body.id as string;
    await request(app).delete(`/api/announcements/admin/${id}`).set("Authorization", `Bearer ${managerToken}`).expect(204);
    let trash = await request(app).get("/api/announcements/trash").set("Authorization", `Bearer ${managerToken}`);
    expect(trash.body.items).toHaveLength(1);
    await request(app).post(`/api/announcements/trash/${id}/restore`).set("Authorization", `Bearer ${managerToken}`).expect(200);
    trash = await request(app).get("/api/announcements/trash").set("Authorization", `Bearer ${managerToken}`);
    expect(trash.body.items).toHaveLength(0);

    await request(app).patch("/api/announcements/trash/settings").set("Authorization", `Bearer ${managerToken}`).send({ trashDays: 7 }).expect(200);
    await request(app).delete(`/api/announcements/admin/${id}`).set("Authorization", `Bearer ${managerToken}`).expect(204);
    await prisma.announcement.update({ where: { id }, data: { deletedAt: new Date(Date.now() - 8 * 86_400_000) } });
    expect(await purgeExpiredTrash()).toBe(1);
    expect(await prisma.announcement.count()).toBe(0);
  });

  it("duplicar cria uma cópia pausada, começando hoje, sem leituras", async () => {
    const created = await request(app)
      .post("/api/announcements/admin")
      .set("Authorization", `Bearer ${managerToken}`)
      .send(notice({ startDate: "2026-01-01", endDate: "2026-01-10", recurrence: "DAILY" }));
    const copy = await request(app).post(`/api/announcements/admin/${created.body.id}/duplicate`).set("Authorization", `Bearer ${managerToken}`).send({ tz: TZ });
    expect(copy.status).toBe(201);
    expect(copy.body.paused).toBe(true);
    expect(copy.body.startDate).toBe(todayKey(TZ));
    expect(copy.body.readCount).toBe(0);
  });

  it("o Dashboard mostra leitura e quem falta confirmar, só para gestor e administrador", async () => {
    const created = await request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${managerToken}`).send(notice({ requireAck: true }));
    const agentToken = await loginAs(agentEmail);
    await request(app).post(`/api/announcements/${created.body.id}/read`).set("Authorization", `Bearer ${agentToken}`);
    const stats = await request(app).get(`/api/dashboard/announcements?period=today&tzOffsetMinutes=${TZ}`).set("Authorization", `Bearer ${managerToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.published).toBe(1);
    expect(stats.body.items[0].pendingNames).toContain("Bruno");
  });
});
