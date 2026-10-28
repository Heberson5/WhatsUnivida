import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser } from "./helpers";

const sent: { connectionId: string; phone: string; text: string; sender?: string }[] = [];
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    sendAutomatedText: vi.fn(async (connectionId: string, _messageId: string, phone: string, text: string) => {
      sent.push({ connectionId, phone, text });
    }),
    sendOutboundText: vi.fn(async (connectionId: string, _messageId: string, phone: string, text: string, sender: string) => {
      sent.push({ connectionId, phone, text, sender });
    }),
  };
});

// Loaded before conversations.service so it binds to the mocked whatsapp.service (the modules import each other).
import {
  calculateNps,
  captureSurveyAnswer,
  getSatisfactionByAgent,
  getSatisfactionSummary,
  createSurvey,
  deleteSurvey,
  parseSurveyScore,
  processDueClosingMessages,
  sendCloseFollowUp,
  updateSurvey,
  willSendSurveyOnClose,
  SCORE_REASK_TEXT,
} from "../src/modules/satisfaction/satisfaction.service";
import { closeConversation, undoLastConversationAction } from "../src/modules/conversations/conversations.service";

const QUESTION = "De 0 a 10, o quanto você recomendaria o atendimento?";
const NEW_QUESTION = "De 0 a 10, qual a chance de você voltar a falar com a gente?";
const CLOSING = { text: "Obrigada pelo contato!", senderDisplayName: "Ana" };
const PERIOD = () => ({ from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) });

