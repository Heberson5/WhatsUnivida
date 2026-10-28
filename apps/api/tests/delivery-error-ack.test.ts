import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import { deliveryEventFromBaileysUpdate, type MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { createApp } from "../src/app";
import { logger } from "../src/lib/logger";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("Baileys messages.update → delivery event", () => {
  const key = { id: "3EB0ABC", remoteJid: "5511990001111@s.whatsapp.net" };

  it("reports a message WhatsApp's server rejected (status 0 = ERROR) as failed, with the error code it sent", () => {
    // Baileys' handleBadAck: { status: WAMessageStatus.ERROR, messageStubParameters: [attrs.error] }
    const event = deliveryEventFromBaileysUpdate({ key, update: { status: 0, messageStubParameters: ["479"] } });
    expect(event).toMatchObject({ providerMessageId: "3EB0ABC", chatId: "5511990001111@s.whatsapp.net", status: "FAILED", errorCode: "479" });
  });

  it("still reports a rejection that came with no code", () => {
    const event = deliveryEventFromBaileysUpdate({ key, update: { status: 0 } });
    expect(event?.status).toBe("FAILED");
    expect(event).not.toHaveProperty("errorCode");
  });

  it("keeps reporting delivered, read and played", () => {
    expect(deliveryEventFromBaileysUpdate({ key, update: { status: 3 } })?.status).toBe("DELIVERED");
    expect(deliveryEventFromBaileysUpdate({ key, update: { status: 4 } })?.status).toBe("READ");
    expect(deliveryEventFromBaileysUpdate({ key, update: { status: 5 } })?.status).toBe("READ");
  });

  it("says nothing for an update that is not about delivery", () => {
    expect(deliveryEventFromBaileysUpdate({ key, update: {} })).toBeNull();
    expect(deliveryEventFromBaileysUpdate({ key, update: { status: null } })).toBeNull();
    expect(deliveryEventFromBaileysUpdate({ key, update: { status: 1 } })).toBeNull(); // PENDING
    expect(deliveryEventFromBaileysUpdate({ key, update: { status: 2 } })).toBeNull(); // SERVER_ACK: the SENT already recorded when it was sent
  });
});

describe("a message WhatsApp rejects after accepting it", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function loginAs(email: string) {
    const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  }

  async function until(check: () => Promise<boolean>, what: string) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for: ${what}`);
  }

  it("is marked failed (and logged with the code) unless the phone already confirmed it", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-ack@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-ack@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteAck" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    await createTestUser({ email: "agente-ack@test.dev", role: "AGENT", displayName: "Agente Ack", whatsappConnectionId: created.body.id });
    const agentToken = await loginAs("agente-ack@test.dev");
    const { conversation } = await createWaitingConversation("5511990007777", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);

    const sent = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/file`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("file", Buffer.from("fake-png-bytes"), { filename: "foto.png", contentType: "image/png" });
    expect(sent.status).toBe(201);
    const messageId: string = sent.body.id;
    const statusOf = async () => (await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).status;
    const { providerMessageId } = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(providerMessageId).toBeTruthy();

    // A single ✓ is all the app knows right after sending (the mock never confirms a file on its own).
    expect(await statusOf()).toBe("SENT");

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    const warn = vi.spyOn(logger, "warn");
    provider.simulateDelivery({ providerMessageId: providerMessageId!, chatId: `${"5511990007777"}@s.whatsapp.net`, status: "FAILED", errorCode: "479" });
    await until(async () => (await statusOf()) === "FAILED", "the rejected message to be marked failed");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "479", providerMessageId }), expect.stringContaining("rejected"));

    // If the phone does confirm it after all, the confirmation wins...
    provider.simulateDelivery({ providerMessageId: providerMessageId!, chatId: `${"5511990007777"}@s.whatsapp.net`, status: "DELIVERED" });
    await until(async () => (await statusOf()) === "DELIVERED", "the delivery receipt");

    // ...and a rejection arriving after that never takes it back.
    provider.simulateDelivery({ providerMessageId: providerMessageId!, chatId: `${"5511990007777"}@s.whatsapp.net`, status: "FAILED", errorCode: "479" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOf()).toBe("DELIVERED");
    warn.mockRestore();
  }, 20000);
});
