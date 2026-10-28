import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("Gestão paginada (/conversations/oversight/page)", () => {
  let connectionId: string;
  let agentId: string;
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Atendimento TGS")).id;
    agentId = (await createTestUser({ email: "gislaine@test.dev", role: "AGENT", displayName: "Gislaine", whatsappConnectionId: connectionId })).id;
    await createTestUser({ email: "admin@test.dev", role: "ADMIN", displayName: "Admin" });
    token = (await request(app).post("/api/auth/login").send({ email: "admin@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** One old conversation still Em atendimento, behind `closedCount` newer closed ones. */
  async function oldOpenBehindNewer(closedCount: number) {
    const now = Date.now();
    const old = await prisma.contact.create({ data: { phone: "556599168365", name: "Jucimara", whatsappConnectionId: connectionId } });
    const open = await prisma.conversation.create({
      data: { contactId: old.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: agentId, lastMessageAt: new Date(now - 16 * 86_400_000) },
    });
    await prisma.contact.createMany({
      data: Array.from({ length: closedCount }, (_, i) => ({ phone: `55119000${String(i).padStart(5, "0")}`, name: `Cliente ${i}`, whatsappConnectionId: connectionId })),
    });
    const contacts = await prisma.contact.findMany({ where: { id: { not: old.id } }, select: { id: true } });
    await prisma.conversation.createMany({
      data: contacts.map((c, i) => ({ contactId: c.id, whatsappConnectionId: connectionId, status: "CLOSED" as const, closedAt: new Date(now - i * 1000), lastMessageAt: new Date(now - i * 1000) })),
    });
    return open;
  }

  const page = (query: Record<string, unknown>) => request(app).get("/api/conversations/oversight/page").query(query).set("Authorization", `Bearer ${token}`);

  it("a conversa antiga Em atendimento aparece no filtro, mesmo atrás de mais de 200 mais novas, e os números batem", async () => {
    const open = await oldOpenBehindNewer(210);

    const inProgress = await page({ status: "IN_PROGRESS,TRANSFERRED", page: 1, pageSize: 50 });
    expect(inProgress.status).toBe(200);
    expect(inProgress.body.items.map((c: { id: string }) => c.id)).toEqual([open.id]);
    expect(inProgress.body.total).toBe(1);
    expect(inProgress.body.statusCounts).toMatchObject({ IN_PROGRESS: 1, CLOSED: 210 });
  });

  it("pagina: total da busca, páginas na ordem da última atividade, sem repetir nem pular", async () => {
    const open = await oldOpenBehindNewer(120);
    const first = await page({ page: 1, pageSize: 50 });
    const third = await page({ page: 3, pageSize: 50 });
    expect(first.body).toMatchObject({ total: 121, page: 1, pageSize: 50 });
    expect(first.body.items).toHaveLength(50);
    expect(third.body.items).toHaveLength(21);
    expect(third.body.items.at(-1).id).toBe(open.id); // oldest activity last

    const all = new Set<string>();
    for (const p of [1, 2, 3]) for (const c of (await page({ page: p, pageSize: 50 })).body.items) all.add(c.id);
    expect(all.size).toBe(121);
  });

  it("só aceita 50, 100, 200 ou 300 linhas por página", async () => {
    expect((await page({ pageSize: 75 })).status).toBe(400);
    expect((await page({ pageSize: 300 })).status).toBe(200);
  });
});
