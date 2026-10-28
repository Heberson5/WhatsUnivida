import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("a contact stuck on @lid digits self-heals once WhatsApp reveals the real phone number", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("corrects the contact's phone as soon as a chats.update reveals pnJid — the only signal available when the contact was first created from a device-sent message with no phone-resolvable field at all", async () => {
    // Regression: a message sent directly from the linked phone in a
    // brand-new 1:1 chat reports remoteJid as the opaque @lid id with no
    // senderPn/participantPn (those only exist for group chats) — the
    // contact got created with the @lid digits as its "phone" and nothing
    // ever corrected it, since only a read-status chats.update was wired
    // up before, not a plain identity-resolution one.
    await resetDatabase();
    await createTestUser({ email: "admin-identity@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-identity@test.dev");
    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "SuporteIdentity" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    const lidDigits = "177665544332211";
    const chatId = `${lidDigits}@lid`;
    const contact = await prisma.contact.create({
      data: { phone: lidDigits, name: null, whatsappConnectionId: created.body.id, providerChatId: chatId },
    });

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    const realPhone = "5511988882222";
    provider.simulateChatIdentityResolved(chatId, realPhone);
    await wait(50);

    const healed = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(healed.phone).toBe(realPhone);

    const count = await prisma.contact.count({ where: { whatsappConnectionId: created.body.id } });
    expect(count).toBe(1); // corrected in place, not duplicated
  }, 10000);
});
