import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const sent: { phone: string; text: string }[] = [];
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    sendOutboundText: vi.fn(async (_connectionId: string, _messageId: string, phone: string, text: string) => {
      sent.push({ phone, text });
    }),
  };
});

// Loaded after the mock so every module binds to the mocked whatsapp.service.
import { createApp } from "../src/app";
import { updateBusinessSettings } from "../src/modules/settings/settings.service";
import { closeForNoReturn, processNoReturnConversations, resetNoReturnClock } from "../src/modules/conversations/no-return.service";
import { createInboundMessage } from "../src/modules/messages/messages.service";
import { findOrOpenConversationForInboundMessage } from "../src/modules/conversations/conversations.service";
import { createSurvey, processDueClosingMessages, willSendSurveyOnClose } from "../src/modules/satisfaction/satisfaction.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import { CONVERSATION_UNDO_WINDOW_MS } from "@whatsatendende/types";
import { cancelScheduledMessage, scheduleMessage } from "../src/modules/agent-tools/agent-tools.service";

const app = createApp();

/** What the customer was sent, as the conversation shows it (the agent's automatic texts — not the survey's). */
async function sentNow() {
  const rows = await prisma.message.findMany({
    where: { direction: "OUTBOUND", automatedBy: null },
    orderBy: { createdAt: "asc" },
    select: { body: true, conversation: { select: { contact: { select: { phone: true } } } } },
  });
  return rows.map((m) => ({ text: m.body, phone: m.conversation.contact.phone }));
}
const MINUTE = 60_000;

