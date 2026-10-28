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

describe("start a new conversation from a device contact", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets an AGENT start a brand-new conversation on their own connection, assigned to themselves immediately", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");

    const res = await request(app)
      .post("/api/conversations/start")
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: "5511990001111", name: "Ana Ribeiro" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("IN_PROGRESS");
    expect(res.body.assignedAgentName).toBe("Joao");
    expect(res.body.whatsappConnectionId).toBe(connectionId);

    const mine = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${token}`);
    expect(mine.body.map((c: { id: string }) => c.id)).toContain(res.body.id);
  });

  it("returns the same conversation instead of duplicating it when the agent starts it again on the same contact", async () => {
    await createTestUser({ email: "joao2@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao2@test.dev");

    const first = await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${token}`).send({ phone: "5511990002222" });
    const second = await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${token}`).send({ phone: "5511990002222" });

    expect(second.body.id).toBe(first.body.id);
  });

  it("refuses to start a conversation already owned by someone else, and requires a connectionId for a MANAGER", async () => {
    await createTestUser({ email: "joao3@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const gestor = await createTestUser({ email: "gestor@test.dev", role: "MANAGER" });
    await grantManagerConnectionAccess(gestor.id, connectionId);
    const joaoToken = await loginAs("joao3@test.dev");
    const gestorToken = await loginAs("gestor@test.dev");

    await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${joaoToken}`).send({ phone: "5511990003333" });

    const managerNoConnection = await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${gestorToken}`).send({ phone: "5511990004444" });
    expect(managerNoConnection.status).toBe(400);

    const managerClash = await request(app)
      .post("/api/conversations/start")
      .set("Authorization", `Bearer ${gestorToken}`)
      .send({ phone: "5511990003333", connectionId });
    expect(managerClash.status).toBe(409);
  });

  it("lets an unclaimed queue conversation be 'started' (equivalent to accepting it) instead of erroring", async () => {
    await createTestUser({ email: "joao4@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao4@test.dev");
    const { conversation } = await createWaitingConversation("5511990005555", connectionId);

    const res = await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${token}`).send({ phone: "5511990005555" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(conversation.id);
    expect(res.body.status).toBe("IN_PROGRESS");
  });
});

