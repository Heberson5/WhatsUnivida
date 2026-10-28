import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, grantManagerConnectionAccess, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("a disconnected WhatsApp connection blocks sending and accepting", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("refuses to accept a queued conversation whose connection is disconnected", async () => {
    const connection = await createTestConnection("Suporte", "DISCONNECTED");
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connection.id });
    const token = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511999990001", connection.id);

    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);

    const stillWaiting = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stillWaiting.status).toBe("WAITING");
    expect(stillWaiting.assignedAgentId).toBeNull();
  });

  it("refuses to send a text message on a conversation whose connection has since disconnected", async () => {
    const connection = await createTestConnection("Suporte"); // CONNECTED
    await createTestUser({ email: "joao2@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connection.id });
    const token = await loginAs("joao2@test.dev");
    const { conversation } = await createWaitingConversation("5511999990002", connection.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);

    // The connection drops mid-attendance — the agent is already in the chat.
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { status: "DISCONNECTED" } });

    const res = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Oi?" });
    expect(res.status).toBe(400);
  });

  it("marks a disconnected connection's conversations with whatsappConnectionStatus so the UI can show the alert/disable state", async () => {
    const connection = await createTestConnection("Suporte", "DISCONNECTED");
    await createTestUser({ email: "joao3@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connection.id });
    const token = await loginAs("joao3@test.dev");
    await createWaitingConversation("5511999990003", connection.id);

    const queue = await request(app).get("/api/conversations/queue").set("Authorization", `Bearer ${token}`);
    expect(queue.body[0].whatsappConnectionStatus).toBe("DISCONNECTED");
  });
});

describe("a MANAGER's connection access is limited to what they created or were granted", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("hides a connection a MANAGER neither created nor was granted from GET /whatsapp/connections", async () => {
    const admin = await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const gestor = await createTestUser({ email: "gestor@test.dev", role: "MANAGER" });
    const gestorToken = await loginAs("gestor@test.dev");
    await prisma.whatsAppConnection.create({ data: { name: "Suporte", createdByUserId: admin.id } });
    const own = await prisma.whatsAppConnection.create({ data: { name: "Vendas", createdByUserId: gestor.id } });

    const res = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${gestorToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toEqual([own.id]);
  });

  it("lets a MANAGER see a connection an ADMIN explicitly granted them, without owning it", async () => {
    const admin = await createTestUser({ email: "admin2@test.dev", role: "ADMIN" });
    const gestor = await createTestUser({ email: "gestor2@test.dev", role: "MANAGER" });
    const gestorToken = await loginAs("gestor2@test.dev");
    const granted = await prisma.whatsAppConnection.create({ data: { name: "Suporte2", createdByUserId: admin.id } });
    await grantManagerConnectionAccess(gestor.id, granted.id, { canManage: true, canReceiveConversations: false });

    const res = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${gestorToken}`);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual([granted.id]);
  });

  it("refuses to let a MANAGER accept a conversation from a connection they have no receive-grant for", async () => {
    const admin = await createTestUser({ email: "admin3@test.dev", role: "ADMIN" });
    const gestor = await createTestUser({ email: "gestor3@test.dev", role: "MANAGER" });
    const gestorToken = await loginAs("gestor3@test.dev");
    const connection = await prisma.whatsAppConnection.create({ data: { name: "Suporte3", status: "CONNECTED", createdByUserId: admin.id } });
    const { conversation } = await createWaitingConversation("5511999990010", connection.id);

    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${gestorToken}`);
    expect(res.status).toBe(403);
  });

  it("lets a MANAGER accept a conversation once granted canReceiveConversations for that connection", async () => {
    const admin = await createTestUser({ email: "admin4@test.dev", role: "ADMIN" });
    const gestor = await createTestUser({ email: "gestor4@test.dev", role: "MANAGER" });
    const gestorToken = await loginAs("gestor4@test.dev");
    const connection = await prisma.whatsAppConnection.create({ data: { name: "Suporte4", status: "CONNECTED", createdByUserId: admin.id } });
    await grantManagerConnectionAccess(gestor.id, connection.id, { canManage: false, canReceiveConversations: true });
    const { conversation } = await createWaitingConversation("5511999990011", connection.id);

    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${gestorToken}`);
    expect(res.status).toBe(200);
  });

  it("ADMIN's GET/PUT /whatsapp/managers/:userId/access lists every connection and lets the admin grant/revoke access", async () => {
    const admin = await createTestUser({ email: "admin5@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin5@test.dev");
    const gestor = await createTestUser({ email: "gestor5@test.dev", role: "MANAGER" });
    const owned = await prisma.whatsAppConnection.create({ data: { name: "Propria", createdByUserId: gestor.id } });
    const other = await prisma.whatsAppConnection.create({ data: { name: "DeOutro", createdByUserId: admin.id } });

    const before = await request(app).get(`/api/whatsapp/managers/${gestor.id}/access`).set("Authorization", `Bearer ${adminToken}`);
    expect(before.status).toBe(200);
    const ownedRow = before.body.find((r: { whatsappConnectionId: string }) => r.whatsappConnectionId === owned.id);
    expect(ownedRow.owned).toBe(true);
    expect(ownedRow.canManage).toBe(true);
    expect(ownedRow.canReceiveConversations).toBe(true);
    const otherRow = before.body.find((r: { whatsappConnectionId: string }) => r.whatsappConnectionId === other.id);
    expect(otherRow.owned).toBe(false);
    expect(otherRow.canManage).toBe(false);

    const put = await request(app)
      .put(`/api/whatsapp/managers/${gestor.id}/access`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ entries: [{ whatsappConnectionId: other.id, canManage: true, canReceiveConversations: false }] });
    expect(put.status).toBe(200);
    const afterOtherRow = put.body.find((r: { whatsappConnectionId: string }) => r.whatsappConnectionId === other.id);
    expect(afterOtherRow.canManage).toBe(true);
    expect(afterOtherRow.canReceiveConversations).toBe(false);
  });

  it("refuses a MANAGER trying to update a connection they don't manage, even with configuracoes.gerenciar allowed for their role", async () => {
    await prisma.rolePermission.create({ data: { role: "MANAGER", permission: "configuracoes.gerenciar", allowed: true } });
    const admin = await createTestUser({ email: "admin6@test.dev", role: "ADMIN" });
    const gestor = await createTestUser({ email: "gestor6@test.dev", role: "MANAGER" });
    const gestorToken = await loginAs("gestor6@test.dev");
    const connection = await prisma.whatsAppConnection.create({ data: { name: "NaoMinha", createdByUserId: admin.id } });

    const res = await request(app)
      .patch(`/api/whatsapp/connections/${connection.id}`)
      .set("Authorization", `Bearer ${gestorToken}`)
      .send({ color: "#123456" });
    expect(res.status).toBe(403);
  });
});
