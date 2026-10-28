import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { getSatisfactionReport } from "../src/modules/satisfaction/satisfaction-report.service";
import { resetDatabase, createTestConnection, createTestUser, grantManagerConnectionAccess, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Relatórios › Pesquisa de satisfação", () => {
  let admin: string;
  let gestor: string;
  let suporteId: string;
  let marinaConversation: string;

  beforeAll(async () => {
    await resetDatabase();
    const suporte = await createTestConnection("Suporte");
    const vendas = await createTestConnection("Vendas");
    suporteId = suporte.id;
    await createTestUser({ email: "admin-nps@test.dev", role: "ADMIN" });
    const manager = await createTestUser({ email: "gestor-nps@test.dev", role: "MANAGER" });
    await grantManagerConnectionAccess(manager.id, suporte.id, { canManage: true });
    const lucas = await createTestUser({ email: "lucas-nps@test.dev", role: "AGENT", displayName: "Lucas", whatsappConnectionId: suporte.id });
    const bianca = await createTestUser({ email: "bianca-nps@test.dev", role: "AGENT", displayName: "Bianca", whatsappConnectionId: vendas.id });
    admin = await loginAs("admin-nps@test.dev");
    gestor = await loginAs("gestor-nps@test.dev");
    const question = await prisma.satisfactionQuestion.create({ data: { text: "De 0 a 10, quanto você recomendaria?" } });
    const legacy = { questionId: null };

    const now = Date.now();
    let n = 0;
    async function survey(connectionId: string, agentId: string, name: string, score: number | null, extra: object = {}) {
      n += 1;
      const contact = await prisma.contact.create({ data: { phone: `55659900000${String(n).padStart(2, "0")}`, name, whatsappConnectionId: connectionId } });
      const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "CLOSED", assignedAgentId: agentId } });
      await prisma.satisfactionSurvey.create({
        data: {
          conversationId: conversation.id,
          contactId: contact.id,
          whatsappConnectionId: connectionId,
          agentId,
          questionId: question.id,
          score,
          sentAt: new Date(now - (20 - n) * 60_000),
          answeredAt: score === null ? null : new Date(now - (20 - n) * 60_000 + 30_000),
          expiresAt: new Date(now + 86_400_000),
          ...extra,
        },
      });
      return conversation.id;
    }
    marinaConversation = await survey(suporte.id, lucas.id, "Marina Alves", 10);
    await survey(suporte.id, lucas.id, "Paulo Lima", 9);
    await survey(suporte.id, lucas.id, "Rita Souza", 3);
    await survey(suporte.id, lucas.id, "Sem resposta Ltda", null);
    await survey(suporte.id, lucas.id, "Expirou", null, { expiresAt: new Date(now - 1000) });
    await survey(vendas.id, bianca.id, "Carlos Dias", 8);
    await survey(vendas.id, bianca.id, "Ana Prado", 6);
    // The old 1–5 scale never mixes with NPS.
    await survey(suporte.id, lucas.id, "Antiga", 5, legacy);
  });

  afterAll(async () => prisma.$disconnect());

  it("traz os totais, a distribuição, cada atendente e cada conexão — só da escala de 0 a 10", async () => {
    const res = await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const { totals, byAgent, byConnection } = res.body;
    // 7 NPS surveys: 5 answered (10, 9, 3, 8, 6) → 2 promoters, 1 passive, 2 detractors → NPS 50 (0 a 100); average 7.2.
    expect(totals).toMatchObject({ sent: 7, answered: 5, responseRate: 71, average: 7.2, nps: 50, promoters: 2, passives: 1, detractors: 2, awaiting: 1 });
    expect(totals.distribution[10]).toBe(1);
    expect(totals.distribution[3]).toBe(1);

    const lucas = byAgent.find((a: { agentName: string }) => a.agentName === "Lucas");
    expect(lucas).toMatchObject({ sent: 5, answered: 3, nps: 67, average: 7.3, lowest: 3, highest: 10 });
    const bianca = byAgent.find((a: { agentName: string }) => a.agentName === "Bianca");
    expect(bianca).toMatchObject({ sent: 2, answered: 2, nps: 25 });
    expect(byAgent[0].agentName).toBe("Lucas"); // best NPS first
    expect(byConnection.map((c: { connectionName: string }) => c.connectionName)).toEqual(["Suporte", "Vendas"]);
  });

  it("cada resposta diz o cliente, o atendente, a nota e a conversa avaliada", async () => {
    const { responses } = (await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${admin}`)).body;
    expect(responses).toHaveLength(7);
    const marina = responses.find((r: { contactName: string }) => r.contactName === "Marina Alves");
    expect(marina).toMatchObject({ score: 10, category: "promoter", agentName: "Lucas", connectionName: "Suporte", status: "answered", conversationId: marinaConversation });
    expect(responses.find((r: { contactName: string }) => r.contactName === "Rita Souza").category).toBe("detractor");
    expect(responses.find((r: { contactName: string }) => r.contactName === "Sem resposta Ltda").status).toBe("awaiting");
    expect(responses.find((r: { contactName: string }) => r.contactName === "Expirou").status).toBe("expired");
    // The conversation it points to opens for whoever reads the report.
    expect((await request(app).get(`/api/conversations/${marinaConversation}`).set("Authorization", `Bearer ${admin}`)).status).toBe(200);
  });

  it("o gestor vê só as conexões dele; filtra por atendente; exporta respostas e atendentes", async () => {
    const forManager = (await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${gestor}`)).body;
    expect(forManager.byConnection.map((c: { connectionId: string }) => c.connectionId)).toEqual([suporteId]);

    const lucasId = (await prisma.user.findFirstOrThrow({ where: { email: "lucas-nps@test.dev" } })).id;
    const onlyLucas = (await request(app).get("/api/reports/satisfaction").query({ agentId: lucasId }).set("Authorization", `Bearer ${admin}`)).body;
    expect(onlyLucas.totals.sent).toBe(5);

    const csv = await request(app).get("/api/reports/satisfaction").query({ format: "csv" }).set("Authorization", `Bearer ${admin}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Marina Alves");
    expect(csv.text).toContain("Promotor");
    const agents = await request(app).get("/api/reports/satisfaction").query({ format: "csv", table: "agents" }).set("Authorization", `Bearer ${admin}`);
    expect(agents.text).toContain("NPS (0 a 100)");
    const xlsx = await request(app).get("/api/reports/satisfaction").query({ format: "xlsx" }).set("Authorization", `Bearer ${admin}`);
    expect(xlsx.status).toBe(200);
  });

  it("o Dashboard mostra os mesmos números do Relatório; por atendente e últimas avaliações só para gestor e administrador", async () => {
    const report = (await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${admin}`)).body;
    const overview = (await request(app).get("/api/dashboard/satisfaction-overview").set("Authorization", `Bearer ${admin}`)).body;
    expect(overview.totals).toEqual(report.totals);
    expect(overview.byAgent.map((a: { agentName: string; nps: number }) => [a.agentName, a.nps])).toEqual([
      ["Lucas", 67],
      ["Bianca", 25],
    ]);
    expect(overview.latest.promoter.map((r: { contactName: string }) => r.contactName)).toEqual(["Paulo Lima", "Marina Alves"]);
    expect(overview.latest.detractor.map((r: { contactName: string }) => r.contactName)).toEqual(["Ana Prado", "Rita Souza"]);
    expect(overview.latest.passive).toHaveLength(1);

    const lucas = await loginAs("lucas-nps@test.dev");
    const forAgent = await request(app).get("/api/dashboard/satisfaction-overview").set("Authorization", `Bearer ${lucas}`);
    if (forAgent.status === 200) {
      expect(forAgent.body.byAgent).toBeNull();
      expect(forAgent.body.latest).toBeNull();
    } else {
      expect(forAgent.status).toBe(403); // without Dashboard access at all
    }
  });

  it("compara com o período anterior, de mesmo tamanho, no total e por atendente", async () => {
    const now = Date.now();
    const lucasId = (await prisma.user.findFirstOrThrow({ where: { email: "lucas-nps@test.dev" } })).id;
    const question = await prisma.satisfactionQuestion.findFirstOrThrow();
    // Two answers in the hour before the last hour: 10 and 0 → NPS 50.
    for (const [i, score] of [10, 0].entries()) {
      const contact = await prisma.contact.create({ data: { phone: `5565990009${i}`, name: `Antes ${i}`, whatsappConnectionId: suporteId } });
      const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: suporteId, status: "CLOSED", assignedAgentId: lucasId } });
      const at = new Date(now - 90 * 60_000);
      await prisma.satisfactionSurvey.create({
        data: { conversationId: conversation.id, contactId: contact.id, whatsappConnectionId: suporteId, agentId: lucasId, questionId: question.id, score, sentAt: at, answeredAt: at, expiresAt: new Date(now + 86_400_000) },
      });
    }
    const report = await getSatisfactionReport({ from: new Date(now - 60 * 60_000), to: new Date(now) });
    expect(report.previous).toMatchObject({ nps: 50, answered: 2 });
    expect(report.byAgent.find((a) => a.agentName === "Lucas")?.previousNps).toBe(50);
    expect(report.byAgent.find((a) => a.agentName === "Bianca")?.previousNps).toBeNull();
  });

  it("guarda a meta de NPS e como o cliente aparece na apresentação; o atendente não altera", async () => {
    expect((await request(app).get("/api/satisfaction-survey/settings").set("Authorization", `Bearer ${admin}`)).body).toEqual({ npsGoal: null, presentationCustomer: "full" });
    const saved = await request(app).put("/api/satisfaction-survey/settings").set("Authorization", `Bearer ${gestor}`).send({ npsGoal: 80, presentationCustomer: "initials" });
    expect(saved.status).toBe(200);
    expect((await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${admin}`)).body.settings).toEqual({ npsGoal: 80, presentationCustomer: "initials" });
    expect((await request(app).put("/api/satisfaction-survey/settings").set("Authorization", `Bearer ${admin}`).send({ npsGoal: 120, presentationCustomer: "full" })).status).toBe(400);
    const lucas = await loginAs("lucas-nps@test.dev");
    expect((await request(app).put("/api/satisfaction-survey/settings").set("Authorization", `Bearer ${lucas}`).send({ npsGoal: 10, presentationCustomer: "full" })).status).toBe(403);
  });
});
