import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";

const app = createApp();
const HOUR = 60 * 60 * 1000;

describe("dashboard: team now and presence durations", () => {
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    token = (await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("counts who is online/paused right now and sums each agent's online and paused time in the period", async () => {
    const reason = await prisma.pauseReason.create({ data: { name: "Almoço" } });
    const paula = await createTestUser({ email: "paula@test.dev", role: "AGENT", displayName: "Paula", presence: "AWAY" });
    await prisma.user.update({ where: { id: paula.id }, data: { pauseReasonId: reason.id } });
    const now = Date.now();
    await prisma.agentStatusLog.createMany({
      data: [
        { userId: paula.id, status: "ONLINE", startedAt: new Date(now - 3 * HOUR), endedAt: new Date(now - HOUR) },
        { userId: paula.id, status: "AWAY", pauseReasonId: reason.id, startedAt: new Date(now - HOUR), endedAt: null },
      ],
    });

    const res = await request(app)
      .get("/api/dashboard/team")
      .query({ period: "custom", from: new Date(now - 24 * HOUR).toISOString(), to: new Date(now + HOUR).toISOString() })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // The admin just logged in (ONLINE) but only attendants count; Paula is paused.
    expect(res.body.now).toMatchObject({ online: 0, paused: 1, offline: 0 });
    expect(res.body.now.pausedUsers[0]).toMatchObject({ name: "Paula", reasonName: "Almoço" });

    const row = res.body.agents.find((a: { agentName: string }) => a.agentName === "Paula");
    expect(row).toMatchObject({ presence: "AWAY", pauseReasonName: "Almoço" });
    expect(row.onlineMs).toBeCloseTo(2 * HOUR, -4);
    expect(row.pausedMs).toBeGreaterThanOrEqual(HOUR - 5_000);
  });

  it("returns the previous period's headline numbers for comparison", async () => {
    const res = await request(app).get("/api/dashboard").query({ period: "today" }).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.previous).toEqual({ received: 0, unique: 0, closed: 0, messagesTotal: 0, avgFirstResponseMs: null });
  });

  it("counts conversations the customer opened, by the hour of their first message, inside and outside the connection's hours", async () => {
    const open = await createTestConnection("Sem expediente");
    const schedule = await prisma.workSchedule.create({ data: { name: "Fechado", state: "MT", city: "Cuiabá", days: {}, closedMessage: "Fechado." } });
    const closed = await prisma.whatsAppConnection.create({ data: { name: "Fechada", status: "CONNECTED", workScheduleId: schedule.id } });
    const now = Date.now();
    const at = new Date(now - 2 * HOUR);
    const conversation = async (connectionId: string, phone: string, direction: "INBOUND" | "OUTBOUND") => {
      const contact = await prisma.contact.create({ data: { phone, name: phone, whatsappConnectionId: connectionId } });
      await prisma.conversation.create({
        data: {
          contactId: contact.id,
          whatsappConnectionId: connectionId,
          status: "CLOSED",
          createdAt: at,
          lastMessageAt: at,
          messages: { create: { direction, type: "TEXT", body: "Oi", createdAt: at } },
        },
      });
    };
    await conversation(open.id, "5565990000001", "INBOUND");
    await conversation(closed.id, "5565990000002", "INBOUND");
    // Started by the company (first message is ours): not an arrival.
    await conversation(open.id, "5565990000003", "OUTBOUND");

    const paula = await createTestUser({ email: "paula@test.dev", role: "AGENT", displayName: "Paula" });
    const gestor = await createTestUser({ email: "gestor@test.dev", role: "MANAGER", displayName: "Gestor" });
    await prisma.agentStatusLog.createMany({
      data: [paula, gestor].map((u) => ({ userId: u.id, status: "ONLINE" as const, startedAt: new Date(at.getTime() - HOUR / 2), endedAt: new Date(at.getTime() + HOUR / 2) })),
    });

    const res = await request(app)
      .get("/api/dashboard/arrivals-by-hour")
      .query({ period: "custom", from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now).toISOString(), tzOffsetMinutes: 0 })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const hour = res.body.hours.find((h: { hour: number }) => h.hour === at.getUTCHours());
    // The manager and the admin were online too, but only attendants count.
    expect(hour).toMatchObject({ inside: 1, outside: 1, onlineAvg: 1, days: 1 });
    const totals = res.body.hours.reduce((sum: number, h: { inside: number; outside: number }) => sum + h.inside + h.outside, 0);
    expect(totals).toBe(2);
  });

  it("explica a diferença para a Gestão e abre na Gestão só as abertas pelo cliente naquela hora", async () => {
    const connection = await createTestConnection("Suporte");
    const now = Date.now();
    const conversation = async (phone: string, direction: "INBOUND" | "OUTBOUND", createdAt: Date, lastMessageAt: Date) => {
      const contact = await prisma.contact.create({ data: { phone, name: phone, whatsappConnectionId: connection.id } });
      return prisma.conversation.create({
        data: {
          contactId: contact.id,
          whatsappConnectionId: connection.id,
          status: "CLOSED",
          createdAt,
          lastMessageAt,
          messages: { create: { direction, type: "TEXT", body: "Oi", createdAt } },
        },
      });
    };
    const twoHoursAgo = new Date(now - 2 * HOUR);
    const oneHourAgo = new Date(now - HOUR);
    const early = await conversation("5565990000011", "INBOUND", twoHoursAgo, twoHoursAgo);
    await conversation("5565990000012", "INBOUND", oneHourAgo, oneHourAgo);
    await conversation("5565990000013", "OUTBOUND", oneHourAgo, oneHourAgo);
    // Opened two days ago, a message in the period: Gestão lists it, the chart doesn't.
    await conversation("5565990000014", "INBOUND", new Date(now - 48 * HOUR), oneHourAgo);

    const range = { period: "custom", from: new Date(now - 3 * HOUR).toISOString(), to: new Date(now).toISOString(), tzOffsetMinutes: 0 };
    const res = await request(app).get("/api/dashboard/arrivals-by-hour").query(range).set("Authorization", `Bearer ${token}`);
    expect(res.body.summary).toEqual({ withActivity: 4, openedByCustomer: 2, startedByTeam: 1, fromEarlierDays: 1 });

    const gestao = await request(app).get("/api/conversations/oversight/page").query(range).set("Authorization", `Bearer ${token}`);
    expect(gestao.body.total).toBe(4);
    const opened = await request(app).get("/api/conversations/oversight/page").query({ ...range, openedByCustomer: "1" }).set("Authorization", `Bearer ${token}`);
    expect(opened.body.total).toBe(2);
    const atHour = await request(app)
      .get("/api/conversations/oversight/page")
      .query({ ...range, arrivalHour: twoHoursAgo.getUTCHours() })
      .set("Authorization", `Bearer ${token}`);
    expect(atHour.body.items.map((c: { id: string }) => c.id)).toEqual([early.id]);
  });
});
