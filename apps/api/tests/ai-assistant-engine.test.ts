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
import { DEFAULT_AI_ASSISTANT_SETTINGS } from "@whatsatendende/types";

const app = createApp();

const HEADER =
  "telefone_whatsapp,codigo_cliente,nome_cliente,cpf_cnpj,endereco,cidade,cep,numero_contrato,documento,vencimento_parcela,dias_em_atraso,saldo,forma_pagamento,vencimento_boleto,valor_boleto,nosso_numero,banco_codigo,convenio,carteira,agencia_beneficiario,conta_beneficiario,beneficiario_nome";
// The spreadsheet has the client on ANOTHER phone: the assistant finds them by the CPF.
const ROWS = [
  "5565999991111,1,Maria Aparecida da Silva,529.982.247-25,\"Rua das Flores, 100, Centro\",Tangará da Serra,78300-000,C-10,D-1,10/01/2026,280,90.00,Boleto,10/01/2026,90.00,12345670000000101,001,1234567,17,1234-5,99999-9,Empresa Teste",
  "5565999991111,1,Maria Aparecida da Silva,529.982.247-25,\"Rua das Flores, 100, Centro\",Tangará da Serra,78300-000,C-10,D-2,10/02/2026,251,90.00,Boleto,10/02/2026,90.00,12345670000000102,001,1234567,17,1234-5,99999-9,Empresa Teste",
  "5565999991111,1,Maria Aparecida da Silva,529.982.247-25,\"Rua das Flores, 100, Centro\",Tangará da Serra,78300-000,C-10,D-3,10/12/2030,0,90.00,Boleto,10/12/2030,90.00,12345670000000103,001,1234567,17,1234-5,99999-9,Empresa Teste",
];
const CUSTOMER = "5565988887777";
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
    expect((await texts(contact.id))[0]).toMatch(/^\*Assistente Virtual:\* Olá!/);
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
    expect(await prisma.clientDataCorrection.count()).toBe(0);
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

    // Next time: the boleto without asking CPF, name or address again.
    await resetSent();
    await customerSays(contact.id, "boa tarde, preciso do boleto");
    expect((await texts(contact.id)).join(" ")).not.toContain("CPF do titular");
    expect((await lastText(contact.id))).toContain("parcelas em aberto");
  });

  it("pedir atendente (texto) dentro do expediente: avisa e vai para a fila; depois não responde mais", async () => {
    const contact = await newCustomer();
    const conversation = await customerSays(contact.id, "quero falar com um atendente");
    expect(conversation.status).toBe("NEW");
    expect((await lastText(contact.id))).toBe("*Assistente Virtual:* Vou transferir você para um de nossos atendentes. Em instantes alguém irá atendê-lo.");
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
    expect((await texts(contact.id))[0]).toContain("Olá");
    const conversation = await customerSays(contact.id, "me passa para uma atendente por favor");
    expect(conversation.status).toBe("NEW");
    expect((await lastText(contact.id))).toBe("*Assistente Virtual:* Estamos fora do expediente, Cliente. Voltamos amanhã às 8h.");
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

  it("áudio que não deu para transcrever: avisa e passa para a fila com nota", async () => {
    const contact = await newCustomer();
    await customerSays(contact.id, "oi");
    llm.transcription = null;
    const conversation = await customerSays(contact.id, "", "AUDIO");
    expect(conversation.status).toBe("NEW");
    expect((await texts(contact.id)).join(" ")).toContain("Não consegui ouvir o seu áudio");
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
      expect(await lastText(contact.id)).toContain("Olá");

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
});