describe("Pesquisa de satisfação (NPS)", () => {
  let connectionId: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    connectionId = (await createTestConnection("Suporte")).id;
    agentId = (await createTestUser({ email: "ana@test.dev", role: "AGENT", whatsappConnectionId: connectionId })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function attendedConversation(phone: string, onConnection = connectionId) {
    const contact = await prisma.contact.create({ data: { phone, name: "Joana", whatsappConnectionId: onConnection } });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: onConnection, status: "IN_PROGRESS", assignedAgentId: agentId, enteredQueueAt: new Date(), acceptedAt: new Date(), lastMessageAt: new Date() },
    });
    return { contact, conversation };
  }

  /** Sets up the one survey of these tests (creating it the first time, editing it after). */
  async function configure(connectionIds: string[], question = QUESTION, enabled = true, closingWaitMinutes = 30, answerWindowHours = 24) {
    const input = { name: "Pesquisa", active: enabled, connectionScope: { allConnections: false, connectionIds }, question, thanks: "Obrigado!", answerWindowHours, closingWaitMinutes };
    const existing = await prisma.satisfactionSurveyConfig.findFirst();
    return existing ? updateSurvey(existing.id, input) : createSurvey(input);
  }

  /** Closes the conversation and answers the survey, like a customer would. */
  async function closeAndAnswer(phone: string, answer: string) {
    const { contact, conversation } = await attendedConversation(phone);
    await closeConversation(conversation.id, agentId);
    await sendCloseFollowUp(conversation.id); // what the timer does after the "Desfazer" window
    expect(await captureSurveyAnswer(connectionId, contact, { body: answer, providerMessageId: `wamid-${phone}` })).toBe(true);
    return { contact, conversation };
  }

  it("fica desligada por padrão: encerrar não envia nada", async () => {
    const { conversation } = await attendedConversation("5511900000001");
    await closeConversation(conversation.id, agentId);
    await sendCloseFollowUp(conversation.id);
    expect(sent).toHaveLength(0);
    expect(await prisma.satisfactionSurvey.count()).toBe(0);
  });

  it("ligada para a conexão: pergunta ao encerrar, guarda a nota de 0 a 10 na conversa encerrada e agradece", async () => {
    await configure([connectionId]);
    const { contact, conversation } = await attendedConversation("5511900000002");
    await closeConversation(conversation.id, agentId);
    await sendCloseFollowUp(conversation.id);
    expect(sent.map((m) => m.text)).toEqual([QUESTION]);

    expect(await captureSurveyAnswer(connectionId, contact, { body: "nota 9", providerMessageId: "wamid-1" })).toBe(true);
    expect(sent.at(-1)?.text).toBe("Obrigado!");
    const survey = await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id }, include: { question: true } });
    expect(survey.score).toBe(9);
    expect(survey.agentId).toBe(agentId);
    expect(survey.question?.text).toBe(QUESTION);
    expect(await prisma.conversation.count({ where: { contactId: contact.id } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId: conversation.id, automatedBy: "SURVEY" } })).toBe(2);

    const summary = await getSatisfactionSummary(PERIOD());
    expect(summary).toEqual({
      sent: 1,
      answered: 1,
      questions: [
        {
          questionId: survey.questionId,
          question: QUESTION,
          current: true,
          scaleMax: 10,
          sent: 1,
          answered: 1,
          average: 9,
          distribution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
          promoters: 1,
          passives: 0,
          detractors: 0,
          nps: 100,
        },
      ],
    });
  });

  it("aceita a nota zero e o dez", async () => {
    await configure([connectionId]);
    await closeAndAnswer("5511900000020", "0");
    await closeAndAnswer("5511900000021", "10");
    const [question] = (await getSatisfactionSummary(PERIOD())).questions;
    expect(question.distribution[0]).toBe(1);
    expect(question.distribution[10]).toBe(1);
    expect(question).toMatchObject({ answered: 2, average: 5, promoters: 1, detractors: 1, nps: 50 });
  });

  it("não envia em conexão fora da lista", async () => {
    const other = await createTestConnection("Vendas");
    await configure([other.id]);
    const { conversation } = await attendedConversation("5511900000003");
    await closeConversation(conversation.id, agentId);
    await sendCloseFollowUp(conversation.id);
    expect(sent).toHaveLength(0);
  });

  it("uma resposta que não é nota encerra a pesquisa e segue o caminho normal", async () => {
    await configure([connectionId]);
    const { contact, conversation } = await attendedConversation("5511900000004");
    await closeConversation(conversation.id, agentId);
    await sendCloseFollowUp(conversation.id);
    expect(sent).toHaveLength(1);

    expect(await captureSurveyAnswer(connectionId, contact, { body: "preciso de outra coisa", providerMessageId: "wamid-2" })).toBe(false);
    expect(await captureSurveyAnswer(connectionId, contact, { body: "5", providerMessageId: "wamid-3" })).toBe(false);
  });

  it("reconhece a nota em respostas curtas", () => {
    expect(parseSurveyScore("5")).toBe(5);
    expect(parseSurveyScore("0")).toBe(0);
    expect(parseSurveyScore("10")).toBe(10);
    expect(parseSurveyScore(" 9 pontos ")).toBe(9);
    expect(parseSurveyScore("nota 7!")).toBe(7);
    expect(parseSurveyScore("11")).toBeNull();
    expect(parseSurveyScore("100")).toBeNull();
    expect(parseSurveyScore("45")).toBeNull();
    expect(parseSurveyScore("de 3 a 4")).toBeNull();
    expect(parseSurveyScore("o pedido 1 chegou quebrado, quero trocar")).toBeNull();
  });

  it("contato com etiqueta \"Não enviar pesquisa\" não recebe pesquisa e sai do NPS, inclusive das respostas antigas", async () => {
    await configure([connectionId]);
    const { contact } = await closeAndAnswer("5511900000001", "9");
    expect((await getSatisfactionSummary(PERIOD())).answered).toBe(1);

    const tag = await prisma.tag.create({ data: { name: "Funcionário", color: "#000000", blockedAutoMessages: ["SURVEY"] } });
    await prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    expect(await getSatisfactionSummary(PERIOD())).toEqual({ sent: 0, answered: 0, questions: [] });
    expect((await getSatisfactionByAgent(PERIOD())).size).toBe(0);

    const again = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: agentId, enteredQueueAt: new Date(), acceptedAt: new Date() },
    });
    expect(await willSendSurveyOnClose(again.id)).toBe(false);
  });

  it("entende notas escritas de outro jeito, sem adivinhar quando há dúvida", () => {
    // Respostas reais de clientes.
    expect(parseSurveyScore("Precisei primeira vez posso da 10")).toBe(10);
    expect(parseSurveyScore("1o")).toBe(10);
    for (const [text, score] of [
      ["1O", 10], ["l0", 10], ["10!", 10], ["nota10", 10], ["10/10", 10], ["8 de 10", 8], ["de 0 a 10 dou 8", 8],
      ["dez", 10], ["nota dez", 10], ["dou deiz", 10], ["Nove", 9], ["dou um 10", 10], ["gostei muito, nota dez", 10],
      ["atendimento ótimo, dou 9 pro João", 9], ["10 obrigado pelo atendimento muito bom", 10], ["5 estrelas", 5],
    ] as const) expect(parseSurveyScore(text), text).toBe(score);
    for (const text of ["entre 7 e 8", "pedido 12345", "15", "ligo amanhã às 3 pra resolver o resto", "oi tudo bem?"]) expect(parseSurveyScore(text), text).toBeNull();
  });

  it("guarda o texto da resposta junto com a nota", async () => {
    await configure([connectionId]);
    const { conversation } = await closeAndAnswer("5511900000040", "Precisei primeira vez posso da 10");
    const survey = await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } });
    expect(survey).toMatchObject({ score: 10, answerText: "Precisei primeira vez posso da 10" });
  });

  it("pede a nota de novo uma vez quando a tentativa não dá para ler; na segunda, segue o caminho normal", async () => {
    await configure([connectionId]);
    const { contact, conversation } = await attendedConversation("5511900000041");
    await closeConversation(conversation.id, agentId);
    await sendCloseFollowUp(conversation.id);
    sent.length = 0;

    expect(await captureSurveyAnswer(connectionId, contact, { body: "nota máxima!", providerMessageId: "wamid-r1" })).toBe(true);
    expect(sent.map((m) => m.text)).toEqual([SCORE_REASK_TEXT]);
    expect(await captureSurveyAnswer(connectionId, contact, { body: "10", providerMessageId: "wamid-r2" })).toBe(true);
    expect((await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } })).score).toBe(10);

    // Another customer: the second unreadable answer is not asked again.
    const other = await attendedConversation("5511900000042");
    await closeConversation(other.conversation.id, agentId);
    await sendCloseFollowUp(other.conversation.id);
    expect(await captureSurveyAnswer(connectionId, other.contact, { body: "nota máxima", providerMessageId: "wamid-r3" })).toBe(true);
    expect(await captureSurveyAnswer(connectionId, other.contact, { body: "nota boa", providerMessageId: "wamid-r4" })).toBe(false);
  });

  describe("NPS", () => {
    it("calcula promotores (9–10), neutros (7–8) e detratores (0–6)", () => {
      // 0, 6, 8, 9, 9, 10 → 3 promotores, 1 neutro, 2 detratores
      const distribution = [1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 1];
      expect(calculateNps(distribution)).toEqual({ answered: 6, promoters: 3, passives: 1, detractors: 2, nps: 58 });
      expect(calculateNps(Array(11).fill(0))).toEqual({ answered: 0, promoters: 0, passives: 0, detractors: 0, nps: null });
      expect(calculateNps([0, 0, 0, 0, 0, 0, 0, 5, 5, 0, 0]).nps).toBe(50);
      // 0 a 100: só detratores é 0, só promotores é 100.
      expect(calculateNps([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).nps).toBe(0);
      expect(calculateNps([0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1]).nps).toBe(100);
    });

    it("mostra o NPS de cada pergunta e mantém a anterior no histórico quando o texto muda", async () => {
      await configure([connectionId]);
      await closeAndAnswer("5511900000030", "10");
      await closeAndAnswer("5511900000031", "9");

      await configure([connectionId], NEW_QUESTION);
      await closeAndAnswer("5511900000032", "3");
      await closeAndAnswer("5511900000033", "8");

      const summary = await getSatisfactionSummary(PERIOD());
      expect(summary).toMatchObject({ sent: 4, answered: 4 });
      expect(summary.questions.map((q) => ({ question: q.question, current: q.current, answered: q.answered, nps: q.nps }))).toEqual([
        { question: NEW_QUESTION, current: true, answered: 2, nps: 25 },
        { question: QUESTION, current: false, answered: 2, nps: 100 },
      ]);
      expect(await prisma.satisfactionQuestion.count()).toBe(2);
    });

    it("voltar ao texto de antes retoma o NPS daquela pergunta", async () => {
      await configure([connectionId]);
      await closeAndAnswer("5511900000040", "10");
      await configure([connectionId], NEW_QUESTION);
      await configure([connectionId], QUESTION);
      await closeAndAnswer("5511900000041", "2");

      const summary = await getSatisfactionSummary(PERIOD());
      expect(summary.questions).toHaveLength(1);
      expect(summary.questions[0]).toMatchObject({ question: QUESTION, current: true, answered: 2, nps: 50 });
      expect(await prisma.satisfactionQuestion.count()).toBe(1); // the other wording was never sent, so it left no question behind
    });

    it("só lista as perguntas enviadas no período", async () => {
      await configure([connectionId]);
      await closeAndAnswer("5511900000050", "9");
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await prisma.satisfactionSurvey.updateMany({ data: { sentAt: old } });
      await configure([connectionId], NEW_QUESTION);

      expect(await getSatisfactionSummary(PERIOD())).toEqual({ sent: 0, answered: 0, questions: [] });
    });

    it("o que foi enviado na escala antiga (1 a 5) aparece à parte, sem NPS, e não recebe respostas novas", async () => {
      await configure([connectionId]);
      const { contact, conversation } = await attendedConversation("5511900000060");
      await closeConversation(conversation.id, agentId);
      await prisma.satisfactionSurvey.create({
        data: { conversationId: conversation.id, contactId: contact.id, whatsappConnectionId: connectionId, agentId, score: 4, sentAt: new Date(), expiresAt: new Date(), answeredAt: new Date() },
      });
      const pending = await attendedConversation("5511900000061");
      await closeConversation(pending.conversation.id, agentId);
      await prisma.satisfactionSurvey.create({
        data: { conversationId: pending.conversation.id, contactId: pending.contact.id, whatsappConnectionId: connectionId, agentId, sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
      });

      const summary = await getSatisfactionSummary(PERIOD());
      expect(summary.questions).toHaveLength(1);
      expect(summary.questions[0]).toMatchObject({ questionId: null, scaleMax: 5, sent: 2, answered: 1, average: 4, nps: null });
      expect(await captureSurveyAnswer(connectionId, pending.contact, { body: "8", providerMessageId: "wamid-legacy" })).toBe(false);
    });

    it("calcula o NPS por atendente só com as notas de 0 a 10", async () => {
      await configure([connectionId]);
      await closeAndAnswer("5511900000070", "10");
      await closeAndAnswer("5511900000071", "2");
      await closeAndAnswer("5511900000072", "9");
      const byAgent = await getSatisfactionByAgent(PERIOD());
      expect(byAgent.get(agentId)).toEqual({ answered: 3, nps: 67, unanswered: 0 });
    });
  });

  describe("mensagem de encerramento com a pesquisa ligada", () => {
    it("com a pesquisa a caminho, a janela do Desfazer termina só com a pergunta; a mensagem fica guardada para depois da nota", async () => {
      await configure([connectionId]);
      const { conversation } = await attendedConversation("5511900000080");
      expect(await willSendSurveyOnClose(conversation.id)).toBe(true);

      const held = { ...CLOSING, senderId: agentId };
      await closeConversation(conversation.id, agentId, held);
      expect(sent).toHaveLength(0); // nothing leaves while the "Desfazer" window is open

      await sendCloseFollowUp(conversation.id, held);
      expect(sent.map((m) => m.text)).toEqual([QUESTION]); // the closing message does not go with it
      const survey = await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } });
      expect(survey).toMatchObject({ closingText: CLOSING.text, closingSenderId: agentId, closingResolvedAt: null, closingOutcome: null });
      expect(await prisma.message.count({ where: { conversationId: conversation.id, body: CLOSING.text } })).toBe(0);
    });

    it("se o atendente desfaz dentro da janela, nem a mensagem nem a pesquisa são enviadas", async () => {
      await configure([connectionId]);
      const { conversation } = await attendedConversation("5511900000081");
      const held = { ...CLOSING, senderId: agentId };
      await closeConversation(conversation.id, agentId, held);
      await undoLastConversationAction(conversation.id, agentId);

      await sendCloseFollowUp(conversation.id, held); // the timer still fires
      expect(sent).toHaveLength(0);
      expect(await prisma.satisfactionSurvey.count()).toBe(0);
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("IN_PROGRESS");
    });

    it("depois que a pergunta saiu, não dá mais para desfazer", async () => {
      await configure([connectionId]);
      const { conversation } = await attendedConversation("5511900000082");
      await closeConversation(conversation.id, agentId, { ...CLOSING, senderId: agentId });
      await sendCloseFollowUp(conversation.id, { ...CLOSING, senderId: agentId });

      await expect(undoLastConversationAction(conversation.id, agentId)).rejects.toThrow("Não é mais possível desfazer esta ação");
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("CLOSED");
    });

    it("se a pesquisa foi desligada durante a janela, a mensagem de encerramento sai mesmo assim", async () => {
      await configure([connectionId]);
      const { conversation } = await attendedConversation("5511900000083");
      const held = { ...CLOSING, senderId: agentId };
      await closeConversation(conversation.id, agentId, held);
      await configure([connectionId], QUESTION, false);

      await sendCloseFollowUp(conversation.id, held);
      expect(sent.map((m) => m.text)).toEqual([CLOSING.text]);
      expect(sent[0].sender).toBe("Ana"); // no survey: the agent's name goes with it
      expect(await prisma.satisfactionSurvey.count()).toBe(0);
    });

    it("sem pesquisa para essa conversa, a mensagem não é retida", async () => {
      const { conversation } = await attendedConversation("5511900000084");
      expect(await willSendSurveyOnClose(conversation.id)).toBe(false); // survey off

      const other = await createTestConnection("Vendas");
      await configure([other.id]);
      expect(await willSendSurveyOnClose(conversation.id)).toBe(false); // survey on, but not for this connection

      await configure([connectionId]);
      await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedAgentId: null } });
      expect(await willSendSurveyOnClose(conversation.id)).toBe(false); // nobody attended it
    });

    it("se o cliente voltou a escrever durante a janela do Desfazer, nem a pergunta nem a mensagem saem", async () => {
      await configure([connectionId]);
      const { contact, conversation } = await attendedConversation("5511900000085");
      const held = { ...CLOSING, senderId: agentId };
      await closeConversation(conversation.id, agentId, held);
      // The customer wrote before the timer fired: a new conversation is already in the queue.
      await prisma.conversation.create({
        data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "NEW", enteredQueueAt: new Date(), createdAt: new Date(Date.now() + 1000), lastMessageAt: new Date() },
      });

      await sendCloseFollowUp(conversation.id, held);
      expect(sent).toHaveLength(0);
      expect(await prisma.satisfactionSurvey.count()).toBe(0);
    });

    it("o aviso do Desfazer disparado duas vezes (encerrou, desfez e encerrou de novo) não repete nada", async () => {
      await configure([connectionId]);
      const { conversation } = await attendedConversation("5511900000086");
      const held = { ...CLOSING, senderId: agentId };
      await closeConversation(conversation.id, agentId, held);
      await sendCloseFollowUp(conversation.id, held);
      await sendCloseFollowUp(conversation.id, held); // the second timer
      expect(sent.map((m) => m.text)).toEqual([QUESTION]);
      expect(await prisma.satisfactionSurvey.count()).toBe(1);
    });
  });

  describe("mensagem de encerramento: a espera pela nota", () => {
    let serial = 0;

    /** Closes like the agent would and lets the "Desfazer" window pass: the question is out and the closing message waits. */
    async function closedAndAsked(phone: string, withClosingMessage = true) {
      const { contact, conversation } = await attendedConversation(phone);
      const held = withClosingMessage ? { ...CLOSING, senderId: agentId } : undefined;
      await closeConversation(conversation.id, agentId, held);
      await sendCloseFollowUp(conversation.id, held);
      sent.length = 0; // from here on, only what the customer's replies cause
      const survey = await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } });
      return { contact, conversation, survey };
    }

    const reply = (contact: { id: string; phone: string | null }, body: string | null) =>
      captureSurveyAnswer(connectionId, contact, { body, providerMessageId: `wamid-wait-${(serial += 1)}` });
    const texts = () => sent.map((m) => m.text);
    /** The sweep as it would run `ms` from now. */
    const sweepAfter = (ms: number) => processDueClosingMessages(new Date(Date.now() + ms));
    /** The wait is over (what 30 minutes without an answer amounts to). */
    const makeDue = (conversationId: string) => prisma.satisfactionSurvey.update({ where: { conversationId }, data: { closingDueAt: new Date(Date.now() - 1000) } });
    const surveyOf = (conversationId: string) => prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId } });

    beforeEach(async () => {
      await configure([connectionId]);
    });

    it("a mensagem fica guardada na pesquisa com o prazo de 30 minutos a partir da pergunta", async () => {
      const { survey } = await closedAndAsked("5511900000100");
      expect(survey.closingDueAt!.getTime() - survey.sentAt.getTime()).toBe(30 * 60_000);
      expect(survey.closingText).toBe(CLOSING.text);
      expect(await sweepAfter(0)).toBe(0); // nothing is due yet
    });

    it("o prazo vem da configuração, e nunca passa do tempo que o cliente tem para responder", async () => {
      await configure([connectionId], QUESTION, true, 45);
      const first = await closedAndAsked("5511900000101");
      expect(first.survey.closingDueAt!.getTime() - first.survey.sentAt.getTime()).toBe(45 * 60_000);

      await configure([connectionId], QUESTION, true, 720, 1);
      const second = await closedAndAsked("5511900000102");
      expect(second.survey.closingDueAt!.getTime() - second.survey.sentAt.getTime()).toBe(60 * 60_000);
    });

    it("a nota: o agradecimento sai na hora e a mensagem de encerramento 10 segundos depois, uma vez só", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000103");

      expect(await reply(contact, "10")).toBe(true);
      expect(texts()).toEqual(["Obrigado!"]); // thanks at once; the closing message is not out yet
      const answered = await surveyOf(conversation.id);
      expect(answered.score).toBe(10);
      expect(answered.closingDueAt!.getTime() - answered.answeredAt!.getTime()).toBe(10_000);

      expect(await sweepAfter(5_000)).toBe(0);
      expect(texts()).toEqual(["Obrigado!"]);

      expect(await sweepAfter(11_000)).toBe(1);
      expect(texts()).toEqual(["Obrigado!", CLOSING.text]);
      expect(sent.at(-1)?.sender).toBeNull(); // after the survey, without the agent's name on top
      const message = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, body: CLOSING.text } });
      expect(message).toMatchObject({ direction: "OUTBOUND", senderAgentId: agentId, automatedBy: null });
      expect(await surveyOf(conversation.id)).toMatchObject({ closingOutcome: "SENT" });
      expect((await surveyOf(conversation.id)).closingResolvedAt).not.toBeNull();

      expect(await sweepAfter(60 * 60_000)).toBe(0); // once only
      expect(texts()).toHaveLength(2);
    });

    it("sem resposta, a mensagem sai quando a espera acaba — e uma nota que chegue depois ainda vale, sem repetir a mensagem", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000104");

      expect(await sweepAfter(29 * 60_000)).toBe(0);
      expect(texts()).toEqual([]);

      await makeDue(conversation.id);
      expect(await processDueClosingMessages()).toBe(1);
      expect(texts()).toEqual([CLOSING.text]);

      expect(await reply(contact, "8")).toBe(true); // the answer window is 24 h
      expect(texts()).toEqual([CLOSING.text, "Obrigado!"]);
      expect((await surveyOf(conversation.id)).score).toBe(8);
      expect(await processDueClosingMessages()).toBe(0);
      expect(texts()).toHaveLength(2);
    });

    it("agradecimento enquanto espera a nota: fica na conversa encerrada, não abre conversa e não muda o prazo", async () => {
      const { contact, conversation, survey } = await closedAndAsked("5511900000105");

      expect(await reply(contact, "obrigado")).toBe(true);
      expect(await reply(contact, "Valeu! 👍")).toBe(true);

      expect(await prisma.conversation.count({ where: { contactId: contact.id } })).toBe(1);
      const stored = await prisma.message.findMany({ where: { conversationId: conversation.id, direction: "INBOUND" }, orderBy: { createdAt: "asc" }, select: { body: true, type: true } });
      expect(stored).toEqual([
        { body: "obrigado", type: "TEXT" },
        { body: "Valeu! 👍", type: "TEXT" },
      ]);
      expect(texts()).toEqual([]); // nothing is answered to a thank-you
      const after = await surveyOf(conversation.id);
      expect(after.closingDueAt).toEqual(survey.closingDueAt); // the deadline did not move
      expect(after).toMatchObject({ answeredAt: null, closingResolvedAt: null });

      expect(await sweepAfter(31 * 60_000)).toBe(1); // the closing message still goes out when the wait ends
      expect(texts()).toEqual([CLOSING.text]);
    });

    it("quem agradece e depois manda a nota ainda é avaliado", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000106");
      expect(await reply(contact, "obrigado")).toBe(true);
      expect(await reply(contact, "9")).toBe(true);
      expect((await surveyOf(conversation.id)).score).toBe(9);
      expect(texts()).toEqual(["Obrigado!"]);
      expect(await sweepAfter(11_000)).toBe(1);
    });

    it("quer conversar antes da nota: a pesquisa termina, a mensagem de encerramento nunca é enviada e a mensagem segue para a fila", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000107");

      expect(await reply(contact, "preciso de ajuda com o boleto")).toBe(false); // the normal path opens the new conversation
      const after = await surveyOf(conversation.id);
      expect(after.closingOutcome).toBe("CANCELED_CUSTOMER_WROTE");
      expect(after.closingResolvedAt).not.toBeNull();
      expect(after.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

      expect(await sweepAfter(31 * 60_000)).toBe(0);
      expect(texts()).toEqual([]);
      expect(await reply(contact, "10")).toBe(false); // the survey is over: this is not a score any more
    });

    it("um agradecimento com pedido junto também é querer conversar", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000108");
      expect(await reply(contact, "obrigado, mas ainda tenho uma dúvida")).toBe(false);
      expect((await surveyOf(conversation.id)).closingOutcome).toBe("CANCELED_CUSTOMER_WROTE");
      expect(await sweepAfter(31 * 60_000)).toBe(0);
    });

    it("figura, áudio ou qualquer coisa que não seja texto é querer conversar", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000109");
      expect(await reply(contact, null)).toBe(false);
      expect((await surveyOf(conversation.id)).closingOutcome).toBe("CANCELED_CUSTOMER_WROTE");
      expect(await sweepAfter(31 * 60_000)).toBe(0);
    });

    it("nos 10 segundos depois da nota, agradecer ou repetir a nota mantém a mensagem de encerramento", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000110");
      expect(await reply(contact, "10")).toBe(true);
      const answered = await surveyOf(conversation.id);

      expect(await reply(contact, "obrigado")).toBe(true);
      expect(await reply(contact, "10")).toBe(true); // a repeated score is still the same answer
      const after = await surveyOf(conversation.id);
      expect(after.score).toBe(10);
      expect(after.closingDueAt).toEqual(answered.closingDueAt);
      expect(texts()).toEqual(["Obrigado!"]); // no second thanks for the repeated score
      expect(await prisma.conversation.count({ where: { contactId: contact.id } })).toBe(1);

      expect(await sweepAfter(11_000)).toBe(1);
      expect(texts()).toEqual(["Obrigado!", CLOSING.text]);
    });

    it("nos 10 segundos depois da nota, querer conversar cancela a mensagem de encerramento (a nota fica registrada)", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000111");
      expect(await reply(contact, "9")).toBe(true);
      sent.length = 0;

      expect(await reply(contact, "na verdade o produto veio com defeito")).toBe(false);
      const after = await surveyOf(conversation.id);
      expect(after).toMatchObject({ score: 9, closingOutcome: "CANCELED_CUSTOMER_WROTE" });
      expect(await sweepAfter(11_000)).toBe(0);
      expect(texts()).toEqual([]);
    });

    it("depois que a mensagem de encerramento saiu, tudo volta ao normal: a mensagem seguinte abre conversa", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000112");
      await makeDue(conversation.id);
      expect(await processDueClosingMessages()).toBe(1);
      sent.length = 0;

      expect(await reply(contact, "obrigado")).toBe(false);
      expect(texts()).toEqual([]);
    });

    it("sem mensagem de encerramento, o agradecimento enquanto a pesquisa espera também não abre conversa — e depois do prazo volta ao normal", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000113", false);
      expect(await reply(contact, "obrigado")).toBe(true);
      expect(await sweepAfter(31 * 60_000)).toBe(0); // there is nothing to send
      expect(texts()).toEqual([]);

      await makeDue(conversation.id);
      expect(await reply(contact, "obrigado")).toBe(false);
    });

    it("sem mensagem de encerramento, depois da nota um agradecimento segue o caminho normal", async () => {
      const { contact } = await closedAndAsked("5511900000114", false);
      expect(await reply(contact, "10")).toBe(true);
      expect(await reply(contact, "obrigado")).toBe(false);
    });

    it("a espera sobrevive a um reinício: nada depende de temporizador em memória", async () => {
      const { conversation } = await closedAndAsked("5511900000115");
      await makeDue(conversation.id);
      // A fresh process only has the database — the sweep alone finds it.
      expect(await processDueClosingMessages()).toBe(1);
      expect(texts()).toEqual([CLOSING.text]);
    });

    it("duas varreduras ao mesmo tempo (ou duas instâncias) enviam a mensagem uma vez só", async () => {
      const { conversation } = await closedAndAsked("5511900000116");
      await makeDue(conversation.id);
      const results = await Promise.all([processDueClosingMessages(), processDueClosingMessages(), processDueClosingMessages()]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect(texts()).toEqual([CLOSING.text]);
      expect(await prisma.message.count({ where: { conversationId: conversation.id, body: CLOSING.text } })).toBe(1);
    });

    it("se o cliente já tem uma conversa mais nova (aberta por outro meio), a mensagem de encerramento é descartada", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000117");
      await prisma.conversation.create({
        data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "NEW", enteredQueueAt: new Date(), createdAt: new Date(Date.now() + 1000), lastMessageAt: new Date() },
      });
      await makeDue(conversation.id);
      expect(await processDueClosingMessages()).toBe(0);
      expect(texts()).toEqual([]);
      expect(await surveyOf(conversation.id)).toMatchObject({ closingOutcome: "CANCELED_NEWER_CONVERSATION" });
    });

    it("se a conversa foi retomada por alguém, a mensagem de encerramento é descartada e a resposta do cliente chega ao atendente", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000118");
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "IN_PROGRESS", closedAt: null } });

      expect(await reply(contact, "obrigado")).toBe(false); // not swallowed by the survey
      await makeDue(conversation.id);
      expect(await processDueClosingMessages()).toBe(0);
      expect(await surveyOf(conversation.id)).toMatchObject({ closingOutcome: "CANCELED_NOT_CLOSED" });
    });

    it("com a conexão fora do ar a mensagem espera (não é perdida) e sai quando ela volta", async () => {
      const { conversation } = await closedAndAsked("5511900000119");
      await makeDue(conversation.id);
      await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { status: "DISCONNECTED" } });

      expect(await processDueClosingMessages()).toBe(0);
      expect((await surveyOf(conversation.id)).closingResolvedAt).toBeNull();
      expect(texts()).toEqual([]);

      await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { status: "CONNECTED" } });
      expect(await processDueClosingMessages()).toBe(1);
      expect(texts()).toEqual([CLOSING.text]);
    });

    it("se o WhatsApp recusar a mensagem de encerramento, fica registrado como falha, sem tentar de novo", async () => {
      const { conversation } = await closedAndAsked("5511900000120");
      await makeDue(conversation.id);
      const whatsappService = await import("../src/modules/whatsapp/whatsapp.service");
      vi.mocked(whatsappService.sendOutboundText).mockResolvedValueOnce({ status: "FAILED" } as never);

      expect(await processDueClosingMessages()).toBe(0);
      expect(await surveyOf(conversation.id)).toMatchObject({ closingOutcome: "FAILED" });
      expect(await processDueClosingMessages()).toBe(0);
    });

    it("o atendente que encerrou pode ter sido removido: a mensagem sai mesmo assim", async () => {
      const { conversation } = await closedAndAsked("5511900000121");
      await prisma.satisfactionSurvey.update({ where: { conversationId: conversation.id }, data: { closingSenderId: "00000000-0000-4000-8000-000000000000" } });
      await makeDue(conversation.id);
      expect(await processDueClosingMessages()).toBe(1);
      const message = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, body: CLOSING.text } });
      expect(message.senderAgentId).toBeNull();
    });

    it("se o tempo para responder acabou com a mensagem ainda esperando (servidor parado), a nota atrasada não vale", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000123");
      await prisma.satisfactionSurvey.update({ where: { conversationId: conversation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await reply(contact, "10")).toBe(false);
      expect((await surveyOf(conversation.id)).score).toBeNull();
    });

    it("a mesma nota entregue duas vezes só vale uma vez", async () => {
      const { contact, conversation } = await closedAndAsked("5511900000122");
      const delivery = { body: "10", providerMessageId: "wamid-duplicado" };
      expect(await captureSurveyAnswer(connectionId, contact, delivery)).toBe(true);
      expect(await captureSurveyAnswer(connectionId, contact, delivery)).toBe(true);
      expect(texts()).toEqual(["Obrigado!"]);
      expect(await prisma.message.count({ where: { conversationId: conversation.id, providerMessageId: "wamid-duplicado" } })).toBe(1);
    });
  });

  describe("várias pesquisas (Respostas › Pesquisa)", () => {
    const survey = (overrides: Partial<Parameters<typeof createSurvey>[0]> = {}) =>
      createSurvey({
        name: "Pesquisa",
        active: true,
        connectionScope: { allConnections: false, connectionIds: [connectionId] },
        question: QUESTION,
        thanks: "Obrigado!",
        answerWindowHours: 24,
        closingWaitMinutes: 30,
        ...overrides,
      });

    it("pesquisas desligadas (como os modelos) nunca são enviadas", async () => {
      await survey({ name: "Modelo 1", active: false });
      await survey({ name: "Modelo 2", active: false, connectionScope: { allConnections: true, connectionIds: [] } });
      const { conversation } = await attendedConversation("5511900000201");
      expect(await willSendSurveyOnClose(conversation.id)).toBe(false);
      await closeConversation(conversation.id, agentId);
      await sendCloseFollowUp(conversation.id);
      expect(sent).toHaveLength(0);
    });

    it("vale a pesquisa escolhida para a conexão, mesmo com uma de todas as conexões mais recente; o agradecimento é o dela", async () => {
      const other = await createTestConnection("Vendas");
      await survey({ name: "Do suporte", question: NEW_QUESTION, thanks: "Valeu, suporte!" });
      await survey({ name: "Das vendas", question: "Nota para vendas?", thanks: "Valeu, vendas!", connectionScope: { allConnections: false, connectionIds: [other.id] } });
      await survey({ name: "Geral", thanks: "Valeu, geral!", connectionScope: { allConnections: true, connectionIds: [] } });

      const { contact } = await closeAndAnswer("5511900000202", "8");
      expect(sent.map((m) => m.text)).toEqual([NEW_QUESTION, "Valeu, suporte!"]);
      const recorded = await prisma.satisfactionSurvey.findFirstOrThrow({ where: { contactId: contact.id }, include: { config: true } });
      expect(recorded.config?.name).toBe("Do suporte");
    });

    it("sem pesquisa da conexão, vale a de todas as conexões", async () => {
      await survey({ name: "Desligada da conexão", active: false, question: NEW_QUESTION });
      await survey({ name: "Geral", connectionScope: { allConnections: true, connectionIds: [] } });
      await closeAndAnswer("5511900000203", "10");
      expect(sent.map((m) => m.text)).toEqual([QUESTION, "Obrigado!"]);
    });

    it("o Dashboard marca como em uso as perguntas das pesquisas ligadas", async () => {
      const first = await survey({ name: "Atual" });
      await closeAndAnswer("5511900000204", "9");
      await updateSurvey(first.id, { active: false });
      await survey({ name: "Nova", question: NEW_QUESTION });
      await closeAndAnswer("5511900000205", "6");
      const summary = await getSatisfactionSummary(PERIOD());
      expect(summary.questions.map((q) => [q.question, q.current])).toEqual([
        [NEW_QUESTION, true],
        [QUESTION, false],
      ]);
    });

    it("excluir a pesquisa não apaga as notas; quem responde depois recebe o agradecimento padrão", async () => {
      const used = await survey({ thanks: "Valeu demais!" });
      const { contact, conversation } = await attendedConversation("5511900000206");
      await closeConversation(conversation.id, agentId);
      await sendCloseFollowUp(conversation.id);
      await deleteSurvey(used.id);

      expect(await captureSurveyAnswer(connectionId, contact, { body: "7", providerMessageId: "wamid-206" })).toBe(true);
      expect(sent.at(-1)?.text).toBe("Obrigado pela sua avaliação!");
      expect((await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } })).score).toBe(7);
    });
  });
});
