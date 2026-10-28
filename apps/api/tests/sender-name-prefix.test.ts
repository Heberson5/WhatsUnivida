import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { withSenderPrefix, __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("withSenderPrefix (pure formatting)", () => {
  it("prefixes the WhatsApp-bold agent name ahead of the text, separated by a blank line", () => {
    expect(withSenderPrefix("Joao", "Ola, em que posso ajudar?")).toBe("*Joao:*\n\nOla, em que posso ajudar?");
  });
});

describe("outbound WhatsApp sends carry the sending agent's display name", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("prefixes the text/caption actually sent to WhatsApp, while the stored/returned message body stays exactly what the agent typed", async () => {
    // Regression: multiple agents share one connected WhatsApp number, so a
    // customer had no way to tell who they were talking to from message to
    // message — see whatsapp.service.ts withSenderPrefix.
    await resetDatabase();
    await createTestUser({ email: "admin-prefix@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-prefix@test.dev");
    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "SuportePrefix" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    await createTestUser({
      email: "joao-prefix@test.dev",
      role: "AGENT",
      displayName: "Joao Pereira",
      whatsappConnectionId: created.body.id,
    });
    const joaoToken = await loginAs("joao-prefix@test.dev");

    const { conversation } = await createWaitingConversation("5511990001234", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${joaoToken}`);

    const textRes = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/text`)
      .set("Authorization", `Bearer ${joaoToken}`)
      .send({ body: "Ola, em que posso ajudar?" });
    expect(textRes.status).toBe(201);
    expect(textRes.body.body).toBe("Ola, em que posso ajudar?"); // unprefixed in the app itself

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    expect(provider.sentTexts.at(-1)?.text).toBe("*Joao Pereira:*\n\nOla, em que posso ajudar?");

    const fileRes = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/file`)
      .set("Authorization", `Bearer ${joaoToken}`)
      .field("caption", "Segue o comprovante")
      .attach("file", Buffer.from("fake-image-bytes"), { filename: "comprovante.jpg", contentType: "image/jpeg" });
    expect(fileRes.status).toBe(201);
    expect(fileRes.body.body).toBe("Segue o comprovante"); // unprefixed in the app itself
    expect(provider.sentFiles.at(-1)?.caption).toBe("*Joao Pereira:*\n\nSegue o comprovante");
  }, 10000);
});
