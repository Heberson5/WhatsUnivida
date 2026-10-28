import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
const loginAs = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;

describe("Relatórios › Pesquisa: rever e corrigir a nota", () => {
  let surveyId: string;
  let admin: string;
  let adminId: string;

  beforeEach(async () => {
    await resetDatabase();
    const connection = await createTestConnection("Suporte");
    adminId = (await createTestUser({ email: "admin-cor@test.dev", role: "ADMIN", displayName: "Carla" })).id;
    await createTestUser({ email: "gestor-cor@test.dev", role: "MANAGER" });
    const agent = await createTestUser({ email: "lucas-cor@test.dev", role: "AGENT", displayName: "Lucas", whatsappConnectionId: connection.id });
    const question = await prisma.satisfactionQuestion.create({ data: { text: "De 0 a 10?" } });
    const contact = await prisma.contact.create({ data: { phone: "5565990000001", name: "Joana", whatsappConnectionId: connection.id } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connection.id, status: "CLOSED", assignedAgentId: agent.id } });
    // Read as 1 by the old rules: the customer meant 10.
    surveyId = (
      await prisma.satisfactionSurvey.create({
        data: { conversationId: conversation.id, contactId: contact.id, whatsappConnectionId: connection.id, agentId: agent.id, questionId: question.id, score: 1, answerText: "1o", answeredAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
      })
    ).id;
    admin = await loginAs("admin-cor@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("mostra o texto, aponta a leitura para revisar e deixa corrigir, com Auditoria", async () => {
    const before = (await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${admin}`)).body.responses[0];
    expect(before).toMatchObject({ score: 1, answerText: "1o", rereadScore: 10, correction: null });

    const fix = await request(app).patch(`/api/reports/satisfaction/${surveyId}/score`).set("Authorization", `Bearer ${admin}`).send({ score: 10 });
    expect(fix.status).toBe(204);
    const after = (await request(app).get("/api/reports/satisfaction").set("Authorization", `Bearer ${admin}`)).body;
    expect(after.responses[0]).toMatchObject({ score: 10, rereadScore: null, correction: { originalScore: 1, byName: "Carla" } });
    expect(after.totals.nps).toBe(100);
    expect(await prisma.auditLog.count({ where: { action: "SATISFACTION_SCORE_CORRECTED", userId: adminId } })).toBe(1);
  });

  it("o gestor só corrige com a permissão própria", async () => {
    const gestor = await loginAs("gestor-cor@test.dev");
    expect((await request(app).patch(`/api/reports/satisfaction/${surveyId}/score`).set("Authorization", `Bearer ${gestor}`).send({ score: 10 })).status).toBe(403);
  });
});
