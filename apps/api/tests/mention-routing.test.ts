import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser } from "./helpers";
import * as conversationsService from "../src/modules/conversations/conversations.service";

describe("@menção do cliente direciona direto para quem atende a conexão, pulando a fila", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("assigns straight to the mentioned agent — IN_PROGRESS, not NEW, never touches the queue", async () => {
    const everson = await createTestUser({
      email: "everson@test.dev",
      role: "AGENT",
      displayName: "Everson",
      whatsappConnectionId: connectionId,
      presence: "ONLINE",
    });
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
    const agent = await createTestUser({
      email: "joao@test.dev",
      role: "AGENT",
      displayName: "João",
      whatsappConnectionId: connectionId,
      presence: "ONLINE",
    });
    const contact = await prisma.contact.create({ data: { phone: "5511900002222", whatsappConnectionId: connectionId } });

    const { autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "oi, seria possível falar com o @joao?"
    );

    expect(autoAssignedAgentId).toBe(agent.id);
  });

  it("only names people who work this connection — an agent of another number is not pulled over", async () => {
    const otherConnection = await createTestConnection("Vendas");
    await createTestUser({
      email: "maria@test.dev",
      role: "AGENT",
      displayName: "Maria",
      whatsappConnectionId: otherConnection.id,
      presence: "ONLINE",
    });
    // The message arrives on "Suporte", but Maria only ever works "Vendas".
    const contact = await prisma.contact.create({ data: { phone: "5511900003333", whatsappConnectionId: connectionId } });

    const { conversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id,
      "@Maria pode me ajudar?"
    );

    expect(autoAssignedAgentId).toBeNull();
    expect(conversation.status).toBe("NEW");
    expect(conversation.assignedAgentId).toBeNull();
  });

  it("names a manager who receives this connection's conversations, and an admin who works it", async () => {
    const gestora = await createTestUser({ email: "gestora@test.dev", role: "MANAGER", displayName: "Gestora", presence: "ONLINE" });
    await prisma.managerConnectionAccess.create({ data: { managerId: gestora.id, whatsappConnectionId: connectionId, canReceiveConversations: true } });
    const admin = await createTestUser({ email: "chefe@test.dev", role: "ADMIN", displayName: "Chefe", whatsappConnectionId: connectionId, presence: "ONLINE" });

    const c1 = await prisma.contact.create({ data: { phone: "5511900004444", whatsappConnectionId: connectionId } });
    const r1 = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, c1.id, "@Gestora, pode me atender?");
    expect(r1.autoAssignedAgentId).toBe(gestora.id);
    expect(r1.conversation.status).toBe("IN_PROGRESS");

    const c2 = await prisma.contact.create({ data: { phone: "5511900004445", whatsappConnectionId: connectionId } });
    const r2 = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, c2.id, "quero o @chefe");
    expect(r2.autoAssignedAgentId).toBe(admin.id);
  });

  it("never names a manager without access to this connection's conversations", async () => {
    await createTestUser({ email: "outra@test.dev", role: "MANAGER", displayName: "Outra Gestora", presence: "ONLINE" });
    const contact = await prisma.contact.create({ data: { phone: "5511900004446", whatsappConnectionId: connectionId } });

    const { autoAssignedAgentId, conversation } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "@Outra Gestora, oi");

    expect(autoAssignedAgentId).toBeNull();
    expect(conversation.status).toBe("NEW");
  });

  it("matches the first name alone — @João finds João Silva", async () => {
    const joao = await createTestUser({ email: "js@test.dev", role: "AGENT", displayName: "João Silva", whatsappConnectionId: connectionId, presence: "ONLINE" });
    const contact = await prisma.contact.create({ data: { phone: "5511900004447", whatsappConnectionId: connectionId } });

    const { autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "oi @joao, tudo bem?");

    expect(autoAssignedAgentId).toBe(joao.id);
  });

  it("goes to the queue when two people share the first name mentioned", async () => {
    await createTestUser({ email: "js1@test.dev", role: "AGENT", displayName: "João Silva", whatsappConnectionId: connectionId, presence: "ONLINE" });
    await createTestUser({ email: "js2@test.dev", role: "AGENT", displayName: "João Souza", whatsappConnectionId: connectionId, presence: "ONLINE" });
    const contact = await prisma.contact.create({ data: { phone: "5511900004448", whatsappConnectionId: connectionId } });

    const { autoAssignedAgentId, conversation } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "@João me ajuda");

    expect(autoAssignedAgentId).toBeNull();
    expect(conversation.status).toBe("NEW");
  });

  it("first-name typo still finds the person — @gleici for Gleicy Souza", async () => {
    const gleicy = await createTestUser({ email: "gs@test.dev", role: "AGENT", displayName: "Gleicy Souza", whatsappConnectionId: connectionId, presence: "ONLINE" });
    const contact = await prisma.contact.create({ data: { phone: "5511900004449", whatsappConnectionId: connectionId } });

    const { autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "@gleici bom dia");

    expect(autoAssignedAgentId).toBe(gleicy.id);
  });

  for (const status of ["NEW", "WAITING", "IN_FLOW", "HANDLED_EXTERNALLY"] as const) {
    it(`takes a conversation still without an agent (${status}) to the person named`, async () => {
      const ana = await createTestUser({ email: `ana-${status}@test.dev`, role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId, presence: "ONLINE" });
      const contact = await prisma.contact.create({ data: { phone: `55119000${status.length}5050`, whatsappConnectionId: connectionId } });
      const existing = await prisma.conversation.create({
        data: { contactId: contact.id, whatsappConnectionId: connectionId, status, enteredQueueAt: new Date(), lastMessageAt: new Date() },
      });

      const { conversation, isNewConversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(
        connectionId,
        contact.id,
        "@Ana pode me atender?"
      );

      expect(isNewConversation).toBe(false);
      expect(conversation.id).toBe(existing.id);
      expect(autoAssignedAgentId).toBe(ana.id);
      expect(conversation.status).toBe("IN_PROGRESS");
      expect(conversation.assignedAgentId).toBe(ana.id);
      expect(conversation.acceptedAt).not.toBeNull();
      const assignment = await prisma.conversationAssignment.findFirst({ where: { conversationId: existing.id } });
      expect(assignment?.reason).toBe("MENTION");
    });
  }

  it("a waiting customer naming someone who isn't online stays in the queue", async () => {
    await createTestUser({ email: "ana-off@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId, presence: "AWAY" });
    const contact = await prisma.contact.create({ data: { phone: "5511900006060", whatsappConnectionId: connectionId } });
    await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "NEW", enteredQueueAt: new Date(), lastMessageAt: new Date() } });

    const { conversation, autoAssignedAgentId } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "@Ana?");

    expect(autoAssignedAgentId).toBeNull();
    expect(conversation.status).toBe("NEW");
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
    await createTestUser({ email: "ana1@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId, presence: "ONLINE" });
    await createTestUser({ email: "ana2@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId, presence: "ONLINE" });
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
    const joao = await createTestUser({
      email: "joao2@test.dev",
      role: "AGENT",
      displayName: "Joao",
      whatsappConnectionId: connectionId,
      presence: "ONLINE",
    });
    const joaoPereira = await createTestUser({
      email: "joaopereira@test.dev",
      role: "AGENT",
      displayName: "Joao Pereira",
      whatsappConnectionId: connectionId,
      presence: "ONLINE",
    });

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

  it("falls through to the queue when the mentioned agent is not online — never strands the conversation with someone who isn't around to see it", async () => {
    const offlineAgent = await createTestUser({
      email: "offline@test.dev",
      role: "AGENT",
      displayName: "Renata",
      whatsappConnectionId: connectionId,
      presence: "OFFLINE",
    });
    await createTestUser({
      email: "away@test.dev",
      role: "AGENT",
      displayName: "Bianca",
      whatsappConnectionId: connectionId,
      presence: "AWAY",
    });

    const contactA = await prisma.contact.create({ data: { phone: "5511900011111", whatsappConnectionId: connectionId } });
    const { conversation: convA, autoAssignedAgentId: offlineResult } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contactA.id,
      "oi, quero falar com @Renata"
    );
    expect(offlineResult).toBeNull();
    expect(convA.status).toBe("NEW");
    expect(convA.assignedAgentId).toBeNull();

    const contactB = await prisma.contact.create({ data: { phone: "5511900012121", whatsappConnectionId: connectionId } });
    const { conversation: convB, autoAssignedAgentId: awayResult } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contactB.id,
      "oi, quero falar com @Bianca"
    );
    expect(awayResult).toBeNull();
    expect(convB.status).toBe("NEW");
    expect(convB.assignedAgentId).toBeNull();

    // Sanity check: the SAME mention text succeeds once that agent comes online.
    await prisma.user.update({ where: { id: offlineAgent.id }, data: { presence: "ONLINE" } });
    const contactC = await prisma.contact.create({ data: { phone: "5511900013131", whatsappConnectionId: connectionId } });
    const { autoAssignedAgentId: onlineResult } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contactC.id,
      "oi, quero falar com @Renata"
    );
    expect(onlineResult).toBe(offlineAgent.id);
  });

  it("does not apply once the contact is already with an agent — a later message never auto-transfers it", async () => {
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

  it("nome cadastrado com prefixo (\"Atendente - Gislaine\"): \"@Gislaine\" vai direto para ela", async () => {
    const gislaine = await createTestUser({ email: "gi@test.dev", role: "AGENT", displayName: "Atendente - Gislaine", whatsappConnectionId: connectionId, presence: "ONLINE" });
    await createTestUser({ email: "ma@test.dev", role: "AGENT", displayName: "Atendente - Mariany", whatsappConnectionId: connectionId, presence: "ONLINE" });
    const ana = await createTestUser({ email: "ap@test.dev", role: "AGENT", displayName: "Atendente - Ana Paula Souza", whatsappConnectionId: connectionId, presence: "ONLINE" });

    const find = (body: string) => conversationsService.findMentionedAgent(body, "WHATSAPP", connectionId);
    expect((await find("Quero falar com a @Gislaine"))?.id).toBe(gislaine.id);
    expect((await find("@gislaine, bom dia"))?.id).toBe(gislaine.id);
    expect((await find("@Atendente - Gislaine"))?.id).toBe(gislaine.id);
    expect((await find("@Atendente Gislaine"))?.id).toBe(gislaine.id);
    expect((await find("@Gislane por favor"))?.id).toBe(gislaine.id); // typo
    expect((await find("falar com @Ana Paula"))?.id).toBe(ana.id);
    expect((await find("falar com @ana"))?.id).toBe(ana.id);
    // The word everyone shares names nobody.
    expect(await find("@Atendente")).toBeNull();

    const contact = await prisma.contact.create({ data: { phone: "5511900009999", whatsappConnectionId: connectionId } });
    const { conversation } = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "Oi @Gislaine");
    expect(conversation.assignedAgentId).toBe(gislaine.id);
    expect(conversation.status).toBe("IN_PROGRESS");
  });

  it("sobrenome único também serve; sobrenome repetido não adivinha", async () => {
    const joao = await createTestUser({ email: "jsil@test.dev", role: "AGENT", displayName: "João Silva", whatsappConnectionId: connectionId, presence: "ONLINE" });
    await createTestUser({ email: "msou@test.dev", role: "AGENT", displayName: "Maria Souza", whatsappConnectionId: connectionId, presence: "ONLINE" });
    await createTestUser({ email: "psou@test.dev", role: "AGENT", displayName: "Pedro Souza", whatsappConnectionId: connectionId, presence: "ONLINE" });
    const find = (body: string) => conversationsService.findMentionedAgent(body, "WHATSAPP", connectionId);
    expect((await find("@Silva"))?.id).toBe(joao.id);
    expect(await find("@Souza")).toBeNull();
  });
});
