import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import { createSurvey, processDueClosingMessages } from "../src/modules/satisfaction/satisfaction.service";
import { CONVERSATION_UNDO_WINDOW_MS, DEFAULT_SURVEY_REASON } from "@whatsatendende/types";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const QUESTION = "De 0 a 10, o quanto você recomendaria o atendimento?";
const REASON_QUESTION = "Sentimos muito, {{primeiro_nome}}. O que mais influenciou sua nota?";
const REASON_THANKS = "Obrigado pelo retorno, {{primeiro_nome}}.";

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("pesquisa: pergunta do motivo de notas baixas", () => {
  let connectionId: string;
  let anaToken: string;
  let adminId: string;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await resetDatabase();
    adminId = (await createTestUser({ email: "admin-reason@test.dev", role: "ADMIN" })).id;
    const adminToken = await loginAs("admin-reason@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteMotivo" });
    connectionId = created.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    const ana = await createTestUser({ email: "ana-reason@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    anaToken = await loginAs("ana-reason@test.dev");
    await createClosingMessage({ name: "Padrão", text: "Até logo!", active: true, userIds: [ana.id], connectionScope: { allConnections: true, connectionIds: [] } });
    await prisma.satisfactionSurveyConfig.deleteMany();
    await createSurvey({
      name: "Pesquisa",
      active: true,
      connectionScope: { allConnections: false, connectionIds: [connectionId] },
      question: QUESTION,
      thanks: "Obrigado!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
      reasonEnabled: true,
      reasonMinScore: 0,
      reasonMaxScore: 6,
      reasonQuestion: REASON_QUESTION,
      reasonThanks: REASON_THANKS,
    });
  }, 20000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const textsTo = (phone: string) => provider.sentTexts.filter((m) => m.chatId.startsWith(`${phone}@`)).map((m) => m.text);
  const surveyOf = (conversationId: string) => prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId } });

  /** Accepted, closed and past the "Desfazer" window: the question is out. */
  async function closedAndAsked(phone: string) {
    const { conversation } = await createWaitingConversation(phone, connectionId);
    await prisma.contact.update({ where: { id: conversation.contactId }, data: { name: "Joana Cliente" } });
    expect((await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${anaToken}`)).status).toBe(200);
    const base = textsTo(phone).length;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    expect((await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await waitUntil(() => textsTo(phone).length >= base + 1);
    return { conversation, sentSince: () => textsTo(phone).slice(base) };
  }

  it("nota 3: pergunta o motivo, guarda a resposta em várias mensagens, agradece, avisa os gestores e só então encerra", async () => {
    const phone = "5511990008001";
    const { conversation, sentSince } = await closedAndAsked(phone);

    provider.simulateIncomingMessage(phone, "3");
    await waitUntil(() => sentSince().length >= 2);
    expect(sentSince()).toEqual([QUESTION, "Sentimos muito, Joana. O que mais influenciou sua nota?"]);
    // The closing message waits for the reason, not 10 seconds.
    expect(await processDueClosingMessages(new Date(Date.now() + 11_000))).toBe(0);

    provider.simulateIncomingMessage(phone, "O atendente demorou para responder");
    await waitUntil(() => sentSince().length >= 3);
    expect(sentSince()[2]).toBe("Obrigado pelo retorno, Joana.");
    provider.simulateIncomingMessage(phone, "e não resolveu meu problema");
    await waitUntil(async () => (await surveyOf(conversation.id)).reasonText?.includes("resolveu") ?? false);

    const survey = await surveyOf(conversation.id);
    expect(survey).toMatchObject({ score: 3, reasonText: "O atendente demorou para responder\ne não resolveu meu problema" });
    expect(await prisma.conversation.count({ where: { contactId: conversation.contactId } })).toBe(1); // nothing opened in the queue
    const notice = await prisma.notification.findFirstOrThrow({ where: { userId: adminId, type: "SURVEY_LOW_SCORE" } });
    expect(notice.title).toBe("Nota 3 na pesquisa: Joana Cliente");
    // The second message may already have joined the reason when the notice is written.
    expect(notice.body).toMatch(/^Motivo: O atendente demorou para responder( e não resolveu meu problema)? · Atendente: Ana$/);
    // The agent of the conversation is not told.
    expect(await prisma.notification.count({ where: { type: "SURVEY_LOW_SCORE", user: { email: "ana-reason@test.dev" } } })).toBe(0);

    expect(await processDueClosingMessages(new Date(Date.now() + 30_000))).toBe(1);
    expect(sentSince().at(-1)).toContain("Até logo!");
    // Sent in Ana's name, but marked automatic: the Dashboard doesn't count it as a message she wrote.
    const closing = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, body: { contains: "Até logo!" } } });
    expect(closing.senderAgentId).not.toBeNull();
    expect(closing.automatedBy).toBe("CLOSING");

    const report = await request(app)
      .get("/api/reports/satisfaction")
      .query({ period: "today", tzOffsetMinutes: new Date().getTimezoneOffset() })
      .set("Authorization", `Bearer ${await loginAs("admin-reason@test.dev")}`);
    expect(report.status).toBe(200);
    expect(report.body.responses.find((r: { conversationId: string }) => r.conversationId === conversation.id).reasonText).toContain("demorou");
  }, 20000);

  it("nota 9 fora da faixa: agradece na hora, sem perguntar o motivo", async () => {
    const phone = "5511990008002";
    const { conversation, sentSince } = await closedAndAsked(phone);
    provider.simulateIncomingMessage(phone, "9");
    await waitUntil(() => sentSince().length >= 2);
    expect(sentSince()).toEqual([QUESTION, "Obrigado!"]);
    expect((await surveyOf(conversation.id)).reasonAskedAt).toBeNull();
  }, 20000);

  it("o cliente não conta o motivo: na hora da espera sai o agradecimento normal e a mensagem de encerramento", async () => {
    const phone = "5511990008003";
    const { conversation, sentSince } = await closedAndAsked(phone);
    provider.simulateIncomingMessage(phone, "0");
    await waitUntil(() => sentSince().length >= 2);

    await processDueClosingMessages(new Date(Date.now() + 31 * 60_000));
    await waitUntil(() => sentSince().length >= 4);
    expect(sentSince()).toEqual(expect.arrayContaining(["Obrigado!", expect.stringContaining("Até logo!")]));
    const survey = await surveyOf(conversation.id);
    expect(survey.reasonText).toBeNull();
    expect(survey.reasonTimedOutAt).not.toBeNull();
  }, 20000);

  it("uma pesquisa nova já vem com a pergunta do motivo ligada para 0 a 6", () => {
    expect(DEFAULT_SURVEY_REASON).toMatchObject({ reasonEnabled: true, reasonMinScore: 0, reasonMaxScore: 6 });
  });
});
