import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import * as messagesService from "../src/modules/messages/messages.service";
import { resetDatabase, createTestConnection, createWaitingConversation } from "./helpers";

describe("messages sent directly from the linked phone (fromMe, outside this app)", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("records a genuinely new message sent from the phone as OUTBOUND with no agent attached", async () => {
    const { conversation } = await createWaitingConversation("5511999998888", connectionId);
    const timestamp = new Date("2026-01-10T12:00:00Z");

    const message = await messagesService.createOutboundMessageFromDevice({
      conversationId: conversation.id,
      providerMessageId: "device-msg-1",
      type: "TEXT",
      body: "Oi, já te atendo",
      timestamp,
    });

    expect(message).not.toBeNull();
    expect(message!.direction).toBe("OUTBOUND");
    expect(message!.senderAgentId).toBeNull();
    expect(message!.status).toBe("SENT");
    expect(message!.providerMessageId).toBe("device-msg-1");
    expect(message!.createdAt.toISOString()).toBe(timestamp.toISOString());

    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(updated.lastMessageAt.toISOString()).toBe(timestamp.toISOString());
    expect(updated.lastMessageDirection).toBe("OUTBOUND");
  });

  it("does nothing (no duplicate) when the providerMessageId was already recorded by this app's own send flow", async () => {
    const { conversation } = await createWaitingConversation("5511999997777", connectionId);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "IN_PROGRESS" } });
    // Simulates what the agent-initiated send flow already wrote before
    // WhatsApp echoes the same message back through the live event stream.
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        type: "TEXT",
        status: "SENT",
        body: "Mensagem enviada pelo app",
        providerMessageId: "app-msg-1",
      },
    });

    const result = await messagesService.createOutboundMessageFromDevice({
      conversationId: conversation.id,
      providerMessageId: "app-msg-1",
      type: "TEXT",
      body: "Mensagem enviada pelo app",
      timestamp: new Date(),
    });

    expect(result).toBeNull();
    const count = await prisma.message.count({ where: { conversationId: conversation.id } });
    expect(count).toBe(1);
  });
});
