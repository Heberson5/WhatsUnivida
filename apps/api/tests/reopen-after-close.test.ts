import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import { createSurvey, processDueClosingMessages } from "../src/modules/satisfaction/satisfaction.service";
import { processDueAutoMessages, setAutoMessageDelayForTests } from "../src/lib/auto-messages";
import { CONVERSATION_UNDO_WINDOW_MS } from "@whatsatendende/types";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

// See PROMPT: "quando um atendente encerra a conversa, mas a mensagem de encerramento demora alguns segundos, durante
// este tempo o cliente envia uma mensagem, a conversa não deve ser encerrada, deve voltar para o mesmo atendente e não
// envia a mensagem de encerramento e mesmo que já tenha enviado, deve voltar para o mesmo atendente".

const app = createApp();
const QUESTION = "De 0 a 10, o quanto você recomendaria o atendimento?";
const CLOSING = "Foi um prazer atender você";
const REOPEN_NOTE = "Cliente respondeu após o encerramento — conversa reaberta";

async function loginAs(email: string) {
  return (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("cliente responde logo após o encerramento", () => {
  let connectionId: string;
  let adminToken: string;
  let anaToken: string;
  let anaId: string;
  let gestoraToken: string;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-reopen@test.dev", role: "ADMIN" });
    adminToken = await loginAs("admin-reopen@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteReopen" });
    connectionId = created.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;

    const ana = await createTestUser({ email: "ana-reopen@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    anaId = ana.id;
    anaToken = await loginAs("ana-reopen@test.dev");
    await createTestUser({ email: "gestora-reopen@test.dev", role: "MANAGER", displayName: "Gestora" });
    gestoraToken = await loginAs("gestora-reopen@test.dev");
    await createClosingMessage({ name: "Padrão", text: `${CLOSING}, {{cliente}}!`, active: true, userIds: [ana.id], connectionScope: { allConnections: true, connectionIds: [] } });
    // As in production: an automatic message waits a few seconds before it goes out (tests otherwise send at once).
    setAutoMessageDelayForTests([3_000, 3_000]);
  }, 20000);

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.satisfactionSurveyConfig.deleteMany();
    await prisma.user.update({ where: { id: anaId }, data: { presence: "ONLINE", status: "ACTIVE" } });
    await prisma.systemSetting.deleteMany({ where: { key: "business" } });
  });

  afterAll(async () => {
    setAutoMessageDelayForTests([0, 0]);
    await prisma.$disconnect();
  });

  const textsTo = (phone: string) => provider.sentTexts.filter((m) => m.chatId.startsWith(`${phone}@`)).map((m) => m.text);
  const reload = (id: string) => prisma.conversation.findUniqueOrThrow({ where: { id } });
  const conversationsOf = (contactId: string) => prisma.conversation.count({ where: { contactId } });
  const notesOf = async (conversationId: string) => (await prisma.conversationNote.findMany({ where: { conversationId } })).map((n) => n.body);

  async function accepted(phone: string) {
    const { conversation } = await createWaitingConversation(phone, connectionId);
    await prisma.contact.update({ where: { id: conversation.contactId }, data: { name: "Joana Cliente" } });
    expect((await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${anaToken}`)).status).toBe(200);
    return conversation;
  }

  const enableSurvey = () =>
    createSurvey({ name: "Pesquisa", active: true, connectionScope: { allConnections: false, connectionIds: [connectionId] }, question: QUESTION, thanks: "Obrigado!", answerWindowHours: 24, closingWaitMinutes: 30 });

  /** Closes through the API with the "Desfazer" window still running (timers held). */
  async function closeHoldingTimers(conversationId: string, token = anaToken, path = "close") {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const res = await request(app).post(`/api/conversations/${conversationId}/${path}`).set("Authorization", `Bearer ${token}`).send(path === "gestao-close" ? { sendClosingMessage: true } : {});
    expect(res.status).toBe(200);
  }

  /** Closes and lets everything go out: the "Desfazer" window, then the automatic messages that were waiting. */
  async function closeAndSend(conversationId: string, phone: string, expectedTexts: number) {
    const base = textsTo(phone).length;
    await closeHoldingTimers(conversationId);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await waitFor(async () => {
      await processDueAutoMessages(new Date(Date.now() + 15_000));
      return textsTo(phone).length >= base + expectedTexts;
    });
    return textsTo(phone).slice(base);
  }

  it("durante os segundos antes da mensagem de encerramento: a conversa volta para o mesmo atendente e nada é enviado", async () => {
    const phone = "5511990008001";
    const conversation = await accepted(phone);
    const base = textsTo(phone).length;
    await closeHoldingTimers(conversation.id);
    expect((await reload(conversation.id)).status).toBe("CLOSED");

    provider.simulateIncomingMessage(phone, "Esqueci de perguntar uma coisa");
    await vi.waitFor(async () => expect((await reload(conversation.id)).status).toBe("IN_PROGRESS"), { timeout: 5000 });

    const reopened = await reload(conversation.id);
    expect(reopened.assignedAgentId).toBe(anaId);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedByUserId).toBeNull();
    expect(await conversationsOf(conversation.contactId)).toBe(1); // the same conversation — nothing new in the queue
    expect(await notesOf(conversation.id)).toContain(REOPEN_NOTE);
    expect(await prisma.conversationEvent.count({ where: { conversationId: conversation.id, type: "REOPENED" } })).toBe(1);
    // The customer's message is on that conversation, unread for the attendant.
    expect(await prisma.message.count({ where: { conversationId: conversation.id, direction: "INBOUND", body: "Esqueci de perguntar uma coisa" } })).toBe(1);
    expect(reopened.assignedAgentReadAt).toBeNull();

    // The window ends and the sweeps run: no closing message, no survey.
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await processDueAutoMessages(new Date(Date.now() + 15_000));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(textsTo(phone).slice(base)).toEqual([]);

    // The attendant can answer right away, as in any conversation of theirs.
    const reply = await request(app).post(`/api/messages/conversations/${conversation.id}/text`).set("Authorization", `Bearer ${anaToken}`).send({ body: "Pode perguntar!" });
    expect(reply.status).toBe(201);
  }, 20000);

  it("mesmo com a mensagem de encerramento já enviada: volta para o mesmo atendente; ao encerrar de novo, ela sai outra vez", async () => {
    const phone = "5511990008002";
    const conversation = await accepted(phone);
    const sent = await closeAndSend(conversation.id, phone, 1);
    expect(sent.some((t) => t.includes(CLOSING))).toBe(true);

    provider.simulateIncomingMessage(phone, "Só mais uma dúvida");
    await waitFor(async () => (await reload(conversation.id)).status === "IN_PROGRESS");
    expect((await reload(conversation.id)).assignedAgentId).toBe(anaId);
    expect(await conversationsOf(conversation.contactId)).toBe(1);

    const again = await closeAndSend(conversation.id, phone, 1);
    expect(again.filter((t) => t.includes(CLOSING))).toHaveLength(1);
    expect((await reload(conversation.id)).status).toBe("CLOSED");
  }, 30000);

  it("um obrigado não reabre: a conversa fica encerrada e a mensagem de encerramento sai normalmente", async () => {
    const phone = "5511990008003";
    const conversation = await accepted(phone);
    const base = textsTo(phone).length;
    await closeHoldingTimers(conversation.id);

    provider.simulateIncomingMessage(phone, "Obrigada!");
    await vi.waitFor(async () => expect(await prisma.message.count({ where: { conversationId: conversation.id, direction: "INBOUND" } })).toBe(1), { timeout: 5000 });
    expect((await reload(conversation.id)).status).toBe("CLOSED");

    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await waitFor(async () => {
      await processDueAutoMessages(new Date(Date.now() + 15_000));
      return textsTo(phone).length > base;
    });
    expect(textsTo(phone).slice(base).some((t) => t.includes(CLOSING))).toBe(true);
    expect((await reload(conversation.id)).status).toBe("CLOSED");
    expect(await conversationsOf(conversation.contactId)).toBe(1);
  }, 20000);

  it("com a pesquisa: a nota continua valendo como nota; um texto que não é nota reabre e cancela a pesquisa", async () => {
    await enableSurvey();
    const scored = await accepted("5511990008004");
    expect(await closeAndSend(scored.id, "5511990008004", 1)).toEqual([QUESTION]);
    provider.simulateIncomingMessage("5511990008004", "9");
    await waitFor(async () => (await prisma.satisfactionSurvey.findUnique({ where: { conversationId: scored.id } }))?.score === 9);
    expect((await reload(scored.id)).status).toBe("CLOSED");

    const talked = await accepted("5511990008005");
    expect(await closeAndSend(talked.id, "5511990008005", 1)).toEqual([QUESTION]);
    provider.simulateIncomingMessage("5511990008005", "Não recebi o comprovante");
    await waitFor(async () => (await reload(talked.id)).status === "IN_PROGRESS");
    expect((await reload(talked.id)).assignedAgentId).toBe(anaId);
    expect(await prisma.satisfactionSurvey.findUnique({ where: { conversationId: talked.id } })).toBeNull(); // never counts in the NPS
    await processDueClosingMessages(new Date(Date.now() + 31 * 60_000));
    expect(textsTo("5511990008005").some((t) => t.includes(CLOSING))).toBe(false);

    // Closed again later: the customer is asked again, as on any close.
    expect(await closeAndSend(talked.id, "5511990008005", 1)).toEqual([QUESTION]);
  }, 30000);

  it("pesquisa já respondida e o cliente volta a escrever: reabre; no novo encerramento vai só a mensagem, sem perguntar de novo", async () => {
    await enableSurvey();
    const phone = "5511990008006";
    const conversation = await accepted(phone);
    await closeAndSend(conversation.id, phone, 1);
    provider.simulateIncomingMessage(phone, "10");
    await waitFor(async () => (await prisma.satisfactionSurvey.findUnique({ where: { conversationId: conversation.id } }))?.score === 10);

    provider.simulateIncomingMessage(phone, "Ah, e o boleto do mês que vem?");
    await waitFor(async () => (await reload(conversation.id)).status === "IN_PROGRESS");
    expect((await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } })).score).toBe(10); // the answer stays

    // Whatever was still waiting from the first close (the survey's thanks) has gone out before the second one.
    await processDueAutoMessages(new Date(Date.now() + 15_000));
    await processDueClosingMessages(new Date(Date.now() + 31 * 60_000));
    const again = await closeAndSend(conversation.id, phone, 1);
    expect(again.filter((t) => t === QUESTION)).toHaveLength(0);
    expect(again.filter((t) => t.includes(CLOSING))).toHaveLength(1);
    expect(again).toHaveLength(1);
    expect(await prisma.satisfactionSurvey.count({ where: { conversationId: conversation.id } })).toBe(1);
  }, 30000);

  it("atendente em pausa recebe a conversa de volta; offline, o cliente vai direto para a fila com a nota", async () => {
    const paused = await accepted("5511990008007");
    await closeAndSend(paused.id, "5511990008007", 1);
    await prisma.user.update({ where: { id: anaId }, data: { presence: "AWAY" } });
    provider.simulateIncomingMessage("5511990008007", "Voltei, tenho uma pergunta");
    await waitFor(async () => (await reload(paused.id)).status === "IN_PROGRESS");
    expect((await reload(paused.id)).assignedAgentId).toBe(anaId);

    await prisma.user.update({ where: { id: anaId }, data: { presence: "ONLINE" } });
    const offline = await accepted("5511990008008");
    await closeAndSend(offline.id, "5511990008008", 1);
    await prisma.user.update({ where: { id: anaId }, data: { presence: "OFFLINE" } });
    provider.simulateIncomingMessage("5511990008008", "Tem alguém aí?");
    await waitFor(async () => (await conversationsOf(offline.contactId)) === 2);
    expect((await reload(offline.id)).status).toBe("CLOSED");
    const queued = await prisma.conversation.findFirstOrThrow({ where: { contactId: offline.contactId, id: { not: offline.id } } });
    expect(queued.status).toBe("NEW");
    expect(queued.assignedAgentId).toBeNull();
    expect((await notesOf(queued.id)).some((n) => n.includes("Ana não estava online"))).toBe(true);
  }, 30000);

  it("encerrada pela Gestão: volta para o atendente que estava com a conversa", async () => {
    const phone = "5511990008009";
    const conversation = await accepted(phone);
    await closeHoldingTimers(conversation.id, adminToken, "gestao-close");
    expect((await reload(conversation.id)).status).toBe("CLOSED");

    provider.simulateIncomingMessage(phone, "Ainda preciso de ajuda");
    await vi.waitFor(async () => expect((await reload(conversation.id)).status).toBe("IN_PROGRESS"), { timeout: 5000 });
    expect((await reload(conversation.id)).assignedAgentId).toBe(anaId);
    expect(await conversationsOf(conversation.contactId)).toBe(1);
  }, 20000);

  it("passado o tempo configurado, vale a regra de sempre: conversa nova na fila", async () => {
    const phone = "5511990008010";
    const conversation = await accepted(phone);
    await closeAndSend(conversation.id, phone, 1);
    // Six minutes ago, with the default of five.
    const past = new Date(Date.now() - 6 * 60_000);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { closedAt: past } });
    await prisma.message.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: past } });

    provider.simulateIncomingMessage(phone, "Bom dia, preciso de um exame");
    await waitFor(async () => (await conversationsOf(conversation.contactId)) === 2);
    expect((await reload(conversation.id)).status).toBe("CLOSED");
    const queued = await prisma.conversation.findFirstOrThrow({ where: { contactId: conversation.contactId, id: { not: conversation.id } } });
    expect(queued.status).toBe("NEW");
    expect(await notesOf(queued.id)).toEqual([]);
  }, 20000);

  it("o tempo é configurável em Configurações › Fila (1 a 60 minutos)", async () => {
    const patch = (minutes: unknown) => request(app).patch("/api/settings/queue").set("Authorization", `Bearer ${adminToken}`).send({ reopenAfterCloseMinutes: minutes });
    expect((await patch(0)).status).toBe(400);
    expect((await patch(61)).status).toBe(400);
    expect((await patch(20)).status).toBe(200);
    expect((await request(app).get("/api/settings/business").set("Authorization", `Bearer ${anaToken}`)).body.reopenAfterCloseMinutes).toBe(20);

    // With 20 minutes, a customer writing six minutes after the close still goes back to the attendant.
    const phone = "5511990008011";
    const conversation = await accepted(phone);
    await closeAndSend(conversation.id, phone, 1);
    const past = new Date(Date.now() - 6 * 60_000);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { closedAt: past } });
    await prisma.message.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: past } });
    provider.simulateIncomingMessage(phone, "Oi, voltei");
    await waitFor(async () => (await reload(conversation.id)).status === "IN_PROGRESS");
    expect((await reload(conversation.id)).assignedAgentId).toBe(anaId);
  }, 20000);
});
