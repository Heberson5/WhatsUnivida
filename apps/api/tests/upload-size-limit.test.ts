import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const MB = 1024 * 1024;

describe("sending a file: size limit", () => {
  let accessToken: string;
  let conversationId: string;

  beforeEach(async () => {
    await resetDatabase();
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connection.id });
    accessToken = (await request(app).post("/api/auth/login").send({ email: "joao@test.dev", password: TEST_PASSWORD })).body.accessToken;
    const { conversation } = await createWaitingConversation("5511990009999", connection.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${accessToken}`);
    conversationId = conversation.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function sendFile(bytes: number, filename: string, contentType: string) {
    return request(app)
      .post(`/api/messages/conversations/${conversationId}/file`)
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.alloc(bytes, 1), { filename, contentType });
  }

  it("sends a video well past 1 MB — the API itself puts no such cap on it (that one lived in nginx)", async () => {
    const res = await sendFile(3 * MB, "video.mp4", "video/mp4");
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("VIDEO");
    expect(res.body.attachments[0].sizeBytes).toBe(3 * MB);
  });

  it("sends a file right at the limit", async () => {
    const res = await sendFile(env.UPLOAD_MAX_SIZE_MB * MB, "relatorio.pdf", "application/pdf");
    expect(res.status).toBe(201);
  });

  it("refuses a file over the limit with a clear message, and records nothing", async () => {
    // Counted before, not expected to be 0: accepting the conversation may already have sent its own welcome message.
    const before = await prisma.message.count({ where: { conversationId } });
    const res = await sendFile(env.UPLOAD_MAX_SIZE_MB * MB + 1, "video.mp4", "video/mp4");
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Arquivo muito grande");
    expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
  });
});
