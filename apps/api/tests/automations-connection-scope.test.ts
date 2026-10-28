import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import { createAutoMessageTemplate } from "../src/modules/auto-message-templates/auto-message-templates.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Aceite/Encerramento só disparam nas conexões escolhidas", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("usa a mensagem de aceite da própria conexão e não envia o encerramento de outra conexão", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-scope@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-scope@test.dev");

    const suporte = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteScope" });
    const vendas = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "VendasScope" });
    await request(app).post(`/api/whatsapp/connections/${suporte.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    const ana = await createTestUser({ email: "ana-scope@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: suporte.body.id });
    const anaToken = await loginAs("ana-scope@test.dev");

    await createAutoMessageTemplate({
      trigger: "ACCEPT",
      name: "Geral",
      text: "Aceite geral",
      active: true,
      connectionScope: { allConnections: true, connectionIds: [] },
    });
    await createAutoMessageTemplate({
      trigger: "ACCEPT",
      name: "Só vendas",
      text: "Aceite de vendas",
      active: true,
      connectionScope: { allConnections: false, connectionIds: [vendas.body.id] },
    });
    await createAutoMessageTemplate({
      trigger: "ACCEPT",
      name: "Só suporte",
      text: "Aceite do suporte",
      active: true,
      connectionScope: { allConnections: false, connectionIds: [suporte.body.id] },
    });
    await createClosingMessage({
      name: "Encerramento de vendas",
      text: "Tchau de vendas",
      active: true,
      userIds: [ana.id],
      connectionScope: { allConnections: false, connectionIds: [vendas.body.id] },
    });

    const { conversation } = await createWaitingConversation("5511990007777", suporte.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${anaToken}`);
    const provider = __getProviderForTests(suporte.body.id) as MockWhatsAppProvider;
    expect(provider.sentTexts.at(-1)?.text).toContain("Aceite do suporte");

    const sentBeforeClose = provider.sentTexts.length;
    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`);
    expect(closeRes.status).toBe(200);
    expect(provider.sentTexts.length).toBe(sentBeforeClose);
  }, 10000);
});
