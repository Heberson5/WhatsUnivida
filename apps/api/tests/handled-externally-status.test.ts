import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import request from "supertest";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { createApp } from "../src/app";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { resetDatabase, createTestConnection, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

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

  // A conversation belongs to where it began until it is closed. PROMPT: "caso a conversa tenha sido aberta ou
  // iniciada no celular, deverá permanecer pelo celular, caso tenha iniciado ou aberta pela plataforma, deverá
  // continuar na plataforma". (Before, the customer's next message opened a second row next to the phone one.)
  describe("o cliente volta a escrever numa conversa que está pelo celular", () => {
    const conversationsOf = (contactId: string) => prisma.conversation.findMany({ where: { contactId }, orderBy: { createdAt: "asc" } });

    it("lida/aberta no celular enquanto estava na fila: a mensagem nova vai para a mesma linha, que continua pelo celular", async () => {
      const { contact, conversation } = await createWaitingConversation("5511990009999", connectionId);
      await conversationsService.markConversationReadFromDevice(conversation.id);

      const result = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "alguém aí?");
      expect(result.isNewConversation).toBe(false);
      expect(result.conversation.id).toBe(conversation.id);

      const rows = await conversationsOf(contact.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("HANDLED_EXTERNALLY");
      expect(rows[0].assignedAgentId).toBeNull();
      expect(rows[0].enteredQueueAt).toEqual(conversation.enteredQueueAt); // nothing overwritten
      expect((await conversationsService.listQueue([connectionId])).find((c) => c.id === conversation.id)).toBeUndefined();
    });

    it("respondida pelo celular: o cliente escreve de novo e continua uma linha só, pelo celular", async () => {
      const { contact, conversation } = await createWaitingConversation("5511990009998", connectionId);
      await conversationsService.findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);

      const result = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "obrigado!");
      expect(result.isNewConversation).toBe(false);
      expect(result.conversation.id).toBe(conversation.id);
      expect(await conversationsOf(contact.id)).toHaveLength(1);
      expect((await conversationsOf(contact.id))[0].status).toBe("HANDLED_EXTERNALLY");
    });

    it("iniciada pelo celular (o atendente escreveu primeiro): a resposta do cliente fica na mesma linha, sem entrar na fila", async () => {
      const contact = await conversationsService.findOrCreateContact(connectionId, "5511990009997", null, "5511990009997@s.whatsapp.net");
      const started = await conversationsService.findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);
      expect(started.isNewConversation).toBe(true);
      expect(started.conversation.status).toBe("HANDLED_EXTERNALLY");

      const result = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "oi, tudo bem?");
      expect(result.isNewConversation).toBe(false);
      expect(result.conversation.id).toBe(started.conversation.id);
      expect(await conversationsOf(contact.id)).toHaveLength(1);
      expect((await conversationsService.listQueue([connectionId])).find((c) => c.contact.id === contact.id)).toBeUndefined();
    });

    it("uma @menção nessa mensagem leva a conversa do celular para a pessoa citada", async () => {
      const { contact, conversation } = await createWaitingConversation("5511990004444", connectionId);
      const agent = await createTestUser({
        email: "agente-reopen-mention@test.dev",
        displayName: "Fernanda",
        role: "AGENT",
        whatsappConnectionId: connectionId,
        presence: "ONLINE",
      });
      await conversationsService.markConversationReadFromDevice(conversation.id);

      const result = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "Oi, pode ser a @Fernanda de novo?");
      expect(result.isNewConversation).toBe(false);
      expect(result.autoAssignedAgentId).toBe(agent.id);
      const row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(row.status).toBe("IN_PROGRESS");
      expect(row.assignedAgentId).toBe(agent.id);
      expect((await conversationsService.listMyConversations(agent.id)).find((c) => c.id === conversation.id)).toBeDefined();
    });

    it("aceita por um atendente na plataforma: continua na plataforma, mesmo aberta ou respondida no celular", async () => {
      const { contact, conversation } = await createWaitingConversation("5511990009996", connectionId);
      const agent = await createTestUser({ email: "agente-platform@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
      await conversationsService.acceptConversation(conversation.id, agent.id);

      await conversationsService.markConversationReadFromDevice(conversation.id);
      await conversationsService.findOrOpenConversationForDeviceSentMessage(connectionId, contact.id);
      const result = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "ainda aí?");

      expect(result.isNewConversation).toBe(false);
      expect(result.conversation.id).toBe(conversation.id);
      const rows = await conversationsOf(contact.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("IN_PROGRESS");
      expect(rows[0].assignedAgentId).toBe(agent.id);
    });

    it("depois de encerrada (pela Gestão), a próxima mensagem abre uma conversa nova na fila", async () => {
      const { contact, conversation } = await createWaitingConversation("5511990009995", connectionId);
      const admin = await createTestUser({ email: "admin-close-phone@test.dev", role: "ADMIN" });
      await conversationsService.markConversationReadFromDevice(conversation.id);
      await conversationsService.closeConversationFromGestao(conversation.id, admin.id);

      const result = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "oi, voltei");
      expect(result.isNewConversation).toBe(true);
      expect(result.conversation.id).not.toBe(conversation.id);
      expect(result.conversation.status).toBe("NEW");
      expect((await conversationsOf(contact.id)).map((c) => c.status)).toEqual(["CLOSED", "NEW"]);
    });
  });
});

