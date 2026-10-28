import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const sentTemplates: { name: string; bodyParams: string[] }[] = [];
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    sendOutboundTemplate: vi.fn(async (_c: string, messageId: string, _p: string, template: { name: string; bodyParams: string[] }) => {
      sentTemplates.push(template);
      return { id: messageId };
    }),
  };
});

import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
const HOUR = 60 * 60 * 1000;

describe("WhatsApp Oficial: template dentro da conversa", () => {
  let token: string;
  let conversationId: string;
  let templateId: string;

  beforeEach(async () => {
    await resetDatabase();
    sentTemplates.length = 0;
    const connection = await prisma.whatsAppConnection.create({ data: { name: "Oficial", connectionMode: "OFFICIAL_API", status: "CONNECTED" } });
    const agent = await createTestUser({ email: "ana@test.dev", role: "AGENT", whatsappConnectionId: connection.id, presence: "ONLINE" });
    token = (await request(app).post("/api/auth/login").send({ email: "ana@test.dev", password: TEST_PASSWORD })).body.accessToken;
    const contact = await prisma.contact.create({ data: { phone: "5511911112222", name: "Carlos", whatsappConnectionId: connection.id } });
    const now = new Date();
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connection.id, status: "IN_PROGRESS", assignedAgentId: agent.id, enteredQueueAt: now, acceptedAt: now, lastMessageAt: now },
    });
    conversationId = conversation.id;
    await prisma.message.create({
      data: { conversationId, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "Oi", createdAt: new Date(Date.now() - 30 * HOUR) },
    });
    templateId = (
      await prisma.messageTemplate.create({
        data: { name: "retorno_pedido", category: "UTILITY", language: "pt_BR", bodyText: "Olá {{1}}, seu pedido {{2}} está pronto.", whatsappConnectionId: connection.id, status: "APPROVED" },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reports the 24h window as closed and lists the approved templates", async () => {
    const res = await request(app).get(`/api/messages/conversations/${conversationId}/template-context`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ official: true, windowOpen: false });
    expect(res.body.templates.map((t: { name: string }) => t.name)).toEqual(["retorno_pedido"]);
  });

  it("sends the template with its fields and records the filled-in text", async () => {
    const res = await request(app)
      .post(`/api/messages/conversations/${conversationId}/template`)
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId, bodyParams: ["Carlos", "#123"] });
    expect(res.status).toBe(201);
    expect(sentTemplates).toEqual([expect.objectContaining({ name: "retorno_pedido", bodyParams: ["Carlos", "#123"] })]);
    const stored = await prisma.message.findFirstOrThrow({ where: { conversationId, direction: "OUTBOUND" } });
    expect(stored.body).toBe("Olá Carlos, seu pedido #123 está pronto.");
  });

  it("refuses a template with missing fields", async () => {
    const res = await request(app).post(`/api/messages/conversations/${conversationId}/template`).set("Authorization", `Bearer ${token}`).send({ templateId, bodyParams: ["Carlos"] });
    expect(res.status).toBe(400);
    expect(sentTemplates).toHaveLength(0);
  });
});
