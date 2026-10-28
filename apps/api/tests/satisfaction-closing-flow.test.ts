import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import { createSurvey, processDueClosingMessages } from "../src/modules/satisfaction/satisfaction.service";
import { CONVERSATION_UNDO_WINDOW_MS } from "@whatsatendende/types";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const QUESTION = "De 0 a 10, o quanto você recomendaria o atendimento?";
const CLOSING_TEXT = "Obrigado, *{{cliente}}*! Foi um prazer atender você.";

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** The one survey switched on in these tests — it replaces whatever an earlier test left. */
async function enableSurvey(connectionIds: string[]) {
  await prisma.satisfactionSurveyConfig.deleteMany();
  return createSurvey({
    name: "Pesquisa",
    active: true,
    connectionScope: { allConnections: false, connectionIds },
    question: QUESTION,
    thanks: "Obrigado!",
    answerWindowHours: 24,
    closingWaitMinutes: 30,
  });
}

describe("encerrar com a mensagem de encerramento e a pesquisa de satisfação ligadas", () => {
  let connectionId: string;
  let anaToken: string;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-survey-flow@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-survey-flow@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteSurveyFlow" });
    connectionId = created.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;

    const ana = await createTestUser({ email: "ana-survey-flow@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    anaToken = await loginAs("ana-survey-flow@test.dev");
    await createClosingMessage({ name: "Padrão", text: CLOSING_TEXT, active: true, userIds: [ana.id], connectionScope: { allConnections: true, connectionIds: [] } });
  }, 20000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function acceptedConversation(phone: string) {
    const { conversation } = await createWaitingConversation(phone, connectionId);
    await prisma.contact.update({ where: { id: conversation.contactId }, data: { name: "Joana Cliente" } });
    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${anaToken}`);
    expect(res.status).toBe(200);
    return conversation;
  }

  /** The texts that went to this customer since `base` (what was already there when the test started). */
  const textsTo = (phone: string) => provider.sentTexts.filter((m) => m.chatId.startsWith(`${phone}@`)).map((m) => m.text);

  /** Accepts, closes through the API and lets the "Desfazer" window pass: the question is out and the closing message waits. */
  async function closedAndAsked(phone: string) {
    await enableSurvey([connectionId]);
    const conversation = await acceptedConversation(phone);
    // Accepting may already have sent an Aceite auto-message (those templates outlive resetDatabase) — count from here.
    const base = textsTo(phone).length;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`);
    expect(closeRes.status).toBe(200);
    // Closed, but nothing has gone to the customer yet — the "Desfazer" window is still open.
    expect(textsTo(phone).length).toBe(base);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await waitUntil(() => textsTo(phone).length >= base + 1);
    await new Promise((resolve) => setTimeout(resolve, 300)); // give a closing message that should not be there time to show up
    return { conversation, sentSince: () => textsTo(phone).slice(base) };
  }

  const surveyOf = (conversationId: string) => prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId }, include: { question: true } });
  const conversationsOf = (contactId: string) => prisma.conversation.count({ where: { contactId } });

  async function waitUntilAsync(condition: () => Promise<boolean>, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (!(await condition()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  it("depois dos 10 segundos só a pergunta sai; a mensagem de encerramento espera a nota e sai 10 segundos depois dela", async () => {
    const phone = "5511990007001";
    const { conversation, sentSince } = await closedAndAsked(phone);

    expect(sentSince()).toEqual([QUESTION]);
    const survey = await surveyOf(conversation.id);
    expect(survey.question?.text).toBe(QUESTION);
    expect(survey.closingText).toContain("Obrigado, *Joana Cliente*! Foi um prazer atender você."); // kept, already rendered
    expect(survey.agentId).not.toBeNull();

    // The customer answers.
    provider.simulateIncomingMessage(phone, "10");
    await waitUntil(() => sentSince().length >= 2);
    expect(sentSince()).toEqual([QUESTION, "Obrigado!"]);
    expect(await conversationsOf(conversation.contactId)).toBe(1); // the score did not open a conversation
    expect((await surveyOf(conversation.id)).score).toBe(10);

    // Ten seconds after the score, the sweep sends the closing message — without the agent's name on top.
    expect(await processDueClosingMessages(new Date(Date.now() + 11_000))).toBe(1);
    const texts = sentSince();
    expect(texts).toHaveLength(3);
    expect(texts[2]).not.toContain("*Ana:*");
    expect(texts[2]).toContain("Obrigado, *Joana Cliente*! Foi um prazer atender você.");
  }, 20000);

  /** The read receipts that went to this customer's chat — what makes the phone show it as read. */
  const readsOf = (phone: string) => provider.readReceiptsSent.filter((r) => r.chatId.startsWith(`${phone}@`)).flatMap((r) => r.providerMessageIds);
  const inboundIdsOf = async (conversationId: string) =>
    (await prisma.message.findMany({ where: { conversationId, direction: "INBOUND" }, orderBy: { createdAt: "asc" } })).map((m) => m.providerMessageId);

  it("a nota e o obrigado depois da mensagem de encerramento ficam lidos no celular e nada volta para a fila", async () => {
    const phone = "5511990007008";
    const { conversation, sentSince } = await closedAndAsked(phone);

    provider.simulateIncomingMessage(phone, "9");
    await waitUntil(() => sentSince().length >= 2);
    expect(await processDueClosingMessages(new Date(Date.now() + 11_000))).toBe(1);

    provider.simulateIncomingMessage(phone, "Muito obrigada 🙏");
    await waitUntilAsync(async () => (await inboundIdsOf(conversation.id)).length === 2);
    await waitUntil(() => readsOf(phone).length >= 2);

    expect(await conversationsOf(conversation.contactId)).toBe(1);
    expect(readsOf(phone).sort()).toEqual((await inboundIdsOf(conversation.id)).sort());
  }, 20000);

  it("sem pesquisa: um obrigado depois do encerramento fica na conversa encerrada; uma pergunta abre na fila", async () => {
    await prisma.satisfactionSurveyConfig.deleteMany();
    const phone = "5511990007009";
    const conversation = await acceptedConversation(phone);
    const base = textsTo(phone).length;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    expect((await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await waitUntil(() => textsTo(phone).length > base); // the closing message

    provider.simulateIncomingMessage(phone, "valeu!");
    await waitUntilAsync(async () => (await inboundIdsOf(conversation.id)).length === 1);
    await waitUntil(() => readsOf(phone).length >= 1);
    expect(await conversationsOf(conversation.contactId)).toBe(1);

    provider.simulateIncomingMessage(phone, "Tenho mais uma dúvida sobre o plano");
    await waitUntilAsync(async () => (await conversationsOf(conversation.contactId)) === 2);
    const queued = await prisma.conversation.findFirstOrThrow({ where: { contactId: conversation.contactId, id: { not: conversation.id } } });
    expect(queued.status).toBe("NEW");
  }, 20000);

  it("o cliente não responde: a mensagem de encerramento sai quando a espera de 30 minutos acaba", async () => {
    const { conversation, sentSince } = await closedAndAsked("5511990007004");
    const survey = await surveyOf(conversation.id);
    expect(survey.closingDueAt!.getTime() - survey.sentAt.getTime()).toBe(30 * 60_000);

    expect(await processDueClosingMessages(new Date(Date.now() + 29 * 60_000))).toBe(0);
    expect(sentSince()).toEqual([QUESTION]);

    expect(await processDueClosingMessages(new Date(Date.now() + 31 * 60_000))).toBe(1);
    const texts = sentSince();
    expect(texts).toHaveLength(2);
    expect(texts[1]).not.toContain("*Ana:*");
    expect(texts[1]).toContain("Obrigado, *Joana Cliente*");
  }, 20000);

  it("o cliente agradece em vez de dar a nota: nada abre na fila e a mensagem de encerramento sai no prazo de sempre", async () => {
    const phone = "5511990007005";
    const { conversation, sentSince } = await closedAndAsked(phone);
    const before = await surveyOf(conversation.id);

    provider.simulateIncomingMessage(phone, "Obrigado!");
    await waitUntilAsync(async () => (await prisma.message.count({ where: { conversationId: conversation.id, direction: "INBOUND", body: "Obrigado!" } })) > 0);
    expect(await conversationsOf(conversation.contactId)).toBe(1);
    expect(sentSince()).toEqual([QUESTION]);
    expect((await surveyOf(conversation.id)).closingDueAt).toEqual(before.closingDueAt);

    expect(await processDueClosingMessages(new Date(Date.now() + 31 * 60_000))).toBe(1);
    expect(sentSince()).toHaveLength(2);
    expect(sentSince()[1]).toContain("Obrigado, *Joana Cliente*");
  }, 20000);

  it("o cliente quer continuar a conversa: volta para a fila e a mensagem de encerramento nunca é enviada", async () => {
    const phone = "5511990007006";
    const { conversation, sentSince } = await closedAndAsked(phone);

    provider.simulateIncomingMessage(phone, "Na verdade preciso de ajuda com o boleto");
    await waitUntilAsync(async () => (await conversationsOf(conversation.contactId)) === 2);
    const queued = await prisma.conversation.findFirstOrThrow({ where: { contactId: conversation.contactId, id: { not: conversation.id } } });
    expect(queued.status).toBe("NEW");
    expect(queued.assignedAgentId).toBeNull();
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("CLOSED");
    expect((await surveyOf(conversation.id)).closingOutcome).toBe("CANCELED_CUSTOMER_WROTE");

    expect(await processDueClosingMessages(new Date(Date.now() + 31 * 60_000))).toBe(0);
    expect(sentSince().some((text) => text.includes("Foi um prazer atender você"))).toBe(false);
  }, 20000);

  it("uma figura com a legenda 10 não é a nota: é o cliente querendo conversar", async () => {
    const phone = "5511990007007";
    const { conversation, sentSince } = await closedAndAsked(phone);

    (provider as unknown as { emitter: { emit: (event: string, payload: unknown) => void } }).emitter.emit("message", {
      providerMessageId: "wamid-figura-10",
      chatId: `${phone}@s.whatsapp.net`,
      phone,
      contactName: null,
      type: "IMAGE",
      body: "10",
      replyToProviderMessageId: null,
      timestamp: new Date(),
      fromMe: false,
    });
    await waitUntilAsync(async () => (await conversationsOf(conversation.contactId)) === 2);
    expect(await conversationsOf(conversation.contactId)).toBe(2);
    expect((await surveyOf(conversation.id)).score).toBeNull();
    expect(sentSince()).toEqual([QUESTION]);
  }, 20000);

  it("se o atendente desfaz o encerramento, nem a mensagem nem a pesquisa são enviadas", async () => {
    await enableSurvey([connectionId]);
    const conversation = await acceptedConversation("5511990007002");
    const before = provider.sentTexts.length;

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`);
    expect(closeRes.status).toBe(200);
    const undoRes = await request(app).post(`/api/conversations/${conversation.id}/undo`).set("Authorization", `Bearer ${anaToken}`);
    expect(undoRes.status).toBe(200);

    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 500)); // give a wrongly-fired follow-up time to show up

    expect(provider.sentTexts.length).toBe(before);
    expect(await prisma.satisfactionSurvey.count({ where: { conversationId: conversation.id } })).toBe(0);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("IN_PROGRESS");
  }, 20000);

  it("com a pesquisa ligada só para outra conexão, a mensagem de encerramento sai na hora, como antes", async () => {
    const other = await prisma.whatsAppConnection.create({ data: { name: "Vendas", status: "CONNECTED" } });
    await enableSurvey([other.id]);
    const conversation = await acceptedConversation("5511990007003");
    const before = provider.sentTexts.length;

    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`);
    expect(closeRes.status).toBe(200);

    expect(provider.sentTexts.length).toBe(before + 1);
    expect(provider.sentTexts.at(-1)?.text).toContain("Obrigado, *Joana Cliente*");
  }, 20000);
});
