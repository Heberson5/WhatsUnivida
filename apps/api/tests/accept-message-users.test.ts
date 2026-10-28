import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createAutoMessageTemplate } from "../src/modules/auto-message-templates/auto-message-templates.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

const ALL_CONNECTIONS = { allConnections: true, connectionIds: [] };

describe("Respostas › Aceite: quem pode usar cada mensagem", () => {
  let adminToken: string;
  let connectionId: string;
  let ana: { id: string };
  let bruno: { id: string };

  beforeAll(async () => {
    await resetDatabase();
    await prisma.autoMessageTemplate.deleteMany({ where: { trigger: "ACCEPT" } });
    await createTestUser({ email: "admin-aceite@test.dev", role: "ADMIN" });
    adminToken = await loginAs("admin-aceite@test.dev");
    const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Aceite por usuário" });
    connectionId = connection.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s
    ana = await createTestUser({ email: "ana-aceite@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    bruno = await createTestUser({ email: "bruno-aceite@test.dev", role: "AGENT", displayName: "Bruno", whatsappConnectionId: connectionId });
  });

  afterAll(async () => {
    await prisma.autoMessageTemplate.deleteMany({ where: { trigger: "ACCEPT" } });
    await prisma.$disconnect();
  });

  async function acceptAs(email: string, phone: string) {
    const token = await loginAs(email);
    const { conversation } = await createWaitingConversation(phone, connectionId);
    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (__getProviderForTests(connectionId) as MockWhatsAppProvider).sentTexts.at(-1)?.text ?? "";
  }

  it("a mensagem escolhida para a pessoa vale só para ela; os demais recebem a de todos os usuários", async () => {
    await createAutoMessageTemplate({
      trigger: "ACCEPT",
      name: "Da Ana",
      text: "Aceite da Ana",
      active: true,
      connectionScope: ALL_CONNECTIONS,
      userScope: { allUsers: false, userIds: [ana.id] },
    });
    // Created later (the most recently updated), and still the one chosen for Ana wins for her.
    await createAutoMessageTemplate({ trigger: "ACCEPT", name: "Geral", text: "Aceite de todos", active: true, connectionScope: ALL_CONNECTIONS });

    expect(await acceptAs("ana-aceite@test.dev", "5511990001001")).toContain("Aceite da Ana");
    expect(await acceptAs("bruno-aceite@test.dev", "5511990001002")).toContain("Aceite de todos");
  }, 15000);

  it("sem mensagem para todos, quem não foi escolhido não envia nada", async () => {
    await prisma.autoMessageTemplate.deleteMany({ where: { trigger: "ACCEPT" } });
    await createAutoMessageTemplate({
      trigger: "ACCEPT",
      name: "Só da Ana",
      text: "Aceite exclusivo da Ana",
      active: true,
      connectionScope: ALL_CONNECTIONS,
      userScope: { allUsers: false, userIds: [ana.id] },
    });
    const provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    const before = provider.sentTexts.length;
    await acceptAs("bruno-aceite@test.dev", "5511990001003");
    expect(provider.sentTexts.length).toBe(before);
  }, 15000);

  it("a tela recebe e grava quem pode usar; usuário inexistente ou lista vazia é recusado", async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const created = await request(app)
      .post("/api/auto-message-templates")
      .set(auth)
      .send({ trigger: "ACCEPT", name: "Do Bruno", text: "Oi", active: false, connectionScope: ALL_CONNECTIONS, userScope: { allUsers: false, userIds: [bruno.id] } });
    expect(created.status).toBe(201);
    expect(created.body.userScope).toEqual({ allUsers: false, users: [{ id: bruno.id, displayName: "Bruno" }] });

    const listed = await request(app).get("/api/auto-message-templates").query({ trigger: "ACCEPT" }).set(auth);
    expect(listed.body.find((t: { id: string }) => t.id === created.body.id).userScope.users).toHaveLength(1);

    const toEveryone = await request(app).patch(`/api/auto-message-templates/${created.body.id}`).set(auth).send({ userScope: { allUsers: true, userIds: [] } });
    expect(toEveryone.body.userScope).toEqual({ allUsers: true, users: [] });

    const unknown = await request(app)
      .patch(`/api/auto-message-templates/${created.body.id}`)
      .set(auth)
      .send({ userScope: { allUsers: false, userIds: ["00000000-0000-4000-8000-000000000000"] } });
    expect(unknown.status).toBe(400);
    const empty = await request(app).patch(`/api/auto-message-templates/${created.body.id}`).set(auth).send({ userScope: { allUsers: false, userIds: [] } });
    expect(empty.status).toBe(400);
  });
});
