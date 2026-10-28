import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("the Encerramento closing message now substitutes {{atendente}}/{{atendente_nome}}/{{atendente_cargo}}/{{cliente}}", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("fills the tags with the closing agent's own data and the contact's name", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-closing-tags@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-closing-tags@test.dev");

    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "SuporteClosingTags" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const ana = await createTestUser({
      email: "ana-closing@test.dev",
      role: "AGENT",
      displayName: "Ana",
      whatsappConnectionId: created.body.id,
    });
    await prisma.user.update({ where: { id: ana.id }, data: { fullName: "Ana Paula Souza" } });
    const anaToken = await loginAs("ana-closing@test.dev");

    await createClosingMessage({
      name: "Padrão",
      text: "Obrigado, *{{cliente}}*! Você foi atendido por *{{atendente_nome}}* ({{atendente_cargo}}).",
      active: true,
      userIds: [ana.id],
      connectionScope: { allConnections: true, connectionIds: [] },
    });

    const { conversation, contact } = await createWaitingConversation("5511990004321", created.body.id);
    await prisma.contact.update({ where: { id: contact.id }, data: { name: "Joana Cliente" } });
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${anaToken}`);

    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`);
    expect(closeRes.status).toBe(200);

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    const lastText = provider.sentTexts.at(-1)?.text ?? "";
    console.log("sent to WhatsApp:", lastText);

    expect(lastText).toContain("*Ana:*");
    expect(lastText).toContain("Obrigado, *Joana Cliente*! Você foi atendido por *Ana Paula Souza* (Atendente).");
  }, 10000);

  it("sem o nome do atendente no topo quando o encerramento está assim", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-closing-noname@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-closing-noname@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteSemNome" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const ana = await createTestUser({ email: "ana-noname@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: created.body.id });
    const anaToken = await loginAs("ana-noname@test.dev");
    await createClosingMessage({
      name: "Sem nome",
      text: "Obrigado pelo contato!",
      active: true,
      showSenderName: false,
      userIds: [ana.id],
      connectionScope: { allConnections: true, connectionIds: [] },
    });

    const { conversation } = await createWaitingConversation("5511990004322", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${anaToken}`);
    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${anaToken}`);
    expect(closeRes.status).toBe(200);

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    expect(provider.sentTexts.at(-1)?.text).toBe("Obrigado pelo contato!");
  }, 10000);
});
