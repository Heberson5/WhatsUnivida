import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser } from "./helpers";

const sent: { connectionId: string; phone: string; text: string }[] = [];
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    sendAutomatedText: vi.fn(async (connectionId: string, _messageId: string, phone: string, text: string) => {
      sent.push({ connectionId, phone, text });
    }),
  };
});

// Loaded before conversations.service so it binds to the mocked whatsapp.service (the modules import each other).
import { handleInboundForFlow, isWithinBusinessHours, matchMenuOption } from "../src/modules/flows/flow-engine.service";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import * as flowsService from "../src/modules/flows/flows.service";


describe("Fluxo: motor de execução", () => {
  let connectionId: string;
  let adminId: string;

  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    connectionId = (await createTestConnection("Suporte QR")).id;
    adminId = (await createTestUser({ email: "admin@test.dev", role: "ADMIN" })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function activeWelcomeFlow() {
    const flow = await flowsService.createFlow({ name: "Boas-vindas", template: "welcome", connectionIds: [connectionId] }, adminId);
    await flowsService.updateFlowMeta(flow.id, { active: true });
    return flow.id;
  }

  async function customerWrites(phone: string, text: string) {
    const contact = await prisma.contact.upsert({ where: { id: phone }, update: {}, create: { id: phone, phone, name: "Ana", whatsappConnectionId: connectionId } });
    const opened = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, text);
    if (opened.conversation.status === "IN_FLOW") await handleInboundForFlow(opened.conversation.id, opened.flowId, text);
    return prisma.conversation.findUniqueOrThrow({ where: { id: opened.conversation.id } });
  }

  it("does nothing without an active flow — the conversation goes straight to the queue", async () => {
    await flowsService.createFlow({ name: "Rascunho", template: "welcome", connectionIds: [connectionId] }, adminId);
    const conversation = await customerWrites("5511900000001", "Oi");
    expect(conversation.status).toBe("NEW");
    expect(sent).toHaveLength(0);
  });

  it("greets, shows the menu and waits; the answer hands the conversation to the queue", async () => {
    await activeWelcomeFlow();
    const first = await customerWrites("5511900000002", "Oi");
    expect(first.status).toBe("IN_FLOW");
    expect(sent.map((m) => m.text)).toEqual([
      "Olá, Ana! 👋 Bem-vindo ao nosso atendimento.",
      "Escolha uma opção respondendo com o número:\n1. Vendas\n2. Suporte\n3. Financeiro\n4. Encerrar atendimento",
    ]);

    const second = await customerWrites("5511900000002", "2");
    expect(second.status).toBe("NEW");
    const session = await prisma.flowSession.findUniqueOrThrow({ where: { conversationId: second.id } });
    expect(session.completedAt).not.toBeNull();
    const bot = await prisma.message.findMany({ where: { conversationId: second.id, automatedBy: "FLOW" } });
    expect(bot).toHaveLength(2);
  });

  it("repeats the menu on a wrong answer and hands over to a person after three", async () => {
    await activeWelcomeFlow();
    await customerWrites("5511900000003", "Oi");
    sent.length = 0;
    await customerWrites("5511900000003", "quero falar com alguém");
    expect(sent[0].text).toMatch(/^Não entendi\. Escolha uma opção/);
    await customerWrites("5511900000003", "???");
    const last = await customerWrites("5511900000003", "9");
    expect(sent.at(-1)!.text).toBe("Não consegui entender sua resposta. Vou encaminhar você para um atendente.");
    expect(last.status).toBe("NEW");
  });

  it("sends straight to an online selected agent", async () => {
    const agent = await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "João", presence: "ONLINE", whatsappConnectionId: connectionId });
    const flow = await flowsService.createFlow({ name: "Direto", connectionIds: [connectionId] }, adminId);
    await flowsService.saveFlowGraph(
      flow.id,
      [
        { id: "s", type: "START", positionX: 0, positionY: 0 },
        { id: "t", type: "TRANSFER_TO_AGENT", positionX: 1, positionY: 0, data: { mode: "selected", assignedAgentIds: [agent.id] } },
      ],
      [{ sourceNodeId: "s", targetNodeId: "t" }]
    );
    await flowsService.updateFlowMeta(flow.id, { active: true });

    const conversation = await customerWrites("5511900000004", "Oi");
    expect(conversation.status).toBe("IN_PROGRESS");
    expect(conversation.assignedAgentId).toBe(agent.id);
  });

  it("matches menu answers by number or by name", () => {
    const options = [
      { id: "a", label: "Vendas" },
      { id: "b", label: "Suporte técnico" },
    ];
    expect(matchMenuOption(options, "2")?.id).toBe("b");
    expect(matchMenuOption(options, "opção 1")?.id).toBe("a");
    expect(matchMenuOption(options, "suporte tecnico")?.id).toBe("b");
    expect(matchMenuOption(options, "7")).toBeNull();
    expect(matchMenuOption(options, null)).toBeNull();
  });

  it("checks business hours in the editor's own time zone", () => {
    const hours = { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", tzOffsetMinutes: 180 };
    // Monday 2026-10-05 12:00 UTC = 09:00 in Brasília
    expect(isWithinBusinessHours(hours, new Date("2026-10-05T12:00:00Z"))).toBe(true);
    // Monday 22:00 UTC = 19:00 in Brasília
    expect(isWithinBusinessHours(hours, new Date("2026-10-05T22:00:00Z"))).toBe(false);
    // Sunday
    expect(isWithinBusinessHours(hours, new Date("2026-10-04T15:00:00Z"))).toBe(false);
  });
});
