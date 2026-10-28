import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { reactionEventFromBaileys, type MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Baileys messages.reaction → provider event", () => {
  const target = { id: "WA-TARGET-1", remoteJid: "5511990008000@s.whatsapp.net" };

  it("marks a reaction made by our own account (what Baileys echoes back for every reaction we send)", () => {
    const event = reactionEventFromBaileys({ key: target, reaction: { text: "👍", key: { remoteJid: target.remoteJid, fromMe: true } } });
    expect(event).toMatchObject({ providerMessageId: "WA-TARGET-1", chatId: target.remoteJid, emoji: "👍", fromMe: true });
  });

  it("does not mark the customer's reaction", () => {
    const event = reactionEventFromBaileys({ key: target, reaction: { text: "❤️", key: { remoteJid: target.remoteJid, fromMe: false } } });
    expect(event).toMatchObject({ emoji: "❤️", fromMe: false });
  });

  it("turns an empty reaction into null — the reaction was taken back", () => {
    expect(reactionEventFromBaileys({ key: target, reaction: { text: "", key: { fromMe: false } } }).emoji).toBeNull();
    expect(reactionEventFromBaileys({ key: target, reaction: { text: null } }).fromMe).toBe(false);
  });
});

describe("reações em uma conversa", () => {
  let agentToken: string;
  let conversationId: string;
  let chatId: string;
  let provider: MockWhatsAppProvider;
  let counter = 0;

  async function loginAs(email: string) {
    const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-react@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-react@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteReacoes" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await wait(2300); // mock provider: QR -> CONNECTED takes ~1.9s
    provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;

    await createTestUser({ email: "ana-react@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: created.body.id });
    agentToken = await loginAs("ana-react@test.dev");
    const { conversation, contact } = await createWaitingConversation("5511990008000", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);
    conversationId = conversation.id;
    chatId = `${contact.phone}@s.whatsapp.net`;
  }, 20000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A fresh message to react to — each test owns one, so they never see each other's reactions. */
  async function newMessage(direction: "INBOUND" | "OUTBOUND" = "INBOUND") {
    counter += 1;
    const providerMessageId = `WA-${direction}-${counter}`;
    const message = await prisma.message.create({
      data: { conversationId, direction, type: "TEXT", status: direction === "INBOUND" ? "DELIVERED" : "SENT", body: `mensagem ${counter}`, providerMessageId },
    });
    return { id: message.id, providerMessageId };
  }

  const agentReacts = (messageId: string, emoji: string | null) =>
    request(app).post(`/api/messages/${messageId}/reaction`).set("Authorization", `Bearer ${agentToken}`).send({ emoji });

  /** What the screen would draw: one entry per stored reaction. */
  async function reactions(messageId: string) {
    const rows = await prisma.messageReaction.findMany({ where: { messageId }, include: { user: true }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => `${r.emoji}:${r.user?.displayName ?? "Cliente"}`).sort();
  }

  /** The customer's side, as Baileys reports it. */
  const customerReacts = (providerMessageId: string, emoji: string | null) => provider.simulateReaction({ providerMessageId, chatId, emoji, fromMe: false });
  /** What Baileys echoes back after WE send a reaction (or a reaction made on the linked phone). */
  const echoOfOurReaction = (providerMessageId: string, emoji: string | null) => provider.simulateReaction({ providerMessageId, chatId, emoji, fromMe: true });

  it("a reação do atendente aparece uma vez só, mesmo com o eco que o WhatsApp devolve", async () => {
    const message = await newMessage();
    expect((await agentReacts(message.id, "👍")).status).toBe(200);
    echoOfOurReaction(message.providerMessageId, "👍");
    await wait(200);
    expect(await reactions(message.id)).toEqual(["👍:Ana"]);
  });

  it("o eco da reação do atendente não apaga a reação real do cliente", async () => {
    const message = await newMessage();
    customerReacts(message.providerMessageId, "❤️");
    await wait(200);
    expect(await reactions(message.id)).toEqual(["❤️:Cliente"]);

    await agentReacts(message.id, "🙏");
    echoOfOurReaction(message.providerMessageId, "🙏");
    await wait(200);
    expect(await reactions(message.id)).toEqual(["❤️:Cliente", "🙏:Ana"]);
  });

  it("uma reação feita no celular da empresa não vira reação do cliente", async () => {
    const message = await newMessage();
    echoOfOurReaction(message.providerMessageId, "😂");
    await wait(200);
    expect(await reactions(message.id)).toEqual([]);
  });

  it("o mesmo aviso do cliente chegando duas vezes juntas deixa uma reação só", async () => {
    const message = await newMessage();
    customerReacts(message.providerMessageId, "😂");
    customerReacts(message.providerMessageId, "😂");
    await wait(400);
    expect(await reactions(message.id)).toEqual(["😂:Cliente"]);
  });

  it("o cliente que troca de reação duas vezes de uma vez fica com a última", async () => {
    const message = await newMessage();
    customerReacts(message.providerMessageId, "❤️");
    customerReacts(message.providerMessageId, "😮");
    customerReacts(message.providerMessageId, "😢");
    await wait(500);
    expect(await reactions(message.id)).toEqual(["😢:Cliente"]);
  });

  it("o cliente que tira a reação some só com a dele", async () => {
    const message = await newMessage();
    await agentReacts(message.id, "👍");
    customerReacts(message.providerMessageId, "❤️");
    await wait(200);
    customerReacts(message.providerMessageId, null);
    await wait(200);
    expect(await reactions(message.id)).toEqual(["👍:Ana"]);
  });

  it("o atendente troca de reação: continua uma linha só, e o eco não acrescenta nada", async () => {
    const message = await newMessage();
    await agentReacts(message.id, "👍");
    echoOfOurReaction(message.providerMessageId, "👍");
    await agentReacts(message.id, "🙏");
    echoOfOurReaction(message.providerMessageId, "🙏");
    await wait(200);
    expect(await reactions(message.id)).toEqual(["🙏:Ana"]);
  });

  it("o atendente tira a reação", async () => {
    const message = await newMessage();
    await agentReacts(message.id, "👍");
    await agentReacts(message.id, null);
    echoOfOurReaction(message.providerMessageId, null);
    await wait(200);
    expect(await reactions(message.id)).toEqual([]);
  });

  it("dois cliques do atendente ao mesmo tempo deixam uma reação só", async () => {
    const message = await newMessage();
    const [a, b] = await Promise.all([agentReacts(message.id, "👍"), agentReacts(message.id, "❤️")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await reactions(message.id)).toHaveLength(1);
  });

  it("avisa o WhatsApp que a mensagem reagida é nossa quando é uma mensagem enviada por nós", async () => {
    const sent = await newMessage("OUTBOUND");
    const received = await newMessage("INBOUND");
    await agentReacts(sent.id, "👍");
    await agentReacts(received.id, "👍");
    const forSent = provider.reactionsSent.find((r) => r.providerMessageId === sent.providerMessageId);
    const forReceived = provider.reactionsSent.find((r) => r.providerMessageId === received.providerMessageId);
    expect(forSent).toMatchObject({ emoji: "👍", targetFromMe: true });
    expect(forReceived).toMatchObject({ emoji: "👍", targetFromMe: false });
  });

  it("ignora a reação a uma mensagem que o sistema não conhece", async () => {
    customerReacts("WA-DESCONHECIDA", "👍");
    await wait(200);
    expect(await prisma.messageReaction.count({ where: { message: { providerMessageId: "WA-DESCONHECIDA" } } })).toBe(0);
  });
});

describe("limpeza das reações repetidas antigas (migração)", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../prisma/migrations/20261008110000_cleanup_echo_reactions/migration.sql"), "utf-8");
  const T0 = new Date("2026-10-01T12:00:00.000Z");
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("apaga só a cópia que o eco criou (mesmo emoji, segundos depois da reação do atendente)", async () => {
    await resetDatabase();
    const agent = await createTestUser({ email: "ana-clean@test.dev", role: "AGENT", displayName: "Ana" });
    const connection = await prisma.whatsAppConnection.create({ data: { name: "Limpeza", status: "CONNECTED" } });
    const { conversation } = await createWaitingConversation("5511990009100", connection.id);
    const mk = (n: number) => prisma.message.create({ data: { conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: `m${n}`, providerMessageId: `WA-CLEAN-${n}` } });
    const [echo, otherEmoji, later, alone] = await Promise.all([mk(1), mk(2), mk(3), mk(4)]);
    const agentRow = (messageId: string) => ({ messageId, userId: agent.id, fromCustomer: false, emoji: "👍", createdAt: at(0) });
    const customerRow = (messageId: string, emoji: string, seconds: number) => ({ messageId, userId: null, fromCustomer: true, emoji, createdAt: at(seconds) });
    await prisma.messageReaction.createMany({
      data: [
        agentRow(echo.id), customerRow(echo.id, "👍", 3), // the echo: goes
        agentRow(otherEmoji.id), customerRow(otherEmoji.id, "❤️", 3), // a different emoji is a real reaction
        agentRow(later.id), customerRow(later.id, "👍", 5 * 60), // same emoji, but minutes later: a real reaction
        customerRow(alone.id, "👍", 3), // nobody from the team reacted: a real reaction
      ],
    });

    await prisma.$executeRawUnsafe(sql);

    const left = await prisma.messageReaction.findMany({ include: { message: true }, orderBy: [{ messageId: "asc" }, { createdAt: "asc" }] });
    const summary = (id: string) => left.filter((r) => r.messageId === id).map((r) => `${r.emoji}${r.fromCustomer ? ":cliente" : ":atendente"}`).sort();
    expect(summary(echo.id)).toEqual(["👍:atendente"]);
    expect(summary(otherEmoji.id)).toEqual(["❤️:cliente", "👍:atendente"]);
    expect(summary(later.id)).toEqual(["👍:atendente", "👍:cliente"]);
    expect(summary(alone.id)).toEqual(["👍:cliente"]);
  });
});