describe("transfer targets include MANAGER/ADMIN, who can also receive transfers", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lists MANAGER and ADMIN alongside AGENT as valid transfer targets", async () => {
    await createTestUser({ email: "joao5@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    await createTestUser({ email: "gestor2@test.dev", role: "MANAGER", displayName: "Gestora" });
    await createTestUser({ email: "admin2@test.dev", role: "ADMIN", displayName: "Chefe" });
    const token = await loginAs("joao5@test.dev");

    const res = await request(app).get("/api/agents/transfer-targets").set("Authorization", `Bearer ${token}`);
    const names = res.body.map((a: { displayName: string }) => a.displayName);
    expect(names).toEqual(expect.arrayContaining(["Gestora", "Chefe"]));
  });

  it("lets an AGENT transfer a conversation to a MANAGER, who can then see it in their own 'mine' list", async () => {
    await createTestUser({ email: "joao6@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    await createTestUser({ email: "gestor3@test.dev", role: "MANAGER", displayName: "Gestora", presence: "ONLINE" });
    const joaoToken = await loginAs("joao6@test.dev");
    const gestorToken = await loginAs("gestor3@test.dev");
    const gestor = await prisma.user.findUniqueOrThrow({ where: { email: "gestor3@test.dev" } });

    const { conversation } = await createWaitingConversation("5511990006666", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);
    const transferRes = await request(app)
      .post(`/api/conversations/${conversation.id}/transfer`)
      .set("Authorization", `Bearer ${joaoToken}`)
      .send({ toAgentId: gestor.id });
    expect(transferRes.status).toBe(200);

    const mine = await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${gestorToken}`);
    expect(mine.body.map((c: { id: string }) => c.id)).toContain(conversation.id);
  });

  it("lets a MANAGER (not just AGENT) send a text message on a conversation they accepted", async () => {
    // Regression test: messages.routes.ts used to gate every send endpoint
    // behind requireRole("AGENT") alone, so a MANAGER/ADMIN could accept a
    // conversation (allowed since round 37) but then get a 403 trying to
    // reply in it.
    const gestor4 = await createTestUser({ email: "gestor4@test.dev", role: "MANAGER", displayName: "Gestora" });
    await grantManagerConnectionAccess(gestor4.id, connectionId);
    const token = await loginAs("gestor4@test.dev");
    const { conversation } = await createWaitingConversation("5511990007777", connectionId);

    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);
    const sendRes = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/text`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Ola, em que posso ajudar?" });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.body).toBe("Ola, em que posso ajudar?");
  });
});

describe("WhatsApp connection color and pairing-code connect", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("auto-assigns a distinct color to each new connection and lets an ADMIN change it", async () => {
    await createTestUser({ email: "admin3@test.dev", role: "ADMIN" });
    const token = await loginAs("admin3@test.dev");

    const first = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Suporte" });
    const second = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Vendas" });
    expect(first.body.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(first.body.color).not.toBe(second.body.color);

    const patched = await request(app)
      .patch(`/api/whatsapp/connections/${first.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ color: "#123456" });
    expect(patched.body.color).toBe("#123456");
  });

  it("moves a connection to CODE_PENDING with a pairing code when connecting with a phone number (mock provider)", async () => {
    await createTestUser({ email: "admin4@test.dev", role: "ADMIN" });
    const token = await loginAs("admin4@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Suporte2" });

    await request(app)
      .post(`/api/whatsapp/connections/${created.body.id}/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "5511999998888" });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`);
    const connection = status.body.find((c: { id: string }) => c.id === created.body.id);
    expect(connection.state).toBe("CODE_PENDING");
    expect(connection.pairingCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("shows the pairing code (not a stale QR) after switching from QR Code to Conectar com número on the same connection", async () => {
    // Regression: connect() used to spread the *previous* status forward
    // (`{ ...this.status, state: "CONNECTING" }`), so a leftover
    // qrCodeDataUrl from an earlier QR attempt survived into the new
    // CODE_PENDING status. The panel checks qrCodeDataUrl before
    // pairingCode, so that stale QR kept winning and the freshly-generated
    // code never rendered — see PROMPT: "quando clico para gerar o código,
    // não aparece qual é o código".
    await createTestUser({ email: "admin4b@test.dev", role: "ADMIN" });
    const token = await loginAs("admin4b@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Suporte2b" });

    // First, connect via QR (no phoneNumber) and let it reach QR_PENDING with a real qrCodeDataUrl.
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${token}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterQr = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`);
    const qrState = afterQr.body.find((c: { id: string }) => c.id === created.body.id);
    expect(qrState.state).toBe("QR_PENDING");
    expect(qrState.qrCodeDataUrl).toBeTruthy();

    // Now switch to pairing-code mode on the SAME connection, same as clicking "Conectar com número" then "Gerar código".
    await request(app)
      .post(`/api/whatsapp/connections/${created.body.id}/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "5511999997777" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterCode = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`);
    const codeState = afterCode.body.find((c: { id: string }) => c.id === created.body.id);
    expect(codeState.state).toBe("CODE_PENDING");
    expect(codeState.pairingCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(codeState.qrCodeDataUrl).toBeNull();
  });

  it("lists device contacts once connected, restricted to the agent's own connection", async () => {
    await createTestUser({ email: "admin5@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin5@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Suporte3" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    const otherConnection = await createTestConnection("Outra");
    await createTestUser({ email: "joao7@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: created.body.id });
    const joaoToken = await loginAs("joao7@test.dev");

    const ownContacts = await request(app).get(`/api/whatsapp/connections/${created.body.id}/contacts`).set("Authorization", `Bearer ${joaoToken}`);
    expect(ownContacts.status).toBe(200);
    expect(ownContacts.body.length).toBeGreaterThan(0);

    const otherContacts = await request(app).get(`/api/whatsapp/connections/${otherConnection.id}/contacts`).set("Authorization", `Bearer ${joaoToken}`);
    expect(otherContacts.status).toBe(403);
  }, 10000);

  it("lets an ADMIN delete a connection that is mid-pairing (not yet CONNECTED), only blocking deletion of a truly linked one", async () => {
    // Regression test for a real bug reported after deploy: a pairing
    // attempt that never finished (e.g. no outbound network access to
    // WhatsApp) used to leave the connection stuck in a non-DISCONNECTED
    // state forever, and deleteConnection required exactly DISCONNECTED —
    // so a failed pairing attempt permanently blocked deletion. It now only
    // blocks deleting a connection that is actually CONNECTED.
    await createTestUser({ email: "admin6@test.dev", role: "ADMIN" });
    const token = await loginAs("admin6@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Suporte4" });

    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${token}`);
    await new Promise((resolve) => setTimeout(resolve, 600)); // mock provider is QR_PENDING by ~400ms, well before CONNECTED at ~1.9s

    const midPairing = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`);
    const state = midPairing.body.find((c: { id: string }) => c.id === created.body.id).state;
    expect(["CONNECTING", "QR_PENDING"]).toContain(state);

    const deleteRes = await request(app).delete(`/api/whatsapp/connections/${created.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);
  });
});
