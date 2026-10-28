import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import * as messagesService from "../src/modules/messages/messages.service";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import { toMessageDTO } from "../src/modules/messages/messages.mapper";
import { resetDatabase, createTestConnection, createTestUser, createWaitingConversation } from "./helpers";

describe("replying to a WhatsApp Status/Story shows a preview marker, never a link to navigate to it", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("records a customer's reply to a text story with the story's own embedded text as the preview", async () => {
    const { conversation } = await createWaitingConversation("5511990001111", connectionId);

    const message = await messagesService.createInboundMessage({
      conversationId: conversation.id,
      providerMessageId: "story-reply-1",
      type: "TEXT",
      body: "Adorei essa novidade!",
      isQuotedStoryReply: true,
      quotedStoryText: "Chegou a nova coleção 🎉",
      quotedStoryThumbnailBase64: null,
    });

    expect(message.isStoryReply).toBe(true);
    expect(message.storyReplyText).toBe("Chegou a nova coleção 🎉");
    expect(message.storyReplyThumbnail).toBeNull();

    const dto = toMessageDTO(message);
    expect(dto.replyToStory).toEqual({ text: "Chegou a nova coleção 🎉", thumbnailUrl: null });
    // A normal reply-to-message id must never be confused with a story reply.
    expect(dto.replyToMessageId).toBeNull();
  });

  it("records a reply to a media story with its low-res thumbnail as a data: URL, no fetch/download involved", async () => {
    const { conversation } = await createWaitingConversation("5511990002222", connectionId);

    const message = await messagesService.createInboundMessage({
      conversationId: conversation.id,
      providerMessageId: "story-reply-2",
      type: "TEXT",
      body: "Que foto linda!",
      isQuotedStoryReply: true,
      quotedStoryText: null,
      quotedStoryThumbnailBase64: "ZmFrZS1qcGVn", // "fake-jpeg" in base64 — stands in for a real thumbnail
    });

    const dto = toMessageDTO(message);
    expect(dto.replyToStory).toEqual({ text: null, thumbnailUrl: "data:image/jpeg;base64,ZmFrZS1qcGVn" });
  });

  it("still marks a story reply even when WhatsApp's embedded preview carried neither text nor a thumbnail (e.g. a sticker story)", async () => {
    const { conversation } = await createWaitingConversation("5511990003333", connectionId);

    const message = await messagesService.createInboundMessage({
      conversationId: conversation.id,
      providerMessageId: "story-reply-3",
      type: "TEXT",
      body: "👍",
      isQuotedStoryReply: true,
    });

    expect(message.isStoryReply).toBe(true);
    const dto = toMessageDTO(message);
    expect(dto.replyToStory).toEqual({ text: null, thumbnailUrl: null });
  });

  it("a message that isn't a story reply never carries the marker, even with an ordinary reply-to-message", async () => {
    const { conversation } = await createWaitingConversation("5511990004444", connectionId);
    const first = await messagesService.createInboundMessage({
      conversationId: conversation.id,
      providerMessageId: "regular-1",
      type: "TEXT",
      body: "Qual o horario de funcionamento?",
    });

    const reply = await messagesService.createInboundMessage({
      conversationId: conversation.id,
      providerMessageId: "regular-2",
      type: "TEXT",
      body: "Isso mesmo",
      replyToProviderMessageId: "regular-1",
    });

    expect(reply.isStoryReply).toBe(false);
    const dto = toMessageDTO(reply);
    expect(dto.replyToStory).toBeNull();
    expect(dto.replyToMessageId).toBe(first.id);
  });

  it("a device-sent reply (from the linked phone, outside this app) to a story is recorded the same way", async () => {
    const { conversation } = await createWaitingConversation("5511990005555", connectionId);

    const message = await messagesService.createOutboundMessageFromDevice({
      conversationId: conversation.id,
      providerMessageId: "device-story-reply-1",
      type: "TEXT",
      body: "Muito bom!",
      timestamp: new Date(),
      isQuotedStoryReply: true,
      quotedStoryText: "Promoção de hoje",
    });

    expect(message).not.toBeNull();
    expect(message!.isStoryReply).toBe(true);
    expect(message!.storyReplyText).toBe("Promoção de hoje");
  });
});

describe("link-preview card for a message whose text contains a URL (WhatsApp Web parity)", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores and maps a customer's inbound link-preview metadata (already generated by their own phone)", async () => {
    const { conversation } = await createWaitingConversation("5511991001111", connectionId);

    const message = await messagesService.createInboundMessage({
      conversationId: conversation.id,
      providerMessageId: "link-msg-1",
      type: "TEXT",
      body: "Olha isso: https://exemplo.com/produto",
      linkPreviewTitle: "Produto incrível",
      linkPreviewDescription: "A melhor oferta do mes",
      linkPreviewUrl: "https://exemplo.com/produto",
      linkPreviewThumbnailBase64: "dGh1bWJuYWls",
    });

    expect(message.linkPreviewTitle).toBe("Produto incrível");
    const dto = toMessageDTO(message);
    expect(dto.linkPreview).toEqual({
      title: "Produto incrível",
      description: "A melhor oferta do mes",
      url: "https://exemplo.com/produto",
      thumbnailUrl: "data:image/jpeg;base64,dGh1bWJuYWls",
    });
  });

  it("has no link-preview card when the message carries no URL metadata — the plain text still renders, just without a card", async () => {
    const { conversation } = await createWaitingConversation("5511991002222", connectionId);

    const message = await messagesService.createInboundMessage({
      conversationId: conversation.id,
      providerMessageId: "link-msg-2",
      type: "TEXT",
      body: "Sem link nenhum aqui.",
    });

    const dto = toMessageDTO(message);
    expect(dto.linkPreview).toBeNull();
  });

  it("markMessageSent persists the link-preview card generated for an agent's own outbound send", async () => {
    const { conversation } = await createWaitingConversation("5511991003333", connectionId);
    const agent = await createTestUser({ email: "agente-link1@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    await conversationsService.acceptConversation(conversation.id, agent.id);
    const pending = await messagesService.createOutboundMessage({
      conversationId: conversation.id,
      agentId: agent.id,
      type: "TEXT",
      body: "Confira: https://exemplo.com/promo",
    });

    const sent = await messagesService.markMessageSent(pending.id, "provider-msg-1", {
      title: "Promoção especial",
      description: "Só hoje",
      url: "https://exemplo.com/promo",
      thumbnailBase64: "cHJvbW8tdGh1bWI=",
    });

    expect(sent.status).toBe("SENT");
    const dto = toMessageDTO(sent);
    expect(dto.linkPreview).toEqual({
      title: "Promoção especial",
      description: "Só hoje",
      url: "https://exemplo.com/promo",
      thumbnailUrl: "data:image/jpeg;base64,cHJvbW8tdGh1bWI=",
    });
  });

  it("markMessageSent without a link-preview argument (the common case) leaves the message with none", async () => {
    const { conversation } = await createWaitingConversation("5511991004444", connectionId);
    const agent = await createTestUser({ email: "agente-link2@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    await conversationsService.acceptConversation(conversation.id, agent.id);
    const pending = await messagesService.createOutboundMessage({
      conversationId: conversation.id,
      agentId: agent.id,
      type: "TEXT",
      body: "Sem link nesta mensagem",
    });

    const sent = await messagesService.markMessageSent(pending.id, "provider-msg-2");

    expect(toMessageDTO(sent).linkPreview).toBeNull();
  });
});
