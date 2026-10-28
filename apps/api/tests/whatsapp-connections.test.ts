import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";
import { findOrCreateContact } from "../src/modules/conversations/conversations.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("multi-WhatsApp connections", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("treats the same phone number on two different connections as two separate contacts", async () => {
    const suporte = await createTestConnection("Suporte");
    const vendas = await createTestConnection("Vendas");

    const contactA = await findOrCreateContact(suporte.id, "5511900001111", "Cliente");
    const contactB = await findOrCreateContact(vendas.id, "5511900001111", "Cliente");

    expect(contactA.id).not.toBe(contactB.id);
    expect(contactA.whatsappConnectionId).toBe(suporte.id);
    expect(contactB.whatsappConnectionId).toBe(vendas.id);

    // Re-resolving the same phone+connection pair returns the same row, not a duplicate.
    const contactAAgain = await findOrCreateContact(suporte.id, "5511900001111", null);
    expect(contactAAgain.id).toBe(contactA.id);
  });

  it("ADMIN can create, list, rename and delete a WhatsApp connection", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const token = await loginAs("admin@test.dev");

    const createRes = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Financeiro" });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe("Financeiro");
    expect(createRes.body.state).toBe("DISCONNECTED");

    const listRes = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`);
    expect(listRes.body.map((c: { name: string }) => c.name)).toContain("Financeiro");

    const renameRes = await request(app)
      .patch(`/api/whatsapp/connections/${createRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Financeiro - Cobranca" });
    expect(renameRes.body.name).toBe("Financeiro - Cobranca");

    const deleteRes = await request(app).delete(`/api/whatsapp/connections/${createRes.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);
  });

  it("rejects creating a connection with a name already in use", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const token = await loginAs("admin@test.dev");
    await createTestConnection("Suporte");

    const res = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Suporte" });
    expect(res.status).toBe(409);
  });

  it("refuses to delete a connection that still has agents assigned to it", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const token = await loginAs("admin@test.dev");
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "joao@test.dev", role: "AGENT", whatsappConnectionId: connection.id });

    const res = await request(app).delete(`/api/whatsapp/connections/${connection.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("forbids a non-admin from managing connections", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT" });
    const token = await loginAs("joao@test.dev");
    const res = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Nova" });
    expect(res.status).toBe(403);
  });

  it("requires a whatsappConnectionId when creating an AGENT, but not for ADMIN/MANAGER", async () => {
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    const token = await loginAs("admin@test.dev");
    const connection = await createTestConnection("Suporte");

    const missingConnection = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Novo Atendente", displayName: "Novo", email: "novo@test.dev", password: "***REMOVIDO***", confirmPassword: "***REMOVIDO***", role: "AGENT" });
    expect(missingConnection.status).toBe(400);

    const withConnection = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "Novo Atendente",
        displayName: "Novo",
        email: "novo@test.dev",
        password: "***REMOVIDO***",
        confirmPassword: "***REMOVIDO***",
        role: "AGENT",
        whatsappConnectionId: connection.id,
      });
    expect(withConnection.status).toBe(201);
    expect(withConnection.body.whatsappConnectionName).toBe("Suporte");

    const manager = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Gestora", displayName: "Gestora", email: "gestora2@test.dev", password: "***REMOVIDO***", confirmPassword: "***REMOVIDO***", role: "MANAGER" });
    expect(manager.status).toBe(201);
    expect(manager.body.whatsappConnectionId).toBeNull();
  });
});
