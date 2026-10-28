import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { isSessionActive } from "../src/lib/session";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body as { accessToken: string };
}

describe("single active session — a second login instantly kills the first session's access token, not just its refresh token", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("logging in from a second device rejects the first device's still-unexpired access token on the very next request", async () => {
    await createTestUser({ email: "agent-sess@test.dev", role: "AGENT" });

    const first = await loginAs("agent-sess@test.dev");
    const okBefore = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${first.accessToken}`);
    expect(okBefore.status).toBe(200);

    // A second login elsewhere — same account, e.g. a different phone/computer.
    const second = await loginAs("agent-sess@test.dev");
    expect(second.accessToken).not.toBe(first.accessToken);

    // The FIRST device's access token is still cryptographically valid (not
    // expired) — this is exactly the gap being closed: it must be rejected
    // anyway, right away, not just once it eventually expires on its own.
    const rejectedAfter = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${first.accessToken}`);
    expect(rejectedAfter.status).toBe(401);

    // The second device's own (newer) token keeps working normally.
    const stillOk = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${second.accessToken}`);
    expect(stillOk.status).toBe(200);
  });

  it("an admin's force-logout also instantly rejects the target's already-issued access token, not just their refresh cookie", async () => {
    await createTestUser({ email: "admin-sess@test.dev", role: "ADMIN" });
    const target = await createTestUser({ email: "agent-sess2@test.dev", role: "AGENT" });
    const adminToken = (await loginAs("admin-sess@test.dev")).accessToken;
    const targetToken = (await loginAs("agent-sess2@test.dev")).accessToken;

    const before = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${targetToken}`);
    expect(before.status).toBe(200);

    const forceLogout = await request(app)
      .post(`/api/users/${target.id}/force-logout`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(forceLogout.status).toBe(204);

    const after = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${targetToken}`);
    expect(after.status).toBe(401);
  });

  it("the attachment-download route (which also accepts the token as a query param) enforces the same single-session rule", async () => {
    const connectionId = (await createTestConnection("Suporte")).id;
    await createTestUser({ email: "agent-sess3@test.dev", role: "AGENT", whatsappConnectionId: connectionId });
    const first = await loginAs("agent-sess3@test.dev");
    const { conversation } = await createWaitingConversation("5511990001111", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${first.accessToken}`);
    const sendRes = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/file`)
      .set("Authorization", `Bearer ${first.accessToken}`)
      .attach("file", Buffer.from("fake-png-bytes"), { filename: "foto.png", contentType: "image/png" });
    const attachmentId: string = sendRes.body.attachments[0].id;

    const downloadBefore = await request(app).get(`/api/messages/attachments/${attachmentId}/download?token=${first.accessToken}`);
    expect(downloadBefore.status).toBe(200);

    // Second login elsewhere revokes the first session.
    await loginAs("agent-sess3@test.dev");

    const downloadAfter = await request(app).get(`/api/messages/attachments/${attachmentId}/download?token=${first.accessToken}`);
    expect(downloadAfter.status).toBe(401);
  });

  it("refreshing rotates the session id, so the OLD access token stops working the moment a refresh succeeds, even without a second login", async () => {
    await createTestUser({ email: "agent-sess4@test.dev", role: "AGENT" });
    const loginRes = await request(app).post("/api/auth/login").send({ email: "agent-sess4@test.dev", password: TEST_PASSWORD });
    const oldAccessToken = loginRes.body.accessToken as string;
    const cookie = loginRes.headers["set-cookie"][0] as string;

    const refreshRes = await request(app).post("/api/auth/refresh").set("Cookie", cookie);
    expect(refreshRes.status).toBe(200);
    const newAccessToken = refreshRes.body.accessToken as string;
    expect(newAccessToken).not.toBe(oldAccessToken);

    const oldRejected = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${oldAccessToken}`);
    expect(oldRejected.status).toBe(401);
    const newOk = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${newAccessToken}`);
    expect(newOk.status).toBe(200);
  });
});

describe("lib/session — isSessionActive", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is false for an id that doesn't correspond to any RefreshToken row", async () => {
    expect(await isSessionActive("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("is false once the row is revoked, true before that", async () => {
    const user = await createTestUser({ email: "sess-lib@test.dev", role: "AGENT" });
    const row = await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: "irrelevant-hash", expiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await isSessionActive(row.id)).toBe(true);
    await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    expect(await isSessionActive(row.id)).toBe(false);
  });

  it("is false once past its own expiresAt, even if never explicitly revoked", async () => {
    const user = await createTestUser({ email: "sess-lib2@test.dev", role: "AGENT" });
    const row = await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: "irrelevant-hash-2", expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await isSessionActive(row.id)).toBe(false);
  });
});