describe("conversa pelo celular, pelos eventos do WhatsApp (de ponta a ponta)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("o atendente escreve primeiro pelo celular e o cliente responde: uma linha só na Gestão, pelo celular, com as duas mensagens", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-phone-e2e@test.dev", role: "ADMIN" });
    const login = await request(app).post("/api/auth/login").send({ email: "admin-phone-e2e@test.dev", password: TEST_PASSWORD });
    const token = login.body.accessToken as string;
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "SuporteCelular" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${token}`);
    await new Promise((resolve) => setTimeout(resolve, 2300)); // mock provider: QR -> CONNECTED takes ~1.9s
    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;

    provider.simulateDeviceSentMessage("5511990001234", "Bom dia! Aqui é da loja.");
    await waitForRows(1);
    provider.simulateIncomingMessage("5511990001234", "Bom dia, tudo bem?");
    await waitForMessages(2);

    // Only this customer's rows: the mock's own pre-existing unread chat (another number, ~0.8s after connecting) may
    // land at any moment, in the queue.
    const ofThisCustomer = (rows: { contact: { phone: string | null } }[]) => rows.filter((c) => c.contact.phone === "5511990001234");
    const oversight = await request(app).get("/api/conversations/oversight").set("Authorization", `Bearer ${token}`);
    expect(oversight.status).toBe(200);
    const rows = ofThisCustomer(oversight.body);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("HANDLED_EXTERNALLY");
    const messages = await prisma.message.findMany({ where: { conversationId: rows[0].id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => `${m.direction}:${m.body}`)).toEqual(["OUTBOUND:Bom dia! Aqui é da loja.", "INBOUND:Bom dia, tudo bem?"]);
    const queue = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`);
    expect(ofThisCustomer(queue.body)).toHaveLength(0);
  }, 20000);

  // Counted for this test's customer only (see the mock's pre-existing unread chat above).
  const THIS_CUSTOMER = { contact: { phone: "5511990001234" } };
  async function waitForRows(count: number) {
    for (let i = 0; i < 100 && (await prisma.conversation.count({ where: THIS_CUSTOMER })) < count; i++) await new Promise((r) => setTimeout(r, 50));
  }
  async function waitForMessages(count: number) {
    for (let i = 0; i < 100 && (await prisma.message.count({ where: { conversation: THIS_CUSTOMER } })) < count; i++) await new Promise((r) => setTimeout(r, 50));
  }
});
