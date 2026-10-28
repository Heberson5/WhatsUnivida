import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createSurvey, processDueClosingMessages } from "../src/modules/satisfaction/satisfaction.service";
import { CONVERSATION_UNDO_WINDOW_MS, PERMISSION } from "@whatsatendende/types";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
// A real (tiny) PNG — the bytes only need to round-trip.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("Respostas: imagem, vídeo ou PDF nas respostas rápidas e no encerramento", () => {
  let connectionId: string;
  let adminToken: string;
  let managerToken: string;
  let agentToken: string;
  let agentId: string;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-media@test.dev", role: "ADMIN" });
    adminToken = await loginAs("admin-media@test.dev");
    const created = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteMidia" });
    connectionId = created.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;

    await createTestUser({ email: "gestor-media@test.dev", role: "MANAGER", displayName: "Gestor" });
    managerToken = await loginAs("gestor-media@test.dev");
    agentId = (await createTestUser({ email: "ana-media@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId })).id;
    agentToken = await loginAs("ana-media@test.dev");
  }, 20000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function newQuickReply(text = "Segue o nosso catálogo, {{cliente}}.") {
    const res = await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ name: "Catálogo", shortcut: `cat${Date.now()}`, text, connectionScope: { allConnections: true, connectionIds: [] } });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  it("informa os limites do WhatsApp para envio pelo sistema", async () => {
    const res = await request(app).get("/api/quick-replies/media-limits").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imageMb: 5, videoMb: 16, documentMb: Math.min(100, env.UPLOAD_MAX_SIZE_MB) });
  });

  it("o gestor inclui a imagem; ela volta no cadastro e qualquer atendente baixa para usar na conversa", async () => {
    const qr = await newQuickReply();
    const up = await request(app).post(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${managerToken}`).attach("file", PNG, { filename: "catalogo.png", contentType: "image/png" });
    expect(up.status).toBe(200);
    expect(up.body.media).toEqual({ fileName: "catalogo.png", mimeType: "image/png", sizeBytes: PNG.length, kind: "IMAGE" });

    const list = await request(app).get(`/api/quick-replies`).set("Authorization", `Bearer ${managerToken}`);
    expect(list.body.find((r: { id: string }) => r.id === qr.id).media.kind).toBe("IMAGE");

    const file = await request(app).get(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${agentToken}`).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("image/png");
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
  });

  it("o atendente nunca inclui nem remove o anexo — nem com as permissões de Respostas liberadas", async () => {
    const qr = await newQuickReply();
    for (const permission of [PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR, PERMISSION.RESPOSTAS_RAPIDAS_EDITAR, PERMISSION.RESPOSTAS_MIDIA_GERENCIAR]) {
      await request(app)
        .patch("/api/permissions")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ entries: [{ role: "AGENT", permission, allowed: true }] });
    }
    // The media permission is not offered to Atendente at all: the save ignores it.
    const row = await prisma.rolePermission.findUnique({ where: { role_permission: { role: "AGENT", permission: PERMISSION.RESPOSTAS_MIDIA_GERENCIAR } } });
    expect(row).toBeNull();

    const up = await request(app).post(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${agentToken}`).attach("file", PNG, { filename: "x.png", contentType: "image/png" });
    expect(up.status).toBe(403);
    const del = await request(app).delete(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${agentToken}`);
    expect(del.status).toBe(403);
  });

  it("recusa outro tipo de arquivo e vídeo acima de 16 MB, sem comprimir", async () => {
    const qr = await newQuickReply();
    const wrong = await request(app).post(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${managerToken}`).attach("file", Buffer.from("a,b"), { filename: "x.csv", contentType: "text/csv" });
    expect(wrong.status).toBe(400);

    const big = Buffer.alloc(16 * 1024 * 1024 + 1);
    const tooBig = await request(app).post(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${managerToken}`).attach("file", big, { filename: "video.mp4", contentType: "video/mp4" });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.message ?? tooBig.body.error).toMatch(/16 MB/);
    expect((await prisma.quickReply.findUniqueOrThrow({ where: { id: qr.id } })).mediaStorageKey).toBeNull();
  }, 20000);

  it("com anexo, o texto (legenda) fica limitado a 1.024 caracteres", async () => {
    const long = await newQuickReply("x".repeat(1100));
    const up = await request(app).post(`/api/quick-replies/${long.id}/media`).set("Authorization", `Bearer ${managerToken}`).attach("file", PNG, { filename: "a.png", contentType: "image/png" });
    expect(up.status).toBe(400);

    const qr = await newQuickReply();
    await request(app).post(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${managerToken}`).attach("file", PNG, { filename: "a.png", contentType: "image/png" });
    const patch = await request(app).patch(`/api/quick-replies/${qr.id}`).set("Authorization", `Bearer ${managerToken}`).send({ text: "y".repeat(1100) });
    expect(patch.status).toBe(400);
  });

  it("remover o anexo apaga o arquivo", async () => {
    const qr = await newQuickReply();
    await request(app).post(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${managerToken}`).attach("file", PNG, { filename: "a.png", contentType: "image/png" });
    const key = (await prisma.quickReply.findUniqueOrThrow({ where: { id: qr.id } })).mediaStorageKey!;
    expect(fs.existsSync(path.join(env.UPLOAD_DIR, key))).toBe(true);

    const del = await request(app).delete(`/api/quick-replies/${qr.id}/media`).set("Authorization", `Bearer ${managerToken}`);
    expect(del.status).toBe(200);
    expect(del.body.media).toBeNull();
    await waitUntil(() => !fs.existsSync(path.join(env.UPLOAD_DIR, key)));
    expect(fs.existsSync(path.join(env.UPLOAD_DIR, key))).toBe(false);
  });

  async function closingMessageWithImage(text: string) {
    await prisma.closingMessage.deleteMany();
    const created = await request(app)
      .post("/api/closing-messages")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ name: "Com imagem", text, active: true, userIds: [agentId], connectionScope: { allConnections: true, connectionIds: [] } });
    expect(created.status).toBe(201);
    const up = await request(app).post(`/api/closing-messages/${created.body.id}/media`).set("Authorization", `Bearer ${managerToken}`).attach("file", PNG, { filename: "obrigado.png", contentType: "image/png" });
    expect(up.status).toBe(200);
    expect(up.body.media.kind).toBe("IMAGE");
    return created.body.id as string;
  }

  async function acceptedConversation(phone: string) {
    const { conversation } = await createWaitingConversation(phone, connectionId);
    await prisma.contact.update({ where: { id: conversation.contactId }, data: { name: "Joana Cliente" } });
    const res = await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    return conversation;
  }

  const filesTo = (phone: string) => provider.sentFiles.filter((f) => f.chatId.startsWith(`${phone}@`));

  it("sem pesquisa: ao encerrar, a imagem sai na hora com o texto como legenda e fica no histórico", async () => {
    await prisma.satisfactionSurveyConfig.deleteMany();
    await closingMessageWithImage("Obrigado, *{{cliente}}*!");
    const phone = "5511990008101";
    const conversation = await acceptedConversation(phone);

    const closeRes = await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${agentToken}`);
    expect(closeRes.status).toBe(200);
    await waitUntil(() => filesTo(phone).length >= 1);

    expect(filesTo(phone)).toHaveLength(1);
    expect(filesTo(phone)[0].caption).toContain("Obrigado, *Joana Cliente*!");
    const message = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, type: "IMAGE" }, include: { attachments: true } });
    expect(message.body).toContain("Obrigado, *Joana Cliente*!");
    expect(message.attachments[0]?.fileName).toBe("obrigado.png");
    expect(fs.existsSync(path.join(env.UPLOAD_DIR, message.attachments[0]!.storageKey))).toBe(true);
  }, 15000);

  it("com pesquisa: a imagem espera a nota, como o texto, e sai depois dela", async () => {
    await closingMessageWithImage("Foi um prazer, {{cliente}}.");
    await prisma.satisfactionSurveyConfig.deleteMany();
    await createSurvey({
      name: "Pesquisa",
      active: true,
      connectionScope: { allConnections: false, connectionIds: [connectionId] },
      question: "De 0 a 10?",
      thanks: "Obrigado!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
    });
    const phone = "5511990008102";
    const conversation = await acceptedConversation(phone);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await request(app).post(`/api/conversations/${conversation.id}/close`).set("Authorization", `Bearer ${agentToken}`);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await waitUntil(() => provider.sentTexts.some((t) => t.chatId.startsWith(`${phone}@`) && t.text.includes("De 0 a 10?")));

    const survey = await prisma.satisfactionSurvey.findUniqueOrThrow({ where: { conversationId: conversation.id } });
    expect(survey.closingText).toContain("Foi um prazer, Joana Cliente.");
    expect((survey.closingMedia as { fileName: string } | null)?.fileName).toBe("obrigado.png");
    expect(filesTo(phone)).toHaveLength(0);

    provider.simulateIncomingMessage(phone, "9");
    await waitUntil(() => provider.sentTexts.some((t) => t.chatId.startsWith(`${phone}@`) && t.text === "Obrigado!"));
    // Ten seconds after the score, the sweep sends the closing message — the image, with the text as its caption.
    expect(await processDueClosingMessages(new Date(Date.now() + 11_000))).toBe(1);
    expect(filesTo(phone)).toHaveLength(1);
    expect(filesTo(phone)[0].caption).toContain("Foi um prazer, Joana Cliente.");
  }, 30000);

  it("Gestão › Encerrar sem enviar mensagem: nada sai, nem a imagem", async () => {
    await prisma.satisfactionSurveyConfig.deleteMany();
    await closingMessageWithImage("Tchau, {{cliente}}.");
    const phone = "5511990008103";
    const conversation = await acceptedConversation(phone);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const res = await request(app).post(`/api/conversations/${conversation.id}/gestao-close`).set("Authorization", `Bearer ${adminToken}`).send({ sendClosingMessage: false });
    expect(res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(filesTo(phone)).toHaveLength(0);
  }, 15000);
});
