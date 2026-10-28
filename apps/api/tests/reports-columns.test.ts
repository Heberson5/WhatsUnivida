import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("reports: column selection (view + export)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns every column by default, and only the requested ones (in the requested order) when 'columns' is set", async () => {
    await createTestUser({ email: "admin8@test.dev", role: "ADMIN" });
    const token = await loginAs("admin8@test.dev");
    const connection = await createTestConnection("Suporte");
    await createWaitingConversation("5511990001234", connection.id);

    const full = await request(app).get("/api/reports/attendance").set("Authorization", `Bearer ${token}`).query({ period: "month" });
    expect(full.status).toBe(200);
    expect(full.body.length).toBe(1);
    expect(Object.keys(full.body[0])).toEqual(
      expect.arrayContaining(["Data", "Conexão", "Cliente", "Telefone", "Atendente", "Status"])
    );

    const narrowed = await request(app)
      .get("/api/reports/attendance")
      .set("Authorization", `Bearer ${token}`)
      .query({ period: "month", columns: "Cliente,Status" });
    expect(narrowed.status).toBe(200);
    expect(Object.keys(narrowed.body[0])).toEqual(["Cliente", "Status"]);
  });

  it("also narrows the CSV export to the requested columns", async () => {
    await createTestUser({ email: "admin9@test.dev", role: "ADMIN" });
    const token = await loginAs("admin9@test.dev");
    const connection = await createTestConnection("Vendas");
    await createWaitingConversation("5511990005678", connection.id);

    const res = await request(app)
      .get("/api/reports/attendance")
      .set("Authorization", `Bearer ${token}`)
      .query({ period: "month", format: "csv", columns: "Cliente,Telefone" });
    expect(res.status).toBe(200);
    const firstLine = res.text.split("\n")[0];
    expect(firstLine).toBe("Cliente,Telefone");
  });
});
