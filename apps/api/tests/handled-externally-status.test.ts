import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import { resetDatabase, createTestConnection, createTestUser, createWaitingConversation } from "./helpers";

describe("reading a conversation from the linked phone (markConversationReadFromDevice)", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("moves a still-queued (WAITING) conversation to HANDLED_EXTERNALLY, leaving the queue with no assigned agent", async () => {
    const { conversation } = await createWaitingConversation("5511990007777", connectionId);

    const result = await conversationsService.markConversationReadFromDevice(conversation.id);
    expect(result).toEqual({ leftQueue: true });

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(updated.status).toBe("HANDLED_EXTERNALLY");
    expect(updated.assignedAgentId).toBeNull();
    expect(updated.assignedAgentReadAt).not.toBeNull();

    const queue = await conversationsService.listQueue([connectionId]);
    expect(queue.find((c) => c.id === conversation.id)).toBeUndefined();

    const event = await prisma.conversationEvent.findFirst({ where: { conversationId: conversation.id, type: "HANDLED_EXTERNALLY" } });
    expect(event).not.toBeNull();
  });

  it("leaves an already-assigned (IN_PROGRESS) conversation's status alone — only updates the read marker", async () => {
    const { conversation } = await createWaitingConversation("5511990008888", connectionId);
    const agent = await createTestUser({ email: "agente-he@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    await conversationsService.acceptConversation(conversation.id, agent.id);

    const result = await conversationsService.markConversationReadFromDevice(conversation.id);
    expect(result).toEqual({ leftQueue: false });

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.assignedAgentId).toBe(agent.id);
    expect(updated.assignedAgentReadAt).not.toBeNull();
  });

  it("moves a still-queued (WAITING) conversation to HANDLED_EXTERNALLY when replied to from the linked phone, same as reading it", async () => {
    const { contact, conversation } = await createWaitingConversation("5511990006666", connectionId);

    const result = await conversationsService.findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);
    expect(result.isNewConversation).toBe(false);
    expect(result.leftQueue).toBe(true);
    expect(result.conversation.id).toBe(conversation.id);
    expect(result.conversation.status).toBe("HANDLED_EXTERNALLY");
    expect(result.conversation.assignedAgentId).toBeNull();
    expect(result.conversation.assignedAgentReadAt).not.toBeNull();

    const queue = await conversationsService.listQueue([connectionId]);
    expect(queue.find((c) => c.id === conversation.id)).toBeUndefined();

    const event = await prisma.conversationEvent.findFirst({ where: { conversationId: conversation.id, type: "HANDLED_EXTERNALLY" } });
    expect(event).not.toBeNull();
  });

  it("leaves an already-assigned (IN_PROGRESS) conversation's status alone when replied to from the phone — only refreshes the read marker", async () => {
    const { contact, conversation } = await createWaitingConversation("5511990005555", connectionId);
    const agent = await createTestUser({ email: "agente-devicereply@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    await conversationsService.acceptConversation(conversation.id, agent.id);

    const result = await conversationsService.findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);
    expect(result.isNewConversation).toBe(false);
    expect(result.leftQueue).toBe(false);
    expect(result.conversation.status).toBe("IN_PROGRESS");
    expect(result.conversation.assignedAgentId).toBe(agent.id);
    expect(result.conversation.assignedAgentReadAt).not.toBeNull();
  });

  it("a further message from the same contact after HANDLED_EXTERNALLY reuses the SAME conversation, unlike CLOSED", async () => {
    // Unlike CLOSED, HANDLED_EXTERNALLY isn't a deliberate "attendance
    // finished" action by an agent — it just means the customer's thread is
    // being handled directly on the linked phone. Treating it as terminal
    // used to spawn a brand-new Conversation row on every single message
    // exchanged from then on (inbound or another device reply), turning one
    // ongoing WhatsApp thread into dozens of near-empty rows in Gestão — see
    // PROMPT: "em Gestão ... está trazendo mais de uma linha para a mesma
    // conversa, isso significa que a cada mensagem recebida ou enviada, está
    // acrescentando uma nova linha".
    const { contact, conversation } = await createWaitingConversation("5511990009999", connectionId);
    await conversationsService.markConversationReadFromDevice(conversation.id);

    const { conversation: reopened, isNewConversation } = await conversationsService.findOrOpenConversationForInboundMessage(
      connectionId,
      contact.id
    );
    expect(isNewConversation).toBe(false);
    expect(reopened.id).toBe(conversation.id);
    expect(reopened.status).toBe("HANDLED_EXTERNALLY");
  });
});
