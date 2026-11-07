import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

// Nothing goes to WhatsApp in the tests: what the assistant says is read from the messages it records.
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return { ...actual, sendAutomatedText: vi.fn(async () => undefined), sendOutboundFile: vi.fn(async () => undefined) };
});
// The local AI and the transcription, controlled by each test.
const llm = { intent: null as null | { intent: string; summary: string }, transcription: null as string | null };
vi.mock("../src/modules/ai-assistant/ai-llm", () => ({
  classifyIntent: vi.fn(async () => llm.intent),
  transcribeAudio: vi.fn(async () => llm.transcription),
}));

import { createApp } from "../src/app";
import { findOrOpenConversationForInboundMessage } from "../src/modules/conversations/conversations.service";
import { createInboundMessage } from "../src/modules/messages/messages.service";
import { runAssistantNow, sweepAssistantSessions } from "../src/modules/ai-assistant/ai-engine.service";
import { handleInboundForFlow } from "../src/modules/flows/flow-engine.service";
import { updateAiAssistantSettings } from "../src/modules/ai-assistant/ai-assistant.service";
import { CONVERSATION_UNDO_WINDOW_MS, DEFAULT_AI_ASSISTANT_SETTINGS } from "@whatsatendende/types";
import { createSurvey } from "../src/modules/satisfaction/satisfaction.service";
import { getPerAgentReport } from "../src/modules/reports/reports.service";
import { getAssistantUser } from "../src/modules/ai-assistant/ai-assistant.service";
import { __usePhraseVersionForTests } from "../src/modules/ai-assistant/ai-phrases";

// The first ("classic") version of each reply, so the tests can check the words.
__usePhraseVersionForTests(0);

const app = createApp();

const HEADER =
  "telefone_whatsapp,codigo_cliente,nome_cliente,cpf_cnpj,endereco,cidade,cep,numero_contrato,documento,vencimento_parcela,dias_em_atraso,saldo,forma_pagamento,vencimento_boleto,valor_boleto,nosso_numero,banco_codigo,convenio,carteira,agencia_beneficiario,conta_beneficiario,beneficiario_nome";
// The spreadsheet has the client on ANOTHER phone: the assistant finds them by the CPF.
const ROWS = [
  "5565999991111,1,Maria Aparecida da Silva,529.982.247-25,\"Rua das Flores, 100, Centro\",Tangará da Serra,78300-000,C-10,D-1,10/01/2026,280,90.00,Boleto,10/01/2026,90.00,12345670000000101,001,1234567,17,1234-5,99999-9,Empresa Teste",
  "5565999991111,1,Maria Aparecida da Silva,529.982.247-25,\"Rua das Flores, 100, Centro\",Tangará da Serra,78300-000,C-10,D-2,10/02/2026,251,90.00,Boleto,10/02/2026,90.00,12345670000000102,001,1234567,17,1234-5,99999-9,Empresa Teste",
  "5565999991111,1,Maria Aparecida da Silva,529.982.247-25,\"Rua das Flores, 100, Centro\",Tangará da Serra,78300-000,C-10,D-3,10/12/2030,0,90.00,Boleto,10/12/2030,90.00,12345670000000103,001,1234567,17,1234-5,99999-9,Empresa Teste",
];
// A beneficiary with their own CPF but no boleto: the boleto is in the titular's (Maria's) name.
ROWS.push(
  "5565911110000,2,João Beneficiário Santos,111.444.777-35,\"Rua B, 50, Centro\",Tangará da Serra,78300-000,C-90,,,,,,,,,,,,,,Empresa Teste"
);
const CUSTOMER = "5565988887777";
const BENEFICIARY_CPF = "11144477735";
const CPF = "52998224725";

