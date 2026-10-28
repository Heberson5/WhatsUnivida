import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("the TRANSFER auto-message is sent as whoever initiated the transfer, using their registered fullName", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("prefixes the WhatsApp text and tags the stored Message with the FROM agent's fullName — not the receiving agent's displayName", async () => {
    // See PROMPT: "o nome de quem está transferindo a conversa apareça no
    // topo, atualmente esta aparecendo de quem vai receber" + "a mensagem
    // precisa trazer o nome que está cadastrado lá no usuário, não o nome
    // de exibição".
    await resetDatabase();
    await createTestUser({ email: "admin-transfer-id@test.dev", role: "ADMIN" });
    const adminToken = await loginAs("admin-transfer-id@test.dev");

    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "SuporteTransferId" });
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s

    const gislaine = await createTestUser({
      email: "gislaine@test.dev",
      role: "AGENT",
      displayName: "Gislaine",
      whatsappConnectionId: created.body.id,
    });
    await prisma.user.update({ where: { id: gislaine.id }, data: { fullName: "Gislaine Souza Pereira" } });
    const gislaineToken = await loginAs("gislaine@test.dev");

    const administrador = await createTestUser({
      email: "administrador@test.dev",
      role: "AGENT",
      displayName: "Administrador",
      whatsappConnectionId: created.body.id,
      presence: "ONLINE",
    });
    await prisma.user.update({ where: { id: administrador.id }, data: { fullName: "Carlos Administrador Neto" } });

    await prisma.autoMessageTemplate.create({
      data: {
        trigger: "TRANSFER",
        name: "Transferência padrão",
        text: "Esta conversa foi transferida para {{atendente}}. Em breve você será atendido(a).",
        active: true,
      },
    });

    const { conversation } = await createWaitingConversation("5511990009999", created.body.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${gislaineToken}`);

    const transferRes = await request(app)
      .post(`/api/conversations/${conversation.id}/transfer`)
      .set("Authorization", `Bearer ${gislaineToken}`)
      .send({ toAgentId: administrador.id });
    expect(transferRes.status).toBe(200);

    const provider = __getProviderForTests(created.body.id) as MockWhatsAppProvider;
    const lastText = provider.sentTexts.at(-1)?.text ?? "";
    console.log("sent to WhatsApp:", lastText);

    // Sender prefix: the FROM agent's registered fullName, not displayName.
    expect(lastText.startsWith("*Gislaine Souza Pereira:*")).toBe(true);
    expect(lastText).not.toContain("Administrador:*");
    // Body content: still names who the customer will be attended by.
    expect(lastText).toContain("transferida para Administrador");

    const lastMessage = await prisma.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      include: { senderAgent: true },
    });
    console.log("stored message senderAgent:", lastMessage?.senderAgent?.displayName);
    expect(lastMessage?.senderAgentId).toBe(gislaine.id);
  }, 10000);
});
