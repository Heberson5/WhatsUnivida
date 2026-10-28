import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { lastWeeklySlotStart, syncContactsIfDue } from "../src/lib/contacts-sync";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
const UTC_MINUS_4 = 240;

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("carga dos contatos do celular", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a carga semanal vale desde a última segunda-feira à meia-noite (horário local)", () => {
    // Wed 2026-10-07 15:00 UTC = Wed 11:00 local → Monday 2026-10-05 00:00 local = 04:00 UTC
    expect(lastWeeklySlotStart(new Date("2026-10-07T15:00:00Z"), UTC_MINUS_4).toISOString()).toBe("2026-10-05T04:00:00.000Z");
    // Monday 00:30 local (04:30 UTC) is already inside that Monday's slot
    expect(lastWeeklySlotStart(new Date("2026-10-05T04:30:00Z"), UTC_MINUS_4).toISOString()).toBe("2026-10-05T04:00:00.000Z");
    // Monday 03:30 UTC is still Sunday night locally → the slot is the Monday before
    expect(lastWeeklySlotStart(new Date("2026-10-05T03:30:00Z"), UTC_MINUS_4).toISOString()).toBe("2026-09-28T04:00:00.000Z");
    // Sunday evening local still belongs to the week that began the Monday before
    expect(lastWeeklySlotStart(new Date("2026-10-12T02:00:00Z"), UTC_MINUS_4).toISOString()).toBe("2026-10-05T04:00:00.000Z");
  });

  it("o administrador carrega os contatos e a data fica registrada; o atendente não pode", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteSync" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    const synced = await request(app).post(`/api/whatsapp/connections/${created.body.id}/sync-contacts`).set("Authorization", `Bearer ${adminToken}`);
    expect(synced.status).toBe(200);
    expect(synced.body.count).toBeGreaterThan(0);
    const row = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.contactsSyncedAt).not.toBeNull();

    await createTestUser({ email: "agente@test.dev", role: "AGENT", whatsappConnectionId: created.body.id });
    const agentToken = await loginAs("agente@test.dev");
    const denied = await request(app).post(`/api/whatsapp/connections/${created.body.id}/sync-contacts`).set("Authorization", `Bearer ${agentToken}`);
    expect(denied.status).toBe(403);

    // The weekly check leaves a connection alone when it was already loaded this week...
    const before = row.contactsSyncedAt!.getTime();
    await syncContactsIfDue(new Date());
    expect((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: created.body.id } })).contactsSyncedAt!.getTime()).toBe(before);
    // ...and loads it again once a new Monday 00:00 has passed.
    await syncContactsIfDue(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: created.body.id } })).contactsSyncedAt!.getTime()).toBeGreaterThan(before);
  }, 15000);

  it("carregar os contatos salva em Contatos quem ainda não está lá; quem já está fica com o nome da plataforma", async () => {
    await createTestUser({ email: "admin3@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin3@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteSalva" });
    const connectionId = created.body.id as string;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    // "Ana Ribeiro" (5511955554444) on the mock phone is already on the platform under another name.
    await prisma.contact.create({ data: { phone: "5511955554444", name: "Ana — cliente VIP", whatsappConnectionId: connectionId } });

    const first = await request(app).post(`/api/whatsapp/connections/${connectionId}/sync-contacts`).set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(first.body.count - 1);
    const saved = await prisma.contact.findMany({ where: { whatsappConnectionId: connectionId } });
    expect(saved).toHaveLength(first.body.count);
    expect(saved.find((c) => c.phone === "5511955554444")?.name).toBe("Ana — cliente VIP");
    expect(saved.find((c) => c.phone === "5511944443333")?.name).toBe("Bruno Alves");

    // Loading again duplicates nothing, and the Nova conversa list shows the platform's name.
    const again = await request(app).post(`/api/whatsapp/connections/${connectionId}/sync-contacts`).set("Authorization", `Bearer ${adminToken}`);
    expect(again.body.created).toBe(0);
    expect(await prisma.contact.count({ where: { whatsappConnectionId: connectionId } })).toBe(first.body.count);
    const list = await request(app).get(`/api/whatsapp/connections/${connectionId}/contacts`).set("Authorization", `Bearer ${adminToken}`);
    expect((list.body as { phone: string; name: string }[]).find((c) => c.phone === "5511955554444")?.name).toBe("Ana — cliente VIP");
  }, 15000);

  it("a lista da Nova conversa junta o celular com quem já conversou, só com números reais", async () => {
    await createTestUser({ email: "admin2@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin2@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteList" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await prisma.contact.create({ data: { phone: "5511911112222", name: "Cliente que já falou", whatsappConnectionId: created.body.id } });
    await prisma.contact.create({ data: { phone: "1234567890123456", providerChatId: "1234567890123456@lid", name: "Só id interno", whatsappConnectionId: created.body.id } });

    const res = await request(app).get(`/api/whatsapp/connections/${created.body.id}/contacts`).set("Authorization", `Bearer ${adminToken}`);
    const phones = (res.body as { phone: string }[]).map((c) => c.phone);
    expect(phones).toContain("5511911112222");
    expect(phones).not.toContain("1234567890123456");
    expect(res.body.length).toBeGreaterThan(1); // plus the (mock) phone address book
  }, 15000);
});