describe("Assistente Virtual: conversa com o cliente", () => {
  let connectionId: string;
  let phoneSeq = 0;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.dataSource.deleteMany();
    await prisma.boletoLayout.deleteMany();
    await prisma.boletoInstruction.deleteMany();
    await createTestUser({ email: "admin-ia@test.dev", role: "ADMIN" });
    const token = (await request(app).post("/api/auth/login").send({ email: "admin-ia@test.dev", password: TEST_PASSWORD })).body.accessToken as string;
    connectionId = (await prisma.whatsAppConnection.create({ data: { name: "Central", status: "CONNECTED" } })).id;
    const source = await request(app).post("/api/data-sources").set("Authorization", `Bearer ${token}`).send({ name: "Planilha", kind: "UPLOAD" });
    await request(app)
      .post(`/api/data-sources/${source.body.id}/upload`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from([HEADER, ...ROWS].join("\n")), { filename: "dados.csv", contentType: "text/csv" });
    await request(app).post(`/api/data-sources/${source.body.id}/active`).set("Authorization", `Bearer ${token}`).send({ active: true });
    // Banco do Brasil already validated with real boletos.
    await prisma.systemSetting.upsert({
      where: { key: "boleto-validation" },
      update: { value: { "001": { matched: ["a", "b", "c"], lastFailure: null } } },
      create: { key: "boleto-validation", value: { "001": { matched: ["a", "b", "c"], lastFailure: null } } },
    });
  }, 30000);

  beforeEach(async () => {
    await resetSent();
    llm.intent = null;
    llm.transcription = null;
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { workScheduleId: null } });
    await prisma.contactCpfVerification.deleteMany();
    await prisma.clientDataCorrection.deleteMany();
  });

  afterAll(async () => {
    await prisma.dataSource.deleteMany();
    await prisma.$disconnect();
  });

  /** Each test its own customer phone (on the Modo teste list), so conversations don't mix. */
  async function newCustomer(phone = `55659888${String(70000 + ++phoneSeq)}`) {
    await updateAiAssistantSettings({ ...DEFAULT_AI_ASSISTANT_SETTINGS, enabled: true, connectionIds: [connectionId], testMode: true, testPhones: [phone, CUSTOMER] });
    const contact = await prisma.contact.upsert({ where: { id: `00000000-0000-4000-8000-${phone.slice(-12).padStart(12, "0")}` }, update: {}, create: { id: `00000000-0000-4000-8000-${phone.slice(-12).padStart(12, "0")}`, phone, name: "Cliente", whatsappConnectionId: connectionId } });
    return contact;
  }

  async function customerSays(contactId: string, body: string, type: "TEXT" | "AUDIO" = "TEXT") {
    const { conversation } = await findOrOpenConversationForInboundMessage(connectionId, contactId, body);
    const message = await createInboundMessage({ conversationId: conversation.id, providerMessageId: `in-${Math.random()}`, type, body: type === "TEXT" ? body : null });
    if (type === "AUDIO") {
      await prisma.messageAttachment.create({ data: { messageId: message.id, fileName: "audio.ogg", mimeType: "audio/ogg", sizeBytes: 10, storageKey: "nao-existe.ogg", kind: "AUDIO" } });
    }
    if (conversation.status === "IN_AI") await runAssistantNow(conversation.id);
    return prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  }

  // What the assistant said, as the team sees it in the conversation (messages recorded as "Assistente Virtual").
  let mark = new Date(0);
  const resetSent = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    mark = new Date();
  };
  const outbound = (contactId: string) =>
    prisma.message.findMany({
      where: { direction: "OUTBOUND", automatedBy: "AI", createdAt: { gt: mark }, conversation: { contactId } },
      orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
      include: { attachments: true },
    });
  const texts = async (contactId: string) => (await outbound(contactId)).filter((m) => m.type === "TEXT").map((m) => m.body ?? "");
  const lastText = async (contactId: string) => (await texts(contactId)).at(-1) ?? "";

  it("boleto do começo ao fim: CPF de outro telefone, nome sem o do meio, endereço igual, parcela 2 leva a 1 junto; toda resposta com o nome", async () => {
    const contact = await newCustomer(CUSTOMER);
    let conversation = await customerSays(contact.id, "oi, quero a segunda via do boleto");
    expect(conversation.status).toBe("IN_AI");
    // Greets with the time of day; "Cliente" is not a real name, so no name.
    expect((await texts(contact.id))[0]).toMatch(/^\*Assistente Virtual:\*\n\n(Bom dia|Boa tarde|Boa noite)! Sou o assistente virtual/);
    expect((await lastText(contact.id))).toContain("CPF");

    await customerSays(contact.id, "meu cpf é 529 982 247-25");
    expect((await lastText(contact.id))).toContain("nome completo");

    await customerSays(contact.id, "maria da silva");
    expect((await lastText(contact.id))).toContain("endereço");

    await customerSays(contact.id, "R. das Flores nº 100 - centro");
    expect((await lastText(contact.id))).toContain("parcelas em aberto");
    expect((await lastText(contact.id))).toMatch(/\*1\.\* janeiro\/2026/);
    expect((await lastText(contact.id))).toMatch(/\*3\.\* dezembro\/2030/);

    await resetSent();
    conversation = await customerSays(contact.id, "a 2");
    const file = (await outbound(contact.id)).find((m) => m.type === "DOCUMENT");
    expect(file?.body).toMatch(/^\*Assistente Virtual:\*/);
    expect(file?.attachments[0]?.fileName).toMatch(/\.pdf$/);
    // Two linhas digitáveis, digits only, without the name in front (to copy).
    const linhas = (await texts(contact.id)).filter((t) => /^\d{47}$/.test(t));
    expect(linhas).toHaveLength(2);
    expect((await lastText(contact.id))).toContain("algo mais");
    expect(conversation.dataCpfKey).toBe(CPF);

    conversation = await customerSays(contact.id, "não, obrigado");
    expect(conversation.status).toBe("CLOSED");
    const note = await prisma.conversationNote.findFirst({ where: { conversationId: conversation.id, body: { startsWith: "Assistente Virtual" } } });
    expect(note?.body).toContain("Nome informado: maria da silva (confere com o cadastro)");
    expect(note?.body).toContain("Endereço informado: R. das Flores nº 100 - centro (igual ao cadastro)");
    expect(note?.body).toContain("***.982.247-**");
    // Same address, but this phone isn't on Maria's record: the team is asked to add it.
    const correction = await prisma.clientDataCorrection.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(correction).toMatchObject({ contactPhone: CUSTOMER, informedAddress: null, registeredPhones: "5565999991111" });
    expect(await prisma.contactCpfVerification.count({ where: { contactId: contact.id, cpfKey: CPF } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "BOLETO_SENT" } })).toBe(2);
  });

  it("nome que não confere duas vezes: não mostra nada e vai para a fila com nota; mensagem neutra", async () => {
    const contact = await newCustomer();
    await customerSays(contact.id, "quanto eu devo?");
    await customerSays(contact.id, CPF);
    await customerSays(contact.id, "João Pereira");
    expect((await lastText(contact.id))).toContain("Não consegui confirmar seus dados");
    expect((await lastText(contact.id))).not.toContain("Maria");
    const conversation = await customerSays(contact.id, "José Souza");
    expect(conversation.status).toBe("NEW");
    expect((await texts(contact.id)).join(" ")).not.toContain("90,00");
    const note = await prisma.conversationNote.findFirst({ where: { conversationId: conversation.id, body: { startsWith: "Assistente Virtual" } } });
    expect(note?.body).toContain("nome informado não confere com o CPF");
  });

  it("endereço diferente: segue o atendimento e marca o cadastro como desatualizado; o mesmo telefone depois pula a confirmação", async () => {
    const contact = await newCustomer();
    await customerSays(contact.id, "quero ver meus débitos");
    await customerSays(contact.id, "52998224725");
    await customerSays(contact.id, "Maria Aparecida da Silva");
    await customerSays(contact.id, "Avenida Brasil, 2000, Jardim Europa");
    expect((await lastText(contact.id))).toContain("Quer receber o boleto?");
    const correction = await prisma.clientDataCorrection.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(correction).toMatchObject({ informedAddress: "Avenida Brasil, 2000, Jardim Europa", resolvedAt: null, cpfKey: CPF });
    expect(correction.registeredAddress).toContain("Rua das Flores");
    const closed = await customerSays(contact.id, "não");
    expect((await lastText(contact.id))).toContain("algo mais");
    await customerSays(contact.id, "era só isso, obrigado");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: closed.id } })).status).toBe("CLOSED");

    // Next time: still asks whose CPF (offering the same one), then no name or address again.
    await resetSent();
    await customerSays(contact.id, "boa tarde, preciso do boleto");
    expect(await lastText(contact.id)).toContain("Se for o mesmo de antes (***.982.247-**), responda *mesmo*");
    await customerSays(contact.id, "pode ser o mesmo");
    expect((await texts(contact.id)).join(" ")).not.toContain("nome completo");
    expect(await lastText(contact.id)).toContain("parcelas em aberto");
  });

  it("pedir atendente (texto) dentro do expediente: avisa e vai para a fila; depois não responde mais", async () => {
    const contact = await newCustomer();
    const conversation = await customerSays(contact.id, "quero falar com um atendente");
    expect(conversation.status).toBe("NEW");
    expect((await lastText(contact.id))).toBe("*Assistente Virtual:*\n\nVou transferir você para um de nossos atendentes. Em instantes alguém irá atendê-lo.");
    await resetSent();
    await customerSays(contact.id, "alô?");
    expect(await texts(contact.id)).toHaveLength(0);
  });

  it("pedir atendente fora do expediente: manda a mensagem de fora do expediente da conexão e para de responder", async () => {
    const schedule = await prisma.workSchedule.create({ data: { name: "Fechado", state: "MT", city: "Tangará da Serra", days: {}, closedMessage: "Estamos fora do expediente, {{cliente}}. Voltamos amanhã às 8h." } });
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { workScheduleId: schedule.id } });
    const contact = await newCustomer();
    // At any hour the assistant answers first (no out-of-hours notice on the first message).
    await customerSays(contact.id, "oi");
    expect((await texts(contact.id))).toHaveLength(1);
    expect((await texts(contact.id))[0]).toContain("Sou o assistente virtual");
    const conversation = await customerSays(contact.id, "me passa para uma atendente por favor");
    expect(conversation.status).toBe("NEW");
    expect((await lastText(contact.id))).toBe("*Assistente Virtual:*\n\nEstamos fora do expediente, Cliente. Voltamos amanhã às 8h.");
    await resetSent();
    await customerSays(contact.id, "??");
    expect(await texts(contact.id)).toHaveLength(0);
  });

  it("áudio: só responde depois da transcrição, que fica guardada na mensagem", async () => {
    const contact = await newCustomer();
    llm.transcription = "quero falar com uma atendente";
    const conversation = await customerSays(contact.id, "", "AUDIO");
    expect(conversation.status).toBe("NEW");
    const audio = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, type: "AUDIO" } });
    expect(audio.transcription).toBe("quero falar com uma atendente");
  });

  it("áudio que não deu para transcrever: pede para escrever e segue atendendo; no segundo seguido, passa para a fila", async () => {
    const contact = await newCustomer();
    llm.transcription = null;
    let conversation = await customerSays(contact.id, "", "AUDIO");
    expect(conversation.status).toBe("IN_AI");
    expect((await lastText(contact.id))).toContain("não consegui ouvir o seu áudio. Pode me escrever");
    conversation = await customerSays(contact.id, "quero o boleto");
    expect(conversation.status).toBe("IN_AI");
    expect((await lastText(contact.id))).toContain("CPF do titular");
    // A failure after a text starts counting again; two in a row go to the team.
    conversation = await customerSays(contact.id, "", "AUDIO");
    expect(conversation.status).toBe("IN_AI");
    conversation = await customerSays(contact.id, "", "AUDIO");
    expect(conversation.status).toBe("NEW");
    expect((await texts(contact.id)).join(" ")).toContain("Não consegui ouvir o seu áudio");
  });

  it("fora do expediente, um áudio que não deu para transcrever não manda a mensagem de fora do expediente", async () => {
    const schedule = await prisma.workSchedule.create({ data: { name: "Fechado", state: "MT", city: "Tangará da Serra", days: {}, closedMessage: "Estamos fora do expediente." } });
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { workScheduleId: schedule.id } });
    const contact = await newCustomer();
    llm.transcription = null;
    const conversation = await customerSays(contact.id, "", "AUDIO");
    expect(conversation.status).toBe("IN_AI");
    expect((await texts(contact.id)).join(" ")).not.toContain("fora do expediente");
  });

  it("outro assunto entendido pela IA local: passa para a fila com o resumo na nota", async () => {
    const contact = await newCustomer();
    llm.intent = { intent: "OUTRO", summary: "quer cancelar o plano" };
    const conversation = await customerSays(contact.id, "gostaria de cancelar meu plano funerário");
    expect(conversation.status).toBe("NEW");
    const note = await prisma.conversationNote.findFirstOrThrow({ where: { conversationId: conversation.id, body: { startsWith: "Assistente Virtual" } } });
    expect(note.body).toContain("Resumo: quer cancelar o plano");
    expect(note.body).toContain("gostaria de cancelar meu plano funerário");
  });

  it("IA local fora do ar: não entendeu duas vezes → fila (nunca deixa o cliente sem resposta)", async () => {
    const contact = await newCustomer();
    llm.intent = null;
    await customerSays(contact.id, "hmmm");
    expect((await lastText(contact.id))).toContain("não entendi");
    const conversation = await customerSays(contact.id, "sei lá");
    expect(conversation.status).toBe("NEW");
  });

  it("CPF inválido três vezes vai para a fila; número com dígito errado recebe a explicação certa", async () => {
    const contact = await newCustomer();
    await customerSays(contact.id, "boleto");
    await customerSays(contact.id, "529.982.247-26");
    expect((await lastText(contact.id))).toContain("não é um CPF válido");
    await customerSays(contact.id, "não sei");
    expect((await lastText(contact.id))).toContain("Não identifiquei o CPF");
    const conversation = await customerSays(contact.id, "111");
    expect(conversation.status).toBe("NEW");
  });

  it("etiqueta com Assistente Virtual bloqueado: o cliente segue o caminho de sempre", async () => {
    const contact = await newCustomer();
    const tag = await prisma.tag.create({ data: { name: "Sem robô", blockedAutoMessages: ["AI"] } });
    await prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    const conversation = await customerSays(contact.id, "boleto");
    expect(conversation.status).toBe("NEW");
    expect(await texts(contact.id)).toHaveLength(0);
    await prisma.contactTag.deleteMany({ where: { tagId: tag.id } });
    await prisma.tag.delete({ where: { id: tag.id } });
  });

  it("Modo teste: telefone fora da lista não fala com o assistente", async () => {
    await updateAiAssistantSettings({ ...DEFAULT_AI_ASSISTANT_SETTINGS, enabled: true, connectionIds: [connectionId], testMode: true, testPhones: ["5565911112222"] });
    const contact = await prisma.contact.create({ data: { phone: "5565933334444", name: "Outro", whatsappConnectionId: connectionId } });
    const { conversation } = await findOrOpenConversationForInboundMessage(connectionId, contact.id, "boleto");
    expect(conversation.status).toBe("NEW");
  });

  it("cliente que parou de responder: com o boleto já enviado, encerra; sem nada feito, vai para a fila", async () => {
    const helped = await newCustomer();
    await customerSays(helped.id, "debitos");
    await customerSays(helped.id, CPF);
    await customerSays(helped.id, "Maria Silva");
    await customerSays(helped.id, "Rua das Flores 100");
    const idle = await newCustomer();
    await customerSays(idle.id, "boleto");
    const later = new Date(Date.now() + 31 * 60_000);
    await sweepAssistantSessions(later);
    const helpedConv = await prisma.conversation.findFirstOrThrow({ where: { contactId: helped.id }, orderBy: { createdAt: "desc" } });
    const idleConv = await prisma.conversation.findFirstOrThrow({ where: { contactId: idle.id }, orderBy: { createdAt: "desc" } });
    expect(helpedConv.status).toBe("CLOSED");
    expect(idleConv.status).toBe("NEW");
  });

  it("gestor tirou a conversa do assistente: ele para e a sessão fecha", async () => {
    const contact = await newCustomer();
    const conversation = await customerSays(contact.id, "boleto");
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "NEW" } });
    await resetSent();
    await runAssistantNow(conversation.id);
    expect(await texts(contact.id)).toHaveLength(0);
    await sweepAssistantSessions();
    expect((await prisma.aiSession.findUniqueOrThrow({ where: { conversationId: conversation.id } })).endReason).toBe("TAKEN_AWAY");
  });

  it("pop-up de cadastro desatualizado: o atendente vê; \"Cadastro já atualizado\" guarda quem e quando e o aviso some", async () => {
    const contact = await newCustomer();
    const agent = await createTestUser({ email: `ana-${Date.now()}@test.dev`, role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    const token = (await request(app).post("/api/auth/login").send({ email: agent.email, password: TEST_PASSWORD })).body.accessToken as string;
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: agent.id, acceptedAt: new Date() } });
    const correction = await prisma.clientDataCorrection.create({
      data: { contactId: contact.id, conversationId: conversation.id, cpfKey: CPF, clientName: "Maria Aparecida da Silva", registeredAddress: "Rua das Flores, 100", informedAddress: "Avenida Brasil, 2000" },
    });
    const listed = await request(app).get(`/api/conversations/${conversation.id}/data-corrections`).set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ cpf: "***.982.247-**", informedAddress: "Avenida Brasil, 2000" });
    const resolved = await request(app).post(`/api/conversations/${conversation.id}/data-corrections/${correction.id}/resolve`).set("Authorization", `Bearer ${token}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedByName).toBe("Ana");
    const row = await prisma.clientDataCorrection.findUniqueOrThrow({ where: { id: correction.id } });
    expect(row.resolvedById).toBe(agent.id);
    expect(row.resolvedAt).not.toBeNull();
    expect((await request(app).get(`/api/conversations/${conversation.id}/data-corrections`).set("Authorization", `Bearer ${token}`)).body).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: "CLIENT_DATA_CORRECTION_RESOLVED", userId: agent.id } })).toBe(1);
    expect(await prisma.conversationNote.count({ where: { conversationId: conversation.id, body: { startsWith: "Cadastro atualizado por Ana" } } })).toBe(1);
  });

  it("Fluxo com o bloco Assistente Virtual: o fluxo termina e o assistente cumprimenta; desligado, vai para a fila", async () => {
    const flow = await prisma.flow.create({ data: { name: "Com IA", active: true } });
    const start = await prisma.flowNode.create({ data: { flowId: flow.id, type: "START" } });
    const ai = await prisma.flowNode.create({ data: { flowId: flow.id, type: "AI_ASSISTANT" } });
    await prisma.flowEdge.create({ data: { flowId: flow.id, sourceNodeId: start.id, targetNodeId: ai.id } });
    await prisma.flowConnection.create({ data: { flowId: flow.id, whatsappConnectionId: connectionId } });
    try {
      const contact = await newCustomer();
      const { conversation, flowId } = await findOrOpenConversationForInboundMessage(connectionId, contact.id, "oi");
      expect(conversation.status).toBe("IN_FLOW");
      await handleInboundForFlow(conversation.id, flowId, "oi");
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("IN_AI");
      expect(await lastText(contact.id)).toContain("Sou o assistente virtual");

      // Assistant switched off: the same step sends the customer to the queue.
      await updateAiAssistantSettings({ ...DEFAULT_AI_ASSISTANT_SETTINGS, enabled: false });
      const other = await prisma.contact.create({ data: { phone: "5565977776666", name: "Outro", whatsappConnectionId: connectionId } });
      const second = await findOrOpenConversationForInboundMessage(connectionId, other.id, "oi");
      await handleInboundForFlow(second.conversation.id, second.flowId, "oi");
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: second.conversation.id } })).status).toBe("NEW");
    } finally {
      await prisma.flow.delete({ where: { id: flow.id } });
    }
  });

  describe("encerramento pelo assistente, como um atendente", () => {
    /** Runs what the close schedules (closing message + survey) right away, like the Encerrar button after its undo window. */
    async function closeAndFollowUp(contactId: string, body: string) {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const conversation = await customerSays(contactId, body);
        await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS + 100);
        return conversation;
      } finally {
        vi.useRealTimers();
      }
    }
    async function surveyOf(conversationId: string) {
      for (let i = 0; i < 30; i++) {
        const survey = await prisma.satisfactionSurvey.findUnique({ where: { conversationId } });
        if (survey) return survey;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    }

    beforeAll(async () => {
      await prisma.satisfactionSurveyConfig.deleteMany();
      await createSurvey({
        name: "Pesquisa",
        active: true,
        connectionScope: { allConnections: true, connectionIds: [] },
        question: "De 0 a 10?",
        thanks: "Obrigado!",
        answerWindowHours: 24,
        closingWaitMinutes: 30,
      });
    });

    afterAll(async () => {
      await prisma.satisfactionSurveyConfig.deleteMany();
    });

    it("pedido atendido: encerra como o atendente Assistente Virtual e manda a pesquisa", async () => {
      const assistant = await getAssistantUser();
      const contact = await newCustomer();
      await customerSays(contact.id, "quanto devo");
      await customerSays(contact.id, CPF);
      await customerSays(contact.id, "Maria Silva");
      await customerSays(contact.id, "Rua das Flores 100");
      await customerSays(contact.id, "não");
      const conversation = await closeAndFollowUp(contact.id, "não, era só isso");
      const closed = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(closed).toMatchObject({ status: "CLOSED", assignedAgentId: assistant.id, closedByUserId: assistant.id, closeReason: "AI_ASSISTANT" });
      expect(closed.acceptedAt).not.toBeNull();
      expect(closed.firstResponseAt).not.toBeNull();
      const survey = await surveyOf(conversation.id);
      expect(survey?.agentId).toBe(assistant.id);
      // Messages of the assistant count as its own (Relatórios › Mensagens enviadas).
      expect(await prisma.message.count({ where: { conversationId: conversation.id, senderAgentId: assistant.id } })).toBeGreaterThan(3);
    });

    it("etiqueta que bloqueia a pesquisa: encerra sem pesquisa", async () => {
      const contact = await newCustomer();
      const tag = await prisma.tag.create({ data: { name: `Sem pesquisa ${Date.now()}`, blockedAutoMessages: ["SURVEY"] } });
      await prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
      const conversation = await closeAndFollowUp(contact.id, "pode encerrar o atendimento");
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("CLOSED");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await prisma.satisfactionSurvey.count({ where: { conversationId: conversation.id } })).toBe(0);
    });

    it("cliente pede para sair no meio do CPF: encerra na hora, com a pesquisa", async () => {
      const contact = await newCustomer();
      await customerSays(contact.id, "boleto");
      const conversation = await closeAndFollowUp(contact.id, "quero sair da conversa");
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("CLOSED");
      expect(await surveyOf(conversation.id)).not.toBeNull();
      const note = await prisma.conversationNote.findFirstOrThrow({ where: { conversationId: conversation.id, body: { startsWith: "Assistente Virtual" } } });
      expect(note.body).toContain("cliente pediu para encerrar");
    });

    it("\"encerrar meu contrato\" não encerra a conversa: é assunto para a equipe", async () => {
      const contact = await newCustomer();
      llm.intent = { intent: "OUTRO", summary: "quer cancelar o contrato" };
      const conversation = await customerSays(contact.id, "quero encerrar meu contrato");
      expect(conversation.status).toBe("NEW");
      expect(conversation.assignedAgentId).toBeNull();
      expect(conversation.acceptedAt).toBeNull();
    });

    it("aparece nos relatórios por atendente como qualquer atendente (conversas, mensagens e pesquisas)", async () => {
      const assistant = await getAssistantUser();
      // The customer answered one of the assistant's surveys with 10.
      const survey = await prisma.satisfactionSurvey.findFirstOrThrow({ where: { agentId: assistant.id } });
      await prisma.satisfactionSurvey.update({ where: { id: survey.id }, data: { score: 10, answeredAt: new Date() } });
      const rows = await getPerAgentReport({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
      const row = rows.find((r) => r.Atendente === assistant.displayName);
      expect(row).toBeDefined();
      expect(row!.Conversas).toBeGreaterThanOrEqual(3);
      expect(row!["Mensagens enviadas"]).toBeGreaterThan(0);
      expect(row!["Avaliações recebidas"]).toBeGreaterThanOrEqual(1);
      expect(row!["NPS (0 a 100)"]).toBe(100);
    });

    it("o usuário do assistente não entra, não aparece em Usuários e não pode ser alterado lá", async () => {
      const assistant = await getAssistantUser();
      expect(assistant).toMatchObject({ status: "INACTIVE", role: "AGENT", isAssistant: true });
      await createTestUser({ email: "admin-usr@test.dev", role: "ADMIN" });
      const token = (await request(app).post("/api/auth/login").send({ email: "admin-usr@test.dev", password: TEST_PASSWORD })).body.accessToken as string;
      const list = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`);
      expect(list.body.some((u: { id: string }) => u.id === assistant.id)).toBe(false);
      const activate = await request(app).post(`/api/users/${assistant.id}/activate`).set("Authorization", `Bearer ${token}`);
      expect(activate.status).toBe(400);
      expect((await request(app).post("/api/auth/login").send({ email: assistant.email, password: "x" })).status).not.toBe(200);
    });
  });

  describe("beneficiário pedindo o boleto do titular", () => {
    it("áudio pedindo boleto: pergunta de qual CPF; CPF sem boleto → pede o do titular → envia o boleto certo", async () => {
      const contact = await newCustomer();
      llm.transcription = "oi bom dia eu queria o boleto";
      await customerSays(contact.id, "", "AUDIO");
      expect(await lastText(contact.id)).toContain("Para enviar o boleto, me informe o CPF do titular do plano");

      // Gives their own CPF (beneficiary): confirmed, but nothing to pay there.
      await customerSays(contact.id, "111.444.777-35");
      await customerSays(contact.id, "João Santos");
      await customerSays(contact.id, "Rua B 50 centro");
      expect(await lastText(contact.id)).toContain("Não encontrei parcelas em aberto para o CPF ***.444.777-**");
      expect(await lastText(contact.id)).toContain("envie o CPF dela");

      // Then the titular's CPF: confirmed with the titular's name and address, and the boletos are hers.
      await customerSays(contact.id, "então manda do cpf da minha mãe 529.982.247-25");
      expect(await lastText(contact.id)).toContain("nome completo");
      await customerSays(contact.id, "Maria Aparecida da Silva");
      await customerSays(contact.id, "rua das flores 100 centro");
      expect(await lastText(contact.id)).toContain("janeiro/2026");
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" } });
      expect(conversation.dataCpfKey).toBe(CPF);
      // Both CPFs now have this phone to add to the record.
      expect(await prisma.clientDataCorrection.count({ where: { contactId: contact.id, contactPhone: { not: null } } })).toBe(2);
    });

    it("CPF já na primeira mensagem: vai direto para a confirmação do nome", async () => {
      const contact = await newCustomer();
      await customerSays(contact.id, "quero o boleto do cpf 529.982.247-25");
      expect(await lastText(contact.id)).toContain("nome completo");
    });

    it("sem boleto no CPF e o cliente responde não: pergunta se pode ajudar em algo mais", async () => {
      const contact = await newCustomer();
      await customerSays(contact.id, "tenho débito?");
      await customerSays(contact.id, BENEFICIARY_CPF);
      await customerSays(contact.id, "João Beneficiário Santos");
      await customerSays(contact.id, "Rua B, 50");
      expect(await lastText(contact.id)).toContain("Não encontrei parcelas em aberto");
      await customerSays(contact.id, "não");
      expect(await lastText(contact.id)).toContain("algo mais");
    });
  });

  describe("Fase A: mais humano e mais seguro", () => {
    it("usa o primeiro nome do cliente e a saudação do horário", async () => {
      const contact = await newCustomer();
      await prisma.contact.update({ where: { id: contact.id }, data: { name: "maria eduarda 🌻" } });
      await customerSays(contact.id, "oi");
      expect((await texts(contact.id))[0]).toMatch(/^\*Assistente Virtual:\*\n\n(Bom dia|Boa tarde|Boa noite), Maria! Sou o assistente virtual/);
    });

    it("CPF mandado antes de dizer o que quer: pergunta o serviço e usa o CPF sem pedir de novo", async () => {
      const contact = await newCustomer();
      await customerSays(contact.id, "oi");
      await customerSays(contact.id, "529.982.247-25");
      expect(await lastText(contact.id)).toContain("Recebi o CPF ***.982.247-**");
      await customerSays(contact.id, "boleto");
      expect(await lastText(contact.id)).toContain("nome completo");
    });

    it("\"errei o CPF\" no meio da confirmação: volta a pedir o CPF; com o CPF certo na mesma mensagem, segue com ele", async () => {
      const contact = await newCustomer();
      await customerSays(contact.id, "boleto");
      await customerSays(contact.id, BENEFICIARY_CPF);
      expect(await lastText(contact.id)).toContain("nome completo");
      await customerSays(contact.id, "ops errei o cpf");
      expect(await lastText(contact.id)).toContain("CPF certo");
      await customerSays(contact.id, CPF);
      await customerSays(contact.id, "Maria Silva");
      expect(await lastText(contact.id)).toContain("endereço");
      await customerSays(contact.id, "errei, o certo é 111.444.777-35");
      expect(await lastText(contact.id)).toContain("nome completo");
    });

    it("limite de CPF por telefone: depois de 5 CPFs que não conferem em 24 h, para e passa para a equipe (mesmo em outra conversa)", async () => {
      const contact = await newCustomer();
      const conversation = await customerSays(contact.id, "boleto");
      for (let i = 0; i < 5; i++) {
        await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "AI_CPF_FAILED", payload: { reason: "NOT_FOUND" } } });
      }
      const after = await customerSays(contact.id, CPF);
      expect(after.status).toBe("NEW");
      expect(await lastText(contact.id)).toContain("Por segurança");
      expect((await texts(contact.id)).join(" ")).not.toContain("nome completo");
    });

    it("nome que não confere conta como tentativa de CPF", async () => {
      const contact = await newCustomer();
      const conversation = await customerSays(contact.id, "boleto");
      await customerSays(contact.id, CPF);
      await customerSays(contact.id, "Fulano de Tal");
      expect(await prisma.conversationEvent.count({ where: { conversationId: conversation.id, type: "AI_CPF_FAILED" } })).toBe(1);
    });
  });
});
