import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser } from "./helpers";
import { closeConversation, closeConversationFromGestao, returnConversationToQueue, undoLastConversationAction } from "../src/modules/conversations/conversations.service";

describe("Desfazer encerramento / volta para a fila", () => {
  let connectionId: string;
  let agentId: string;
  let managerId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
    agentId = (await createTestUser({ email: "ana@test.dev", role: "AGENT", whatsappConnectionId: connectionId })).id;
    managerId = (await createTestUser({ email: "gestor@test.dev", role: "MANAGER" })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function attended(phone: string) {
    const contact = await prisma.contact.create({ data: { phone, whatsappConnectionId: connectionId } });
    return prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: agentId, enteredQueueAt: new Date(), acceptedAt: new Date(), lastMessageAt: new Date() },
    });
  }

  it("o atendente reabre a conversa que acabou de encerrar", async () => {
    const conversation = await attended("5511900000001");
    await closeConversation(conversation.id, agentId);
    const reopened = await undoLastConversationAction(conversation.id, agentId);
    expect(reopened.status).toBe("IN_PROGRESS");
    expect(reopened.closedAt).toBeNull();
    expect(reopened.assignedAgentId).toBe(agentId);
  });

  it("só quem encerrou pode desfazer, e só uma vez", async () => {
    const conversation = await attended("5511900000002");
    await closeConversation(conversation.id, agentId);
    await expect(undoLastConversationAction(conversation.id, managerId)).rejects.toMatchObject({ status: 409 });
    await undoLastConversationAction(conversation.id, agentId);
    await expect(undoLastConversationAction(conversation.id, agentId)).rejects.toMatchObject({ status: 409 });
  });

  it("não desfaz depois da janela", async () => {
    const conversation = await attended("5511900000003");
    await closeConversation(conversation.id, agentId);
    await prisma.conversationEvent.updateMany({ where: { conversationId: conversation.id, type: "CLOSED" }, data: { createdAt: new Date(Date.now() - 60_000) } });
    await expect(undoLastConversationAction(conversation.id, agentId)).rejects.toMatchObject({ status: 409 });
  });

  it("a gestão devolve ao atendente uma conversa que mandou para a fila, se ninguém aceitou", async () => {
    const conversation = await attended("5511900000004");
    await returnConversationToQueue(conversation.id, managerId);
    const back = await undoLastConversationAction(conversation.id, managerId);
    expect(back.status).toBe("IN_PROGRESS");
    expect(back.assignedAgentId).toBe(agentId);
  });

  it("a gestão reabre uma conversa que encerrou", async () => {
    const conversation = await attended("5511900000005");
    await closeConversationFromGestao(conversation.id, managerId);
    const reopened = await undoLastConversationAction(conversation.id, managerId);
    expect(reopened.status).toBe("IN_PROGRESS");
  });
});
