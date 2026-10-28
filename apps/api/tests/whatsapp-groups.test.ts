import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { groupSenderFromBaileys } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, grantManagerConnectionAccess, TEST_PASSWORD } from "./helpers";

const app = createApp();
const GROUP = "120363000000000001@g.us";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

/** Waits until the provider's async message handler stored `count` messages in the group. */
async function untilGroupMessages(count: number) {
  for (let i = 0; i < 40; i++) {
    const n = await prisma.message.count({ where: { conversation: { status: "GROUP" } } });
    if (n >= count) return;
    await wait(50);
  }
  throw new Error(`expected ${count} group messages`);
}

describe("groupSenderFromBaileys (who wrote a group message)", () => {
  it("reads the participant's number, from the participant itself or from participantPn when WhatsApp hides it behind @lid", () => {
    expect(groupSenderFromBaileys({ remoteJid: GROUP, participant: "5565999990000@s.whatsapp.net" }, "Ana")).toEqual({
      participantJid: "5565999990000@s.whatsapp.net",
      participantPhone: "5565999990000",
      participantName: "Ana",
    });
    expect(groupSenderFromBaileys({ remoteJid: GROUP, participant: "9988@lid", participantPn: "5565988887777@s.whatsapp.net" }, null)).toEqual({
      participantJid: "9988@lid",
      participantPhone: "5565988887777",
      participantName: null,
    });
    expect(groupSenderFromBaileys({ remoteJid: GROUP, participant: "9988@lid" }, "  ")?.participantPhone).toBeNull();
    expect(groupSenderFromBaileys({ remoteJid: "5565999990000@s.whatsapp.net" }, "Ana")).toBeNull();
  });
});

