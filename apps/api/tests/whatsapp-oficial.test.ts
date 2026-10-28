import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";
import { verifyAndIngestOfficialWebhook } from "../src/modules/whatsapp/whatsapp.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

/** Mocks the two Graph API calls CloudApiWhatsAppProvider.connect() makes to validate credentials. */
function mockGraphApiPhoneNumberInfo(displayPhoneNumber = "+55 11 91234-5678", verifiedName = "Minha Empresa") {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ display_phone_number: displayPhoneNumber, verified_name: verifiedName }), { status: 200 })
  );
}

/**
 * The real POST /oficial/webhook route acks 200 before awaiting ingestion
 * (same "never make Meta wait" precedent as meta.routes.ts's own webhook —
 * see its own comment), so a test driving that route over HTTP would be
 * racing the response against the DB writes with no reliable signal for
 * when ingestion actually finished. meta-webhook.test.ts sidesteps the same
 * issue by calling processWebhookPayload directly instead of going through
 * the route for its message-delivery assertions — this does the same with
 * verifyAndIngestOfficialWebhook, keeping the HTTP layer tested only for
 * the synchronous GET handshake, where no such race exists.
 */
async function pollUntil(check: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe("WhatsApp Oficial (Cloud API) connections — see PROMPT: inclua uma nova aba chamada WhatsApp Oficial", () => {
  beforeEach(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates an OFFICIAL_API connection and never echoes the raw access token/app secret back", async () => {
    const token = await loginAs("admin@test.dev");
    const res = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Vendas — Oficial",
        official: { phoneNumberId: "1029384756", wabaId: "893021187", accessToken: "EAAG-secret-token", appSecret: "app-secret-value", webhookVerifyToken: "verify-me" },
      });

    expect(res.status).toBe(201);
    expect(res.body.connectionMode).toBe("OFFICIAL_API");
    expect(res.body.phoneNumberId).toBe("1029384756");
    expect(res.body.hasAccessToken).toBe(true);
    expect(res.body.hasAppSecret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("EAAG-secret-token");
    expect(JSON.stringify(res.body)).not.toContain("app-secret-value");

    const stored = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.accessToken).not.toBe("EAAG-secret-token"); // encrypted at rest
    expect(stored.accessToken?.startsWith("enc:v1:")).toBe(true);
  });

  it("connecting validates credentials against the Graph API and resolves the real display number", async () => {
    const token = await loginAs("admin@test.dev");
    const create = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Suporte — Oficial", official: { phoneNumberId: "555", wabaId: "waba-1", accessToken: "tok" } });
    const connectionId = create.body.id;

    const fetchMock = mockGraphApiPhoneNumberInfo("+55 21 90000-0000", "Suporte Oficial Ltda");

    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${token}`);
    // connect() runs fire-and-forget on the route (same precedent as every
    // other connection mode's connect/reconnect route) — poll instead of a
    // fixed sleep so this can't flake under load.
    await pollUntil(async () => {
      const row = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: connectionId } });
      return row.status === "CONNECTED";
    });

    const summary = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`);
    const conn = summary.body.find((c: { id: string }) => c.id === connectionId);
    expect(conn.state).toBe("CONNECTED");
    expect(conn.connectedNumber).toBe("+55 21 90000-0000");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("555"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }));
  });

  it("GET /oficial/webhook echoes hub.challenge only when hub.verify_token matches a configured connection", async () => {
    const token = await loginAs("admin@test.dev");
    await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Vendas — Oficial", official: { phoneNumberId: "111", wabaId: "w1", accessToken: "tok", webhookVerifyToken: "s3cret-verify" } });

    const ok = await request(app)
      .get("/api/whatsapp/oficial/webhook")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "s3cret-verify", "hub.challenge": "999" });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("999");

    const wrong = await request(app)
      .get("/api/whatsapp/oficial/webhook")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "999" });
    expect(wrong.status).toBe(403);
  });

  it("POST /oficial/webhook always acks 200 immediately, even for a payload naming no known connection", async () => {
    // Covers the route's own rawBody/header wiring (the two tests below
    // cover the actual ingestion logic directly — see pollUntil's comment
    // for why) without racing the fire-and-forget ingestion it kicks off.
    const res = await request(app)
      .post("/api/whatsapp/oficial/webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
    expect(res.status).toBe(200);
  });

  it("an inbound text message delivered via a correctly-signed webhook lands in the shared queue", async () => {
    const token = await loginAs("admin@test.dev");
    const create = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Vendas — Oficial", official: { phoneNumberId: "222", wabaId: "w2", accessToken: "tok", appSecret: "shh-secret" } });
    const connectionId = create.body.id;

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w2",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "222" },
                contacts: [{ wa_id: "5511988887777", profile: { name: "Maria Cliente" } }],
                messages: [{ id: "wamid.abc", from: "5511988887777", timestamp: `${Math.floor(Date.now() / 1000)}`, type: "text", text: { body: "Preciso de ajuda" } }],
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = "sha256=" + createHmac("sha256", "shh-secret").update(raw).digest("hex");

    await verifyAndIngestOfficialWebhook(raw, signature, payload);

    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: "5511988887777", whatsappConnectionId: connectionId } });
    const message = await prisma.message.findUniqueOrThrow({ where: { providerMessageId: "wamid.abc" } });
    expect(message.body).toBe("Preciso de ajuda");
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(conversation.status).toBe("NEW");
  });

  it("rejects a webhook event whose signature doesn't match the connection's app secret", async () => {
    const token = await loginAs("admin@test.dev");
    await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Vendas — Oficial", official: { phoneNumberId: "333", wabaId: "w3", accessToken: "tok", appSecret: "real-secret" } });

    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "w3", changes: [{ field: "messages", value: { metadata: { phone_number_id: "333" }, messages: [{ id: "wamid.xyz", from: "5511900000000", timestamp: `${Math.floor(Date.now() / 1000)}`, type: "text", text: { body: "forjado" } }] } }] }],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const badSignature = "sha256=" + createHmac("sha256", "wrong-secret").update(raw).digest("hex");

    await verifyAndIngestOfficialWebhook(raw, badSignature, payload);

    const message = await prisma.message.findUnique({ where: { providerMessageId: "wamid.xyz" } });
    expect(message).toBeNull();
  });

  it("a QRCODE connection is unaffected — still created with no official fields", async () => {
    const token = await loginAs("admin@test.dev");
    const res = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Suporte Geral" });
    expect(res.status).toBe(201);
    expect(res.body.connectionMode).toBe("QRCODE");
    expect(res.body.hasAccessToken).toBe(false);
  });
});
