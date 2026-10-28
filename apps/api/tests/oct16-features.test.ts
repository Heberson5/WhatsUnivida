import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { formatDuration } from "../src/modules/reports/reports.service";
import { resetDatabase, createTestConnection, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const loginAs = async (email: string, ip?: string) => {
  const req = request(app).post("/api/auth/login");
  if (ip) req.set("X-Forwarded-For", ip);
  return (await req.send({ email, password: TEST_PASSWORD })).body.accessToken as string;
};

describe("Auditoria, Gestão e Relatórios (16/10)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("grava o IP real que o proxy repassa e mostra o local aproximado, com cache", async () => {
    await createTestUser({ email: "admin-ip@test.dev", role: "ADMIN" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, city: "Cuiabá", region: "Mato Grosso", country: "Brazil", latitude: -15.6, longitude: -56.1 })));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).includes("ipwho.is") ? fetchMock() : realFetch(url, init)));

    const token = await loginAs("admin-ip@test.dev", "187.10.20.30");
    const first = await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${token}`);
    const login = first.body.items.find((l: { action: string }) => l.action === "LOGIN_SUCCESS");
    expect(login).toMatchObject({ ipAddress: "187.10.20.30", ipInternal: false, ipPlace: { label: "Cuiabá, Mato Grosso, Brazil", latitude: -15.6, longitude: -56.1 } });
    await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${token}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("um IP interno aparece como rede interna, sem consulta", async () => {
    await createTestUser({ email: "admin-ip2@test.dev", role: "ADMIN" });
    const token = await loginAs("admin-ip2@test.dev");
    const { items } = (await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${token}`)).body;
    expect(items.find((l: { action: string }) => l.action === "LOGIN_SUCCESS")).toMatchObject({ ipInternal: true, ipPlace: null });
  });

  it("a Gestão encontra a conversa pelo texto de uma mensagem e mostra o trecho", async () => {
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "admin-busca@test.dev", role: "ADMIN" });
    const token = await loginAs("admin-busca@test.dev");
    const { conversation } = await createWaitingConversation("5565990009001", connection.id);
    await createWaitingConversation("5565990009002", connection.id);
    await prisma.message.create({ data: { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Meu boleto do protocolo 4821 venceu" } });

    const res = await request(app).get("/api/conversations/oversight").query({ q: "protocolo 4821" }).set("Authorization", `Bearer ${token}`);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: conversation.id, searchMatch: "Meu boleto do protocolo 4821 venceu" });
  });

  it("os tempos dos relatórios saem em horas e minutos", () => {
    expect(formatDuration(204 * 60_000)).toBe("3h 24min");
    expect(formatDuration(101 * 60_000)).toBe("1h 41min");
    expect(formatDuration(45 * 60_000)).toBe("45min");
    expect(formatDuration(120 * 60_000)).toBe("2h");
    expect(formatDuration(null)).toBe("-");
  });

  it("conta por atendente as pesquisas que o cliente não respondeu (vencidas)", async () => {
    const connection = await createTestConnection("Vendas");
    const agent = await createTestUser({ email: "lucas-nr@test.dev", role: "AGENT", displayName: "Lucas", whatsappConnectionId: connection.id });
    await createTestUser({ email: "admin-nr@test.dev", role: "ADMIN" });
    const question = await prisma.satisfactionQuestion.create({ data: { text: "De 0 a 10?" } });
    const now = Date.now();
    for (const [i, score, expiresIn] of [[1, 9, 3600_000], [2, null, -60_000], [3, null, -60_000], [4, null, 3600_000]] as const) {
      const contact = await prisma.contact.create({ data: { phone: `556599000800${i}`, whatsappConnectionId: connection.id } });
      const conv = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connection.id, status: "CLOSED", assignedAgentId: agent.id } });
      await prisma.satisfactionSurvey.create({
        data: { conversationId: conv.id, contactId: contact.id, whatsappConnectionId: connection.id, agentId: agent.id, questionId: question.id, score, answeredAt: score === null ? null : new Date(), expiresAt: new Date(now + expiresIn) },
      });
    }
    const token = await loginAs("admin-nr@test.dev");
    const report = (await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${token}`)).body;
    expect(report.totals).toMatchObject({ sent: 4, answered: 1, unanswered: 2, awaiting: 1 });
    expect(report.byAgent[0]).toMatchObject({ agentName: "Lucas", unanswered: 2 });
    const perAgent = (await request(app).get("/api/reports/per-agent").set("Authorization", `Bearer ${token}`)).body;
    expect(perAgent.find((r: { Atendente: string }) => r.Atendente === "Lucas")).toMatchObject({ "Pesquisas não respondidas": 2 });
  });
});