describe("Encerramento por falta de retorno", () => {
  let connectionId: string;
  let agentId: string;
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    resetNoReturnClock();
    connectionId = (await createTestConnection("Suporte")).id;
    agentId = (await createTestUser({ email: "ana@test.dev", role: "AGENT", displayName: "Ana", presence: "ONLINE", whatsappConnectionId: connectionId })).id;
    token = (await request(app).post("/api/auth/login").send({ email: "ana@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A conversation with Ana whose last word was hers, `minutesAgo` minutes ago. */
  async function waitingOnCustomer(phone: string, minutesAgo: number) {
    const contact = await prisma.contact.create({ data: { phone, name: "Joana", whatsappConnectionId: connectionId } });
    return prisma.conversation.create({
      data: {
        contactId: contact.id,
        whatsappConnectionId: connectionId,
        status: "IN_PROGRESS",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        lastMessageAt: new Date(Date.now() - minutesAgo * MINUTE),
        lastMessageDirection: "OUTBOUND",
      },
    });
  }

  const enable = () => updateBusinessSettings({ noReturnEnabled: true, noReturnReminderMinutes: 10, noReturnCloseMinutes: 15 });

  it("manual: envia a mensagem de falta de retorno, sem pesquisa, e registra o motivo", async () => {
    await createSurvey({
      name: "Pesquisa",
      active: true,
      connectionScope: { allConnections: true, connectionIds: [] },
      question: "De 0 a 10?",
      thanks: "Obrigado!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
    });
    const conversation = await waitingOnCustomer("5511900000001", 2);
    expect(await willSendSurveyOnClose(conversation.id)).toBe(true);

    const res = await request(app).post(`/api/conversations/${conversation.id}/close-no-return`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((await sentNow()).map((m) => m.text)).toEqual([
      "Joana, como não tivemos retorno, estamos encerrando este atendimento por enquanto. Quando quiser continuar, é só mandar uma mensagem aqui que retomamos de onde paramos. Até logo! 👋",
    ]);
    const closed = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(closed).toMatchObject({ status: "CLOSED", closeReason: "NO_RETURN", closedByUserId: agentId });
    expect(await prisma.conversationNote.count({ where: { conversationId: conversation.id } })).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await prisma.satisfactionSurvey.count()).toBe(0);
  });

  it("automático: lembrete depois de X minutos, encerra Y minutos depois; desligado não faz nada", async () => {
    const conversation = await waitingOnCustomer("5511900000002", 11);
    await processNoReturnConversations();
    expect(await sentNow()).toHaveLength(0); // off by default

    await enable();
    await processNoReturnConversations();
    expect((await sentNow()).map((m) => m.text)).toEqual(["Oi, Joana! Ainda está por aí? 😊 Fico aguardando seu retorno para continuarmos o atendimento."]);
    const reminded = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(reminded.noReturnCloseAt!.getTime()).toBeGreaterThan(Date.now() + 14 * MINUTE);
    expect(reminded.status).toBe("IN_PROGRESS");

    await processNoReturnConversations(new Date(Date.now() + 16 * MINUTE));
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ status: "CLOSED", closeReason: "NO_RETURN" });
    expect(await sentNow()).toHaveLength(2);
  });

  it("o cliente respondeu, há lembrete pendente ou o atendente marcou Aguardar cliente: não encerra", async () => {
    await enable();
    const answered = await waitingOnCustomer("5511900000003", 11);
    await processNoReturnConversations();
    await createInboundMessage({ conversationId: answered.id, type: "TEXT", body: "oi", providerMessageId: "wamid-1" });
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: answered.id } })).toMatchObject({ noReturnCloseAt: null, lastMessageDirection: "INBOUND" });

    const withReminder = await waitingOnCustomer("5511900000004", 30);
    await prisma.conversationReminder.create({ data: { userId: agentId, conversationId: withReminder.id, remindAt: new Date(Date.now() + 60 * MINUTE) } });
    const held = await waitingOnCustomer("5511900000005", 30);
    const hold = await request(app).post(`/api/conversations/${held.id}/no-return-hold`).set("Authorization", `Bearer ${token}`).send({ hold: true });
    expect(hold.body).toMatchObject({ noReturnHold: true });

    const before = (await sentNow()).length;
    await processNoReturnConversations(new Date(Date.now() + 60 * MINUTE));
    expect((await sentNow()).length).toBe(before);
    expect(await prisma.conversation.count({ where: { status: "CLOSED" } })).toBe(0);
  });

  it("fora do expediente o tempo para", async () => {
    await enable();
    const schedule = await prisma.workSchedule.create({ data: { name: "Fechado", state: "MT", city: "Cuiabá", days: {}, closedMessage: "Fechado." } });
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { workScheduleId: schedule.id } });
    const conversation = await waitingOnCustomer("5511900000006", 5);

    const start = Date.now();
    await processNoReturnConversations(new Date(start));
    const before = (await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).noReturnReminderAt!.getTime();
    await processNoReturnConversations(new Date(start + 30 * MINUTE));
    const after = (await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).noReturnReminderAt!.getTime();
    expect(after - before).toBe(30 * MINUTE);
    expect(await sentNow()).toHaveLength(0);
  });

  it("com \"Enviar a pesquisa de satisfação\" marcado, a pesquisa vai depois do encerramento e a mensagem espera a nota, sem o nome do atendente", async () => {
    await createSurvey({
      name: "Pesquisa",
      active: true,
      connectionScope: { allConnections: true, connectionIds: [] },
      question: "De 0 a 10?",
      thanks: "Obrigado!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
    });
    await updateBusinessSettings({ noReturnSendSurvey: true });
    const conversation = await waitingOnCustomer("5511900000008", 2);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await closeForNoReturn(conversation.id, null);
      // Held: nothing goes out at the close itself.
      expect(await sentNow()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    } finally {
      vi.useRealTimers();
    }

    // The follow-up runs on its own after the timer: wait for the survey row.
    for (let i = 0; i < 50 && !(await prisma.satisfactionSurvey.findUnique({ where: { conversationId: conversation.id } })); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const survey = await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } });
    expect(survey.closingText).toBe(
      "Joana, como não tivemos retorno, estamos encerrando este atendimento por enquanto. Quando quiser continuar, é só mandar uma mensagem aqui que retomamos de onde paramos. Até logo! 👋"
    );
    expect(survey.closingText).not.toContain("Ana");
    const question = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, automatedBy: "SURVEY" } });
    expect(question.body).toBe("De 0 a 10?");
  });

  /** Closes for falta de retorno with the survey on and returns the survey row, once the question went out. */
  async function closedWithSurvey(phone: string) {
    await createSurvey({
      name: "Pesquisa",
      active: true,
      connectionScope: { allConnections: true, connectionIds: [] },
      question: "De 0 a 10?",
      thanks: "Obrigado!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
    });
    await updateBusinessSettings({ noReturnSendSurvey: true });
    const conversation = await waitingOnCustomer(phone, 2);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await closeForNoReturn(conversation.id, null);
      await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < 50 && !(await prisma.satisfactionSurvey.findUnique({ where: { conversationId: conversation.id } })); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } });
  }

  const NO_RETURN_TEXT = "Joana, como não tivemos retorno, estamos encerrando este atendimento por enquanto. Quando quiser continuar, é só mandar uma mensagem aqui que retomamos de onde paramos. Até logo! 👋";
  /** What the conversation shows after the survey's question, in order. */
  const afterQuestion = async (conversationId: string) =>
    (await prisma.message.findMany({ where: { conversationId, direction: "OUTBOUND", automatedBy: null }, orderBy: { createdAt: "asc" } })).map((m) => m.body);

  it("o cliente deu a nota: depois do agradecimento vai a mensagem de encerramento do atendente, não a de falta de retorno", async () => {
    await createClosingMessage({ name: "Padrão", text: "Obrigada pelo contato, {{primeiro_nome}}!", active: true, userIds: [agentId], connectionScope: { allConnections: true, connectionIds: [] } });
    const survey = await closedWithSurvey("5511900000010");
    const now = new Date();
    await prisma.satisfactionSurvey.update({ where: { id: survey.id }, data: { score: 10, answeredAt: now, closingDueAt: now } });
    await processDueClosingMessages(new Date(now.getTime() + 1000));
    expect(await afterQuestion(survey.conversationId)).toEqual(["Obrigada pelo contato, Joana!"]);
  });

  it("o cliente deu a nota e o atendente não tem mensagem de encerramento: nada depois do agradecimento", async () => {
    const survey = await closedWithSurvey("5511900000011");
    const now = new Date();
    await prisma.satisfactionSurvey.update({ where: { id: survey.id }, data: { score: 9, answeredAt: now, closingDueAt: now } });
    await processDueClosingMessages(new Date(now.getTime() + 1000));
    expect(await afterQuestion(survey.conversationId)).toEqual([]);
    expect((await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { id: survey.id } })).closingOutcome).toBe("SKIPPED_ANSWERED");
  });

  it("o cliente não deu a nota: quando o tempo acaba vai a mensagem de falta de retorno", async () => {
    await createClosingMessage({ name: "Padrão", text: "Obrigada pelo contato, {{primeiro_nome}}!", active: true, userIds: [agentId], connectionScope: { allConnections: true, connectionIds: [] } });
    const survey = await closedWithSurvey("5511900000012");
    await processDueClosingMessages(new Date(survey.closingDueAt!.getTime() + 1000));
    expect(await afterQuestion(survey.conversationId)).toEqual([NO_RETURN_TEXT]);
  });

  it("sem a marcação (padrão), o encerramento por falta de retorno continua sem pesquisa", async () => {
    await createSurvey({
      name: "Pesquisa",
      active: true,
      connectionScope: { allConnections: true, connectionIds: [] },
      question: "De 0 a 10?",
      thanks: "Obrigado!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
    });
    const conversation = await waitingOnCustomer("5511900000009", 2);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await closeForNoReturn(conversation.id, null);
      await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // a survey that should not be there gets time to show up
    expect(await sentNow()).toHaveLength(1);
    expect(await prisma.satisfactionSurvey.findUnique({ where: { conversationId: conversation.id } })).toBeNull();
  });

  it("mensagem agendada: pausa o encerramento, apaga o prazo que já corria e bloqueia o botão manual", async () => {
    await enable();
    const conversation = await waitingOnCustomer("5511900000010", 30);
    // The reminder already went out: the close was due a minute ago.
    await prisma.conversation.update({ where: { id: conversation.id }, data: { noReturnCloseAt: new Date(Date.now() - MINUTE) } });

    const scheduled = await scheduleMessage(agentId, { conversationId: conversation.id, body: "Retorno amanhã cedo", sendAt: new Date(Date.now() + 60 * MINUTE) });
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ noReturnCloseAt: null, noReturnReminderAt: null });

    await processNoReturnConversations();
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("IN_PROGRESS");
    expect(await sentNow()).toHaveLength(0);

    const manual = await request(app).post(`/api/conversations/${conversation.id}/close-no-return`).set("Authorization", `Bearer ${token}`);
    expect(manual.status).toBe(409);
    expect(JSON.stringify(manual.body)).toMatch(/mensagem agendada/);

    const listed = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${token}`);
    expect(listed.body.find((c: { id: string }) => c.id === conversation.id)?.scheduledMessagePending).toBe(true);

    // Canceled: the countdown starts over from now, nothing closes at once.
    await cancelScheduledMessage(agentId, scheduled.id);
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.noReturnCloseAt).toBeNull();
    expect(after.noReturnReminderAt!.getTime()).toBeGreaterThan(Date.now() + 9 * MINUTE);
    await processNoReturnConversations();
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("IN_PROGRESS");
    expect(await sentNow()).toHaveLength(0);
  });

  it("o cliente volta depois do encerramento: vai para o mesmo atendente, se online, com a nota", async () => {
    const conversation = await waitingOnCustomer("5511900000007", 2);
    await closeForNoReturn(conversation.id, null);

    const opened = await findOrOpenConversationForInboundMessage(connectionId, conversation.contactId, "voltei");
    expect(opened).toMatchObject({ isNewConversation: true, autoAssignedAgentId: agentId });
    expect(opened.conversation).toMatchObject({ status: "IN_PROGRESS", assignedAgentId: agentId });
    const notes = await prisma.conversationNote.findMany({ where: { conversationId: opened.conversation.id } });
    expect(notes.map((n) => n.body)).toEqual(["Cliente voltou após encerramento por falta de retorno"]);

    // Offline: the regular queue, still with the note.
    await prisma.conversation.update({ where: { id: opened.conversation.id }, data: { status: "CLOSED", closeReason: "NO_RETURN" } });
    await prisma.user.update({ where: { id: agentId }, data: { presence: "OFFLINE" } });
    const queued = await findOrOpenConversationForInboundMessage(connectionId, conversation.contactId, "oi de novo");
    expect(queued.autoAssignedAgentId).toBeNull();
    expect(queued.conversation.status).toBe("NEW");
  });
});
