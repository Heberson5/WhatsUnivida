import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser } from "./helpers";
import * as conversationsService from "../src/modules/conversations/conversations.service";

describe("@menção no primeiro contato do cliente direciona direto para o atendente, pulando a fila", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("assigns straight to the mentioned agent — IN_PROGRESS, not NEW, never touches the queue", async () => {
    const everson = await createTestUser({ email: "everson@test.dev", role: "AGENT", displayName: "Everson", whatsappConnectionId: connectionId });
    const contact = await prisma.contact.create({ data: { phone: "5511900001111", whatsappConnectionId: connectionId } });

    const { conversation, isNewConversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "Bom dia, quero falar com @Everson sobre meu pedido"
    );

    expect(isNewConversation).toBe(true);
    expect(autoAssignedAgentId).toBe(everson.id);
    expect(conversation.status).toBe("IN_PROGRESS");
    expect(conversation.assignedAgentId).toBe(everson.id);
    expect(conversation.acceptedAt).not.toBeNull();

    const assignment = await prisma.conversationAssignment.findFirst({ where: { conversationId: conversation.id } });
    expect(assignment?.reason).toBe("MENTION");
    expect(assignment?.toAgentId).toBe(everson.id);
  });

  it("matches even when the customer skips accents/case and mentions the agent mid-sentence", async () => {
    const agent = await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "João", whatsappConnectionId: connectionId });
    const contact = await prisma.contact.create({ data: { phone: "5511900002222", whatsappConnectionId: connectionId } });

    const { autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "oi, seria possível falar com o @joao?"
    );

    expect(autoAssignedAgentId).toBe(agent.id);
  });

  it("ignores WhatsApp-connection boundaries — routes to the mentioned agent even if they normally work a different connection", async () => {
    const otherConnection = await createTestConnection("Vendas");
    const agentOnVendas = await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: otherConnection.id });
    // The message arrives on "Suporte", but Maria only ever works "Vendas".
    const contact = await prisma.contact.create({ data: { phone: "5511900003333", whatsappConnectionId: connectionId } });

    const { conversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "@Maria pode me ajudar?"
    );

    expect(autoAssignedAgentId).toBe(agentOnVendas.id);
    expect(conversation.whatsappConnectionId).toBe(connectionId); // stays on the connection it actually arrived on
    expect(conversation.assignedAgentId).toBe(agentOnVendas.id);
  });

  it("never matches a MANAGER or ADMIN — agent-only mentions", async () => {
    await createTestUser({ email: "gestora@test.dev", role: "MANAGER", displayName: "Gestora" });
    const contact = await prisma.contact.create({ data: { phone: "5511900004444", whatsappConnectionId: connectionId } });

    const { isNewConversation, autoAssignedAgentId, conversation } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "@Gestora, pode me atender?"
    );

    expect(autoAssignedAgentId).toBeNull();
    expect(isNewConversation).toBe(true);
    expect(conversation.status).toBe("NEW");
    expect(conversation.assignedAgentId).toBeNull();
  });

  it("falls through to the normal queue when the mentioned name matches no active agent (typo, inactive, or nonexistent)", async () => {
    await createTestUser({ email: "carlos@test.dev", role: "AGENT", displayName: "Carlos", whatsappConnectionId: connectionId, status: "INACTIVE" });
    const contact = await prisma.contact.create({ data: { phone: "5511900005555", whatsappConnectionId: connectionId } });

    const { conversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "@Carlos, tudo bem?" // exists, but INACTIVE — must not match
    );

    expect(autoAssignedAgentId).toBeNull();
    expect(conversation.status).toBe("NEW");

    const { autoAssignedAgentId: typoResult } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      (await prisma.contact.create({ data: { phone: "5511900006666", whatsappConnectionId: connectionId } })).id,
      "@AlguemQueNaoExiste, oi"
    );
    expect(typoResult).toBeNull();
  });

  it("falls through to the queue on an ambiguous mention — two active agents share the exact same display name", async () => {
    await createTestUser({ email: "ana1@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    await createTestUser({ email: "ana2@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    const contact = await prisma.contact.create({ data: { phone: "5511900007777", whatsappConnectionId: connectionId } });

    const { autoAssignedAgentId, conversation } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "@Ana, oi!"
    );

    expect(autoAssignedAgentId).toBeNull();
    expect(conversation.status).toBe("NEW");
  });

  it("prefers the longer name when one active agent's name is a prefix of another's", async () => {
    const joao = await createTestUser({ email: "joao2@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const joaoPereira = await createTestUser({ email: "joaopereira@test.dev", role: "AGENT", displayName: "Joao Pereira", whatsappConnectionId: connectionId });

    const contactA = await prisma.contact.create({ data: { phone: "5511900008888", whatsappConnectionId: connectionId } });
    const { autoAssignedAgentId: longMatch } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contactA.id,
      "quero falar com @Joao Pereira, por favor"
    );
    expect(longMatch).toBe(joaoPereira.id);

    const contactB = await prisma.contact.create({ data: { phone: "5511900009999", whatsappConnectionId: connectionId } });
    const { autoAssignedAgentId: shortMatch } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contactB.id,
      "quero falar com @Joao, por favor"
    );
    expect(shortMatch).toBe(joao.id);
  });

  it("does not apply once the contact already has an active conversation — a later message never auto-transfers it", async () => {
    const agent = await createTestUser({ email: "pedro@test.dev", role: "AGENT", displayName: "Pedro", whatsappConnectionId: connectionId });
    await createTestUser({ email: "lucas@test.dev", role: "AGENT", displayName: "Lucas", whatsappConnectionId: connectionId });
    const contact = await prisma.contact.create({ data: { phone: "5511900010101", whatsappConnectionId: connectionId } });
    const existing = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        whatsappConnectionId: connectionId,
        status: "IN_PROGRESS",
        assignedAgentId: agent.id,
        enteredQueueAt: new Date(),
        lastMessageAt: new Date(),
      },
    });

    const { conversation, isNewConversation } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "na verdade prefiro falar com @Lucas"
    );

    expect(isNewConversation).toBe(false);
    expect(conversation.id).toBe(existing.id);
    expect(conversation.assignedAgentId).toBe(agent.id); // unchanged — still Pedro, not Lucas
  });
});
