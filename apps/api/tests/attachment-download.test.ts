import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Starting a conversation now asks WhatsApp whether the number exists — answered "yes" here, these tests are about other things.
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return { ...actual, lookupNumber: vi.fn(async (_connectionId: string, phone: string) => ({ phone })) };
});
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body as { accessToken: string };
}

describe("message attachment download", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function sendAnImage(agentEmail: string) {
    await createTestUser({ email: agentEmail, role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const { accessToken } = await loginAs(agentEmail);
    const { conversation } = await createWaitingConversation("5511990009999", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${accessToken}`);

    const sendRes = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/file`)
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from("fake-png-bytes"), { filename: "foto.png", contentType: "image/png" });

    expect(sendRes.status).toBe(201);
    const attachmentId: string = sendRes.body.attachments[0].id;
    return { accessToken, attachmentId };
  }

  it("serves an attachment via a Bearer header, like any other API route", async () => {
    const { accessToken, attachmentId } = await sendAnImage("joao@test.dev");
    const res = await request(app).get(`/api/messages/attachments/${attachmentId}/download`).set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("fake-png-bytes");
  });

  it("also serves an attachment via a ?token= query param — needed because <img>/<video>/<audio> tags can't send an Authorization header", async () => {
    const { accessToken, attachmentId } = await sendAnImage("joao2@test.dev");
    const res = await request(app).get(`/api/messages/attachments/${attachmentId}/download?token=${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("fake-png-bytes");
  });

  it("refuses to serve an attachment with no token at all", async () => {
    const { attachmentId } = await sendAnImage("joao3@test.dev");
    const res = await request(app).get(`/api/messages/attachments/${attachmentId}/download`);
    expect(res.status).toBe(401);
  });

  it("still enforces per-agent conversation access on the query-token path", async () => {
    const { attachmentId } = await sendAnImage("joao4@test.dev");
    await createTestUser({ email: "outsider@test.dev", role: "AGENT", displayName: "Outsider", whatsappConnectionId: connectionId });
    const { accessToken: outsiderToken } = await loginAs("outsider@test.dev");

    const res = await request(app).get(`/api/messages/attachments/${attachmentId}/download?token=${outsiderToken}`);
    expect(res.status).toBe(403);
  });

  it("lets an agent open the files of the contact's earlier conversations, which are shown in the same chat history", async () => {
    // Joao attended the contact, sent a photo and closed; Maria then starts a new conversation with the same number.
    const { accessToken: joaoToken, attachmentId } = await sendAnImage("joao5@test.dev");
    const oldConversation = await prisma.conversation.findFirstOrThrow();
    await request(app).post(`/api/conversations/${oldConversation.id}/close`).set("Authorization", `Bearer ${joaoToken}`);

    await createTestUser({ email: "maria@test.dev", role: "AGENT", displayName: "Maria", whatsappConnectionId: connectionId });
    const { accessToken: mariaToken } = await loginAs("maria@test.dev");
    const started = await request(app)
      .post("/api/conversations/start")
      .set("Authorization", `Bearer ${mariaToken}`)
      .send({ phone: "5511990009999", whatsappConnectionId: connectionId });
    expect(started.status).toBe(201);

    const res = await request(app).get(`/api/messages/attachments/${attachmentId}/download?token=${mariaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("fake-png-bytes");
  });
});
