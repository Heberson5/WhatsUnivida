import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";
import { addDays, todayKey } from "../src/modules/announcements/announcement-days";
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
    startTime: "00:00",
    endDate: addDays(todayKey(TZ), 1),
    endTime: "23:59",
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

  it("aparece a cada login, sem limite, até o ciente, e conta as vezes", async () => {
    const created = await request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${managerToken}`).send(notice());
    expect(created.status).toBe(201);
    expect(created.body.requireAck).toBe(true);
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

    // 3rd login: no limit any more.
    token = await loginAs(agentEmail);
    pending = await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`);
    expect(pending.body).toHaveLength(1);
    await request(app).post("/api/announcements/shown").set("Authorization", `Bearer ${token}`).send({ ids: [id], tz: TZ });

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
    expect(bruno.shownCount).toBe(3);

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

  it("exige data e horário de início e de término, com o término depois do início", async () => {
    const post = (body: Record<string, unknown>) => request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${managerToken}`).send(notice(body));
    expect((await post({ endTime: null })).status).toBe(400);
    expect((await post({ endDate: null })).status).toBe(400);
    expect((await post({ startTime: "25:00" })).status).toBe(400);
    expect((await post({ endDate: todayKey(TZ), startTime: "10:00", endTime: "10:00" })).status).toBe(400);
  });

  it("não abre antes do início nem depois do término; Encerrar agora termina na hora", async () => {
    const post = (body: Record<string, unknown>) => request(app).post("/api/announcements/admin").set("Authorization", `Bearer ${managerToken}`).send(notice(body));
    const tomorrow = addDays(todayKey(TZ), 1);
    const yesterday = addDays(todayKey(TZ), -1);
    const later = await post({ title: "Depois", startDate: tomorrow, startTime: "08:00", endDate: tomorrow, endTime: "09:00" });
    expect(later.body.status).toBe("SCHEDULED");
    const over = await post({ title: "Terminou", startDate: yesterday, endDate: yesterday });
    expect(over.body.status).toBe("ENDED");
    const running = await post({ title: "Rodando" });
    expect(running.body.status).toBe("ACTIVE");

    const token = await loginAs(agentEmail);
    const titles = async () => (await request(app).get(`/api/announcements/pending?tz=${TZ}`).set("Authorization", `Bearer ${token}`)).body.map((a: { title: string }) => a.title);
    expect(await titles()).toEqual(["Rodando"]);

    const notStarted = await request(app).post(`/api/announcements/admin/${later.body.id}/end-now`).set("Authorization", `Bearer ${managerToken}`).send({ tz: TZ });
    expect(notStarted.status).toBe(400);
    const ended = await request(app).post(`/api/announcements/admin/${running.body.id}/end-now`).set("Authorization", `Bearer ${managerToken}`).send({ tz: TZ });
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe("ENDED");
    expect(ended.body.endDate).toBe(todayKey(TZ));
    expect(await titles()).toEqual([]);

    // Whoever has it open can still confirm.
    expect((await request(app).post(`/api/announcements/${running.body.id}/ack`).set("Authorization", `Bearer ${token}`)).status).toBeLessThan(300);
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
