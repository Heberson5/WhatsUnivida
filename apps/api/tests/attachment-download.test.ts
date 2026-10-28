import { describe, it, expect, beforeEach, afterAll } from "vitest";
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
});
