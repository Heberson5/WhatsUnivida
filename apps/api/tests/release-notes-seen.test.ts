import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("profile: release notes seen", () => {
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    await createTestUser({ email: "agent@test.dev", role: "AGENT" });
    token = (await request(app).post("/api/auth/login").send({ email: "agent@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores the newest seen version and returns it on the profile", async () => {
    const before = await request(app).get("/api/profile").set("Authorization", `Bearer ${token}`);
    expect(before.body.releaseNotesSeenVersion).toBeNull();

    const res = await request(app).patch("/api/profile/release-notes-seen").set("Authorization", `Bearer ${token}`).send({ version: "2.0.0" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ releaseNotesSeenVersion: "2.0.0" });

    const after = await request(app).get("/api/profile").set("Authorization", `Bearer ${token}`);
    expect(after.body.releaseNotesSeenVersion).toBe("2.0.0");
  });

  it("rejects anything that isn't a x.y.z version", async () => {
    const res = await request(app).patch("/api/profile/release-notes-seen").set("Authorization", `Bearer ${token}`).send({ version: "latest" });
    expect(res.status).toBe(400);
  });
});
