import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";
import { verifyAndIngestOfficialWebhook } from "../src/modules/whatsapp/whatsapp.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

async function createOfficialConnection(token: string, name: string, overrides: Partial<{ phoneNumberId: string; wabaId: string; appId: string }> = {}) {
  const res = await request(app)
    .post("/api/whatsapp/connections")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name,
      official: {
        phoneNumberId: overrides.phoneNumberId ?? "1029384756",
        wabaId: overrides.wabaId ?? "893021187",
        accessToken: "fake-token",
        appSecret: "fake-app-secret",
      },
    });
  if (overrides.appId) {
    await prisma.whatsAppConnection.update({ where: { id: res.body.id }, data: { appId: overrides.appId } });
  }
  return res.body.id as string;
}

/** Routes graph.facebook.com fetch calls by path shape — the tests below only ever need one or two calls in flight per test. */
function mockGraphApi(handlers: { match: RegExp; response: unknown; status?: number }[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    const hit = handlers.find((h) => h.match.test(url));
    if (!hit) throw new Error(`Unexpected fetch() call in test: ${url}`);
    return new Response(JSON.stringify(hit.response), { status: hit.status ?? 200 });
  });
}

describe("Message Templates — see PROMPT: nova aba Templates (Marketing/Utilidade/Autenticação)", () => {
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

  it("creates a text-header template, submits it to Meta, and stores the returned status/id", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial");

    mockGraphApi([{ match: /message_templates$/, response: { id: "meta-tpl-1", status: "PENDING" } }]);

    const res = await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "boas_vindas_vendas")
      .field("category", "MARKETING")
      .field("language", "pt_BR")
      .field("headerType", "TEXT")
      .field("headerText", "Bem-vindo!")
      .field("bodyText", "Olá {{1}}, confira nossas promoções.")
      .field("whatsappConnectionId", connectionId);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.headerType).toBe("TEXT");

    const stored = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.metaTemplateId).toBe("meta-tpl-1");
  });

  it("uploads a media header sample via the Resumable Upload API before submitting the template", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial", { appId: "app-123" });

    const fetchMock = mockGraphApi([
      { match: /\/app-123\/uploads\?/, response: { id: "upload:xyz" } },
      { match: /\/upload:xyz$/, response: { h: "HANDLE_ABC" } },
      { match: /message_templates$/, response: { id: "meta-tpl-2", status: "PENDING" } },
    ]);

    const res = await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "promo_imagem")
      .field("category", "MARKETING")
      .field("language", "pt_BR")
      .field("headerType", "IMAGE")
      .field("bodyText", "Confira nossa promoção!")
      .field("whatsappConnectionId", connectionId)
      .attach("headerSample", Buffer.from("fake-jpeg-bytes"), { filename: "promo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(201);
    expect(res.body.headerSampleFileName).toBe("promo.jpg");
    expect(res.body.headerSampleUrl).toMatch(/^\/uploads\/message-templates\//);

    // The final submission call must carry the header_handle the upload returned.
    const submitCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("message_templates"));
    const submitBody = JSON.parse((submitCall![1] as RequestInit).body as string);
    expect(submitBody.components.find((c: { type: string }) => c.type === "HEADER").example.header_handle).toEqual(["HANDLE_ABC"]);
  });

  it("rejects an image/video header with no file attached", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial");

    const res = await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "sem_arquivo")
      .field("category", "MARKETING")
      .field("language", "pt_BR")
      .field("headerType", "IMAGE")
      .field("bodyText", "Texto")
      .field("whatsappConnectionId", connectionId);

    expect(res.status).toBe(400);
  });

  it("refuses to create a template on a QRCODE connection", async () => {
    const token = await loginAs("admin@test.dev");
    const qrConnection = await createTestConnection("Suporte QR");

    const res = await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "teste")
      .field("category", "UTILITY")
      .field("language", "pt_BR")
      .field("headerType", "NONE")
      .field("bodyText", "Texto")
      .field("whatsappConnectionId", qrConnection.id);

    expect(res.status).toBe(400);
  });

  it("when Meta rejects the submission outright, the template stays saved as DRAFT instead of being lost", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial");

    mockGraphApi([{ match: /message_templates$/, response: { error: { message: "Invalid component" } }, status: 400 }]);

    const res = await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "vai_falhar")
      .field("category", "MARKETING")
      .field("language", "pt_BR")
      .field("headerType", "NONE")
      .field("bodyText", "Texto")
      .field("whatsappConnectionId", connectionId);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
  });

  it("a status-update webhook moves an approved template from PENDING to APPROVED", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial", { wabaId: "waba-status-1" });
    mockGraphApi([{ match: /message_templates$/, response: { id: "meta-tpl-3", status: "PENDING" } }]);

    await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "aguardando_aprovacao")
      .field("category", "UTILITY")
      .field("language", "pt_BR")
      .field("headerType", "NONE")
      .field("bodyText", "Seu pedido foi atualizado.")
      .field("whatsappConnectionId", connectionId);

    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "waba-status-1", changes: [{ field: "message_template_status_update", value: { event: "APPROVED", message_template_id: "meta-tpl-3" } }] }],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = "sha256=" + createHmac("sha256", "fake-app-secret").update(raw).digest("hex");
    await verifyAndIngestOfficialWebhook(raw, signature, payload);

    const stored = await prisma.messageTemplate.findFirstOrThrow({ where: { metaTemplateId: "meta-tpl-3" } });
    expect(stored.status).toBe("APPROVED");
  });

  it("a rejection webhook stores the reason Meta gave", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial", { wabaId: "waba-status-2" });
    mockGraphApi([{ match: /message_templates$/, response: { id: "meta-tpl-4", status: "PENDING" } }]);

    await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "sera_rejeitado")
      .field("category", "MARKETING")
      .field("language", "pt_BR")
      .field("headerType", "NONE")
      .field("bodyText", "Oferta imperdível!")
      .field("whatsappConnectionId", connectionId);

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-status-2",
          changes: [{ field: "message_template_status_update", value: { event: "REJECTED", message_template_id: "meta-tpl-4", reason: "INCORRECT_CATEGORY" } }],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = "sha256=" + createHmac("sha256", "fake-app-secret").update(raw).digest("hex");
    await verifyAndIngestOfficialWebhook(raw, signature, payload);

    const stored = await prisma.messageTemplate.findFirstOrThrow({ where: { metaTemplateId: "meta-tpl-4" } });
    expect(stored.status).toBe("REJECTED");
    expect(stored.rejectionReason).toBe("INCORRECT_CATEGORY");
  });

  it("deletes a template locally even when the Meta-side delete call fails", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial");
    mockGraphApi([
      { match: /message_templates$/, response: { id: "meta-tpl-5", status: "APPROVED" } },
      { match: /message_templates\?name=/, response: { error: { message: "nope" } }, status: 403 },
    ]);

    const create = await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "para_excluir")
      .field("category", "UTILITY")
      .field("language", "pt_BR")
      .field("headerType", "NONE")
      .field("bodyText", "Texto")
      .field("whatsappConnectionId", connectionId);

    const del = await request(app).delete(`/api/message-templates/${create.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const stored = await prisma.messageTemplate.findUnique({ where: { id: create.body.id } });
    expect(stored).toBeNull();
  });

  it("lists templates filtered by connection and category", async () => {
    const token = await loginAs("admin@test.dev");
    const connectionId = await createOfficialConnection(token, "Vendas — Oficial");
    mockGraphApi([{ match: /message_templates$/, response: { id: "meta-tpl-6", status: "PENDING" } }]);

    await request(app)
      .post("/api/message-templates")
      .set("Authorization", `Bearer ${token}`)
      .field("name", "utilidade_1")
      .field("category", "UTILITY")
      .field("language", "pt_BR")
      .field("headerType", "NONE")
      .field("bodyText", "Texto")
      .field("whatsappConnectionId", connectionId);

    const res = await request(app).get("/api/message-templates").query({ whatsappConnectionId: connectionId, category: "UTILITY" }).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("utilidade_1");

    const empty = await request(app).get("/api/message-templates").query({ category: "AUTHENTICATION" }).set("Authorization", `Bearer ${token}`);
    expect(empty.body).toHaveLength(0);
  });
});