describe("WhatsApp groups in Atendimento", () => {
  let connectionId: string;
  let otherConnectionId: string;
  let provider: MockWhatsAppProvider;
  let admin: string, lucas: string, bianca: string, gestor: string, outro: string;

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-grp@test.dev", role: "ADMIN", displayName: "Admin" });
    admin = await loginAs("admin-grp@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${admin}`).send({ name: "Recepção" });
    connectionId = created.body.id;
    otherConnectionId = (await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${admin}`).send({ name: "Vendas" })).body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${admin}`);
    await wait(2200); // mock provider: QR -> CONNECTED takes ~1.9s
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    provider.mockGroups.push({
      chatId: GROUP,
      subject: "Recepção — equipe",
      participants: [
        { jid: "5565999990000@s.whatsapp.net", phone: "5565999990000", name: "Ana Souza", isAdmin: true },
        { jid: "5565988887777@s.whatsapp.net", phone: "5565988887777", name: "Carlos Lima", isAdmin: false },
      ],
    });

    await createTestUser({ email: "lucas-grp@test.dev", role: "AGENT", displayName: "Lucas", whatsappConnectionId: connectionId });
    await createTestUser({ email: "bianca-grp@test.dev", role: "AGENT", displayName: "Bianca", whatsappConnectionId: connectionId });
    await createTestUser({ email: "outro-grp@test.dev", role: "AGENT", displayName: "Outro", whatsappConnectionId: otherConnectionId });
    const manager = await createTestUser({ email: "gestor-grp@test.dev", role: "MANAGER", displayName: "Gestora" });
    await grantManagerConnectionAccess(manager.id, connectionId, { canReceiveConversations: true });
    lucas = await loginAs("lucas-grp@test.dev");
    bianca = await loginAs("bianca-grp@test.dev");
    outro = await loginAs("outro-grp@test.dev");
    gestor = await loginAs("gestor-grp@test.dev");
  }, 15000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ignores group messages while the connection has groups off (the default)", async () => {
    provider.simulateIncomingGroupMessage(GROUP, "5565999990000", "Ana Souza", "Bom dia, equipe");
    await wait(300);
    expect(await prisma.contact.count({ where: { isGroup: true } })).toBe(0);
    // Only this group's message counts: the mock's own pre-existing unread chat (Ana Ribeiro, ~0.8s after connecting)
    // may land at any moment and is not about groups.
    expect(await prisma.conversation.count({ where: { contact: { OR: [{ isGroup: true }, { providerChatId: GROUP }, { phone: "5565999990000" }] } } })).toBe(0);
  });

  it("only an administrator turns groups on; doing so brings the number's groups in", async () => {
    const denied = await request(app).patch(`/api/whatsapp/connections/${connectionId}/groups`).set("Authorization", `Bearer ${gestor}`).send({ enabled: true });
    expect(denied.status).toBe(403);
    const res = await request(app).patch(`/api/whatsapp/connections/${connectionId}/groups`).set("Authorization", `Bearer ${admin}`).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.groupsEnabled).toBe(true);
    expect(res.body.groupsCount).toBe(1);
    const group = await prisma.contact.findFirstOrThrow({ where: { isGroup: true } });
    expect(group.name).toBe("Recepção — equipe");
    expect(group.groupParticipantsCount).toBe(2);
  });

  it("stores who wrote each message, and the group stays out of the queue, Meus, Gestão, Contatos, Dashboard and Relatórios", async () => {
    provider.simulateIncomingGroupMessage(GROUP, "5565999990000", "Ana Souza", "Bom dia, equipe");
    provider.simulateIncomingGroupMessage(GROUP, "5565988887777", "Carlos Lima", "A agenda de hoje está cheia");
    provider.simulateIncomingGroupMessage(GROUP, "5565999990000", "Ana Souza", "@Lucas consegue ver isso?");
    await untilGroupMessages(3);

    const list = await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: "Recepção — equipe", unreadCount: 3, participantsCount: 2 });
    expect(list.body[0].lastMessagePreview).toEqual({ senderName: "Ana Souza", text: "@Lucas consegue ver isso?" });

    const messages = await request(app).get(`/api/groups/${list.body[0].id}/messages`).set("Authorization", `Bearer ${lucas}`);
    expect(messages.body.items[1].senderParticipant).toMatchObject({ name: "Carlos Lima", phone: "5565988887777" });

    // @menção never routes a group to anybody, and nothing enters the queue.
    const queue = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${lucas}`);
    expect(JSON.stringify(queue.body)).not.toContain("Recepção — equipe");
    expect((await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${lucas}`)).body).toHaveLength(0);
    const oversight = await request(app).get("/api/conversations/oversight").set("Authorization", `Bearer ${admin}`);
    expect(JSON.stringify(oversight.body)).not.toContain("Recepção — equipe");
    const contacts = await request(app).get("/api/contacts").set("Authorization", `Bearer ${admin}`);
    expect(JSON.stringify(contacts.body)).not.toContain("Recepção — equipe");
    const dashboard = await request(app).get("/api/dashboard").set("Authorization", `Bearer ${admin}`);
    // The group conversation was created today, with 3 inbound messages today — none of it counts.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    expect(dashboard.body.conversations.received).toBe(await prisma.conversation.count({ where: { status: { not: "GROUP" }, createdAt: { gte: today } } }));
    expect(dashboard.body.messages.received).toBe(
      await prisma.message.count({ where: { direction: "INBOUND", createdAt: { gte: today }, conversation: { status: { not: "GROUP" } } } })
    );
    const report = await request(app).get("/api/reports/messages").set("Authorization", `Bearer ${admin}`);
    // Only the mock number's own customer chats (it seeds a couple) — none of the group's 3.
    const customerInbound = await prisma.message.count({ where: { direction: "INBOUND", conversation: { status: { not: "GROUP" } } } });
    expect(report.body.Recebidas).toBe(customerInbound);
  });

  it("reading is individual: Lucas opening the group clears it for him only", async () => {
    const [group] = (await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`)).body;
    expect((await request(app).post(`/api/groups/${group.id}/read`).set("Authorization", `Bearer ${lucas}`)).status).toBe(204);

    const forLucas = (await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`)).body[0];
    const forBianca = (await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).body[0];
    expect(forLucas.unreadCount).toBe(0);
    expect(forBianca.unreadCount).toBe(3);
    const readers = Object.fromEntries(forBianca.readers.map((r: { name: string; neverOpened: boolean; unreadCount: number }) => [r.name, r]));
    expect(readers.Lucas).toMatchObject({ neverOpened: false, unreadCount: 0 });
    expect(readers.Bianca).toMatchObject({ neverOpened: true, unreadCount: 3, isMe: true });
    expect(readers.Gestora).toMatchObject({ neverOpened: true });
    expect(readers.Admin).toBeUndefined(); // an administrator who doesn't attend this number isn't on the team list

    // The first person to read also sends WhatsApp's read receipt, with each author.
    await wait(100);
    const receipt = provider.readReceiptsSent.at(-1)!;
    expect(receipt.chatId).toBe(GROUP);
    expect(receipt.providerMessageIds).toHaveLength(3);
    expect(Object.values(receipt.participantByMessageId!)).toContain("5565988887777@s.whatsapp.net");
    const receiptsBefore = provider.readReceiptsSent.length;
    await request(app).post(`/api/groups/${group.id}/read`).set("Authorization", `Bearer ${bianca}`);
    await wait(100);
    expect(provider.readReceiptsSent.length).toBe(receiptsBefore); // already read on the phone

    const summary = (await request(app).get("/api/groups/summary").set("Authorization", `Bearer ${gestor}`)).body;
    expect(summary).toEqual({ groupsWithUnread: 1, unreadMessages: 3 });
  });

  it("a reply goes to the group with the display name from Usuários, like a reply to a customer, and counts as unread for the others", async () => {
    const [group] = (await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`)).body;
    // Renamed after login: the message must already carry the new name.
    await prisma.user.updateMany({ where: { email: "lucas-grp@test.dev" }, data: { displayName: "Lucas Andrade" } });
    const res = await request(app).post(`/api/groups/${group.id}/text`).set("Authorization", `Bearer ${lucas}`).send({ body: "Vou verificar agora" });
    expect(res.status).toBe(201);
    expect(res.body.body).toBe("Vou verificar agora");
    expect(res.body.senderAgentDisplayName).toBe("Lucas Andrade");
    expect(provider.sentTexts.at(-1)).toMatchObject({ chatId: GROUP, text: "*Lucas Andrade:*\n\nVou verificar agora" });

    const forLucas = (await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`)).body[0];
    const forBianca = (await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).body[0];
    expect(forLucas.unreadCount).toBe(0);
    expect(forBianca.unreadCount).toBe(1);
    expect(forBianca.lastMessagePreview).toEqual({ senderName: "Lucas Andrade", text: "Vou verificar agora" });

    // Replying quotes the participant's message with its author.
    const messages = (await request(app).get(`/api/groups/${group.id}/messages`).set("Authorization", `Bearer ${lucas}`)).body.items;
    const carlos = messages.find((m: { body: string }) => m.body === "A agenda de hoje está cheia");
    await request(app).post(`/api/groups/${group.id}/text`).set("Authorization", `Bearer ${lucas}`).send({ body: "Certo", replyToMessageId: carlos.id });
    expect(provider.sentTexts.at(-1)?.replyToParticipantJid).toBe("5565988887777@s.whatsapp.net");
  });

  it("everybody who sees the group gets ONE bell entry per group, updated; opening it marks it read; muting stops the notices but not the count", async () => {
    const [group] = (await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).body;
    const biancaUser = await prisma.user.findFirstOrThrow({ where: { email: "bianca-grp@test.dev" } });
    const gestorUser = await prisma.user.findFirstOrThrow({ where: { email: "gestor-grp@test.dev" } });
    const lucasUser = await prisma.user.findFirstOrThrow({ where: { email: "lucas-grp@test.dev" } });
    await request(app).post(`/api/groups/${group.id}/mute`).set("Authorization", `Bearer ${gestor}`);
    const gestorBefore = await prisma.notification.count({ where: { userId: gestorUser.id } });

    provider.simulateIncomingGroupMessage(GROUP, "5565999990000", "Ana Souza", "Obrigada!");
    provider.simulateIncomingGroupMessage(GROUP, "5565999990000", "Ana Souza", "Mais uma coisa");
    await untilGroupMessages(7);
    await wait(200);

    // Bianca read the group before Lucas's two replies: 2 + 2 unread, in one entry.
    const biancaBell = await prisma.notification.findMany({ where: { userId: biancaUser.id, entityType: "Group", readAt: null } });
    expect(biancaBell).toHaveLength(1);
    expect(biancaBell[0].title).toBe("Recepção — equipe");
    expect(biancaBell[0].body).toBe("4 mensagens não lidas · Ana Souza: Mais uma coisa");
    expect(await prisma.notification.count({ where: { userId: lucasUser.id, entityType: "Group", readAt: null } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: gestorUser.id } })).toBe(gestorBefore); // muted
    const gestorList = (await request(app).get("/api/groups").set("Authorization", `Bearer ${gestor}`)).body[0];
    expect(gestorList.unreadCount).toBe(7);
    expect(gestorList.muted).toBe(true);

    await request(app).post(`/api/groups/${group.id}/read`).set("Authorization", `Bearer ${bianca}`);
    expect(await prisma.notification.count({ where: { userId: biancaUser.id, entityType: "Group", readAt: null } })).toBe(0);
  });

  it("a message typed in the group on the linked phone is stored as 'Celular' and is unread for the team", async () => {
    const [group] = (await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).body;
    provider.simulateDeviceSentGroupMessage(GROUP, "Respondido pelo celular");
    await untilGroupMessages(8);
    const forBianca = (await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).body[0];
    expect(forBianca.unreadCount).toBe(1);
    expect(forBianca.lastMessagePreview).toEqual({ senderName: "Celular", text: "Respondido pelo celular" });
    const stored = await prisma.message.findFirstOrThrow({ where: { conversationId: group.id, body: "Respondido pelo celular" } });
    expect(stored).toMatchObject({ direction: "OUTBOUND", senderAgentId: null });
  });

  it("access: an attendant of another number doesn't see it; without 'Responder em grupos' replying is refused; a manager sees only the numbers they receive from", async () => {
    const [group] = (await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`)).body;
    expect((await request(app).get("/api/groups").set("Authorization", `Bearer ${outro}`)).body).toHaveLength(0);
    expect((await request(app).get(`/api/groups/${group.id}/messages`).set("Authorization", `Bearer ${outro}`)).status).toBe(404);
    expect((await request(app).post(`/api/groups/${group.id}/text`).set("Authorization", `Bearer ${outro}`).send({ body: "oi" })).status).toBe(404);

    await prisma.rolePermission.create({ data: { role: "AGENT", permission: "atendimento.grupos.responder", allowed: false } });
    expect((await request(app).post(`/api/groups/${group.id}/text`).set("Authorization", `Bearer ${bianca}`).send({ body: "oi" })).status).toBe(403);
    await prisma.rolePermission.deleteMany({ where: { permission: "atendimento.grupos.responder" } });

    await prisma.rolePermission.create({ data: { role: "AGENT", permission: "atendimento.grupos.visualizar", allowed: false } });
    expect((await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).status).toBe(403);
    await prisma.rolePermission.deleteMany({ where: { permission: "atendimento.grupos.visualizar" } });

    await prisma.managerConnectionAccess.updateMany({ data: { canReceiveConversations: false } });
    expect((await request(app).get("/api/groups").set("Authorization", `Bearer ${gestor}`)).body).toHaveLength(0);
    await prisma.managerConnectionAccess.updateMany({ data: { canReceiveConversations: true } });

    expect((await request(app).get("/api/groups").set("Authorization", `Bearer ${admin}`)).body).toHaveLength(1);
  });

  it("a group's file downloads for who sees the group, and not for anybody else", async () => {
    const group = await prisma.conversation.findFirstOrThrow({ where: { status: "GROUP" } });
    const message = await prisma.message.findFirstOrThrow({ where: { conversationId: group.id } });
    const attachment = await prisma.messageAttachment.create({
      data: { messageId: message.id, fileName: "loc", mimeType: "application/geo+json", sizeBytes: 0, storageKey: "", kind: "LOCATION" },
    });
    // No binary behind it: 404 "sem conteudo" means access passed; the other number gets plain 404 before that.
    const ok = await request(app).get(`/api/messages/attachments/${attachment.id}/download`).set("Authorization", `Bearer ${bianca}`);
    expect(ok.body.message ?? ok.text).toMatch(/sem conteudo/);
    const denied = await request(app).get(`/api/messages/attachments/${attachment.id}/download`).set("Authorization", `Bearer ${outro}`);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toMatch(/sem conteudo/);
  });

  it("'Carregar mensagens anteriores' asks WhatsApp from the oldest message, with its author, and the older ones come in already read", async () => {
    const [group] = (await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).body;
    const unreadBefore = group.unreadCount;
    const oldest = await prisma.message.findFirstOrThrow({ where: { conversationId: group.id, providerMessageId: { not: null } }, orderBy: { createdAt: "asc" } });
    const customerMessagesBefore = await prisma.message.count({ where: { conversation: { status: { not: "GROUP" } } } });

    const res = await request(app).post(`/api/groups/${group.id}/older-history`).set("Authorization", `Bearer ${bianca}`);
    expect(res.status).toBe(202);
    expect(provider.olderHistoryRequests.at(-1)).toMatchObject({
      chatId: GROUP,
      count: 50,
      anchor: { providerMessageId: oldest.providerMessageId, fromMe: false, participant: oldest.senderParticipantJid },
    });

    for (let i = 0; i < 40 && (await prisma.message.count({ where: { conversationId: group.id, createdAt: { lt: oldest.createdAt } } })) < 3; i++) await wait(50);
    const older = await prisma.message.findMany({ where: { conversationId: group.id, createdAt: { lt: oldest.createdAt } }, orderBy: { createdAt: "asc" } });
    expect(older).toHaveLength(3);
    expect(older.every((m) => m.direction === "INBOUND" && m.readAt !== null && m.senderParticipantName)).toBe(true);
    expect(older.map((m) => m.senderParticipantName)).toEqual(expect.arrayContaining(["Ana Souza", "Carlos Lima"]));

    // Read for everybody, and never mixed into the customer conversations.
    const after = (await request(app).get("/api/groups").set("Authorization", `Bearer ${bianca}`)).body[0];
    expect(after.unreadCount).toBe(unreadBefore);
    expect(await prisma.message.count({ where: { conversation: { status: { not: "GROUP" } } } })).toBe(customerMessagesBefore);

    // Somebody of another number can't ask.
    expect((await request(app).post(`/api/groups/${group.id}/older-history`).set("Authorization", `Bearer ${outro}`)).status).toBe(404);
  });

  it("a group with no message yet has nothing to start the older history from", async () => {
    const empty = await prisma.contact.create({ data: { whatsappConnectionId: connectionId, providerChatId: "120363000000000099@g.us", isGroup: true, name: "Sem mensagens" } });
    const conv = await prisma.conversation.create({ data: { contactId: empty.id, whatsappConnectionId: connectionId, status: "GROUP" } });
    const res = await request(app).post(`/api/groups/${conv.id}/older-history`).set("Authorization", `Bearer ${bianca}`);
    expect(res.status).toBe(400);
    expect(res.body.message ?? res.text).toMatch(/ponto de partida/);
    await prisma.conversation.delete({ where: { id: conv.id } });
    await prisma.contact.delete({ where: { id: empty.id } });
  });

  it("\"@\" marks one person (WhatsApp gets their number) or everyone (\"@todos\" notifies all participants)", async () => {
    const [group] = (await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`)).body;
    const participants = (await request(app).get(`/api/groups/${group.id}/participants`).set("Authorization", `Bearer ${lucas}`)).body;
    const carlos = participants.find((p: { name: string }) => p.name === "Carlos Lima");
    expect(carlos.jid).toBe("5565988887777@s.whatsapp.net");

    const one = await request(app)
      .post(`/api/groups/${group.id}/text`)
      .set("Authorization", `Bearer ${lucas}`)
      .send({ body: "@Carlos Lima pode confirmar?", mentions: [{ jid: carlos.jid, label: "Carlos Lima" }] });
    expect(one.body.body).toBe("@Carlos Lima pode confirmar?");
    expect(provider.sentTexts.at(-1)).toMatchObject({ text: "*Lucas Andrade:*\n\n@5565988887777 pode confirmar?", mentions: [carlos.jid] });

    await request(app).post(`/api/groups/${group.id}/text`).set("Authorization", `Bearer ${lucas}`).send({ body: "@todos reunião às 15h", mentionAll: true }).expect(201);
    expect(provider.sentTexts.at(-1)).toMatchObject({
      text: "*Lucas Andrade:*\n\n@todos reunião às 15h",
      mentions: ["5565999990000@s.whatsapp.net", "5565988887777@s.whatsapp.net"],
    });
  });

  it("turning groups off stops new messages and hides the tab; customer conversations are untouched", async () => {
    await createWaitingConversation("5565977776666", connectionId);
    await request(app).patch(`/api/whatsapp/connections/${connectionId}/groups`).set("Authorization", `Bearer ${admin}`).send({ enabled: false });
    const before = await prisma.message.count({ where: { conversation: { status: "GROUP" } } });
    provider.simulateIncomingGroupMessage(GROUP, "5565999990000", "Ana Souza", "Ninguém vê esta");
    await wait(300);
    expect(await prisma.message.count({ where: { conversation: { status: "GROUP" } } })).toBe(before);
    expect((await request(app).get("/api/groups").set("Authorization", `Bearer ${lucas}`)).body).toHaveLength(0);
    const queue = (await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${lucas}`)).body;
    expect(queue.some((c: { contact: { phone: string } }) => c.contact.phone === "5565977776666")).toBe(true);
  });
});

describe("importGroupHistory", () => {
  it("adds a message only once, and ignores groups the app doesn't show", async () => {
    const { importGroupHistory } = await import("../src/modules/groups/groups.service");
    const connection = await prisma.whatsAppConnection.create({ data: { name: "HistOnce", status: "CONNECTED", groupsEnabled: true, groupsEnabledAt: new Date() } });
    const contact = await prisma.contact.create({ data: { whatsappConnectionId: connection.id, providerChatId: "120363000000000777@g.us", isGroup: true, name: "Hist" } });
    const conv = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connection.id, status: "GROUP" } });
    const msg = (id: string, chatId: string) => ({
      providerMessageId: id,
      chatId,
      phone: chatId.split("@")[0],
      fromMe: false,
      type: "TEXT" as const,
      body: "antiga",
      timestamp: new Date("2026-01-01T10:00:00Z"),
      group: { participantJid: "5565911112222@s.whatsapp.net", participantPhone: "5565911112222", participantName: "Rita" },
    });
    const batch = [msg("hist-once-1", "120363000000000777@g.us"), msg("hist-unknown-1", "120363000000000888@g.us")];
    expect([...(await importGroupHistory(connection.id, batch)).values()]).toEqual([1]);
    expect([...(await importGroupHistory(connection.id, batch)).values()]).toEqual([]);
    expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(1);
    expect(await prisma.message.count({ where: { providerMessageId: "hist-unknown-1" } })).toBe(0);
  });
});
