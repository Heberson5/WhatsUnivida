import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { DEFAULT_AI_ASSISTANT_SETTINGS, aiAssistantReply } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { assistantAnswers, getAiAssistantSettings } from "../src/modules/ai-assistant/ai-assistant.service";
import { createTestConnection, createTestUser, resetDatabase, TEST_PASSWORD } from "./helpers";

const app = createApp();
const login = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;

describe("Assistente Virtual: configurações (Etapa 1 — base, desligada por padrão)", () => {
  let admin: string;
  let manager: string;
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    vi.unstubAllGlobals();
    await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
    await createTestUser({ email: "gestor@test.dev", role: "MANAGER" });
    admin = await login("admin@test.dev");
    manager = await login("gestor@test.dev");
    connectionId = (await createTestConnection("Central")).id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.$disconnect();
  });

  const body = (extra: object = {}) => ({ ...DEFAULT_AI_ASSISTANT_SETTINGS, ...extra });

  it("começa desligado, em Modo teste e sem conexões", async () => {
    const res = await request(app).get("/api/settings/ai-assistant").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, testMode: true, connectionIds: [], name: "Assistente Virtual" });
  });

  it("só o administrador vê e altera", async () => {
    expect((await request(app).get("/api/settings/ai-assistant").set("Authorization", `Bearer ${manager}`)).status).toBe(403);
    expect((await request(app).put("/api/settings/ai-assistant").set("Authorization", `Bearer ${manager}`).send(body({ enabled: true }))).status).toBe(403);
  });

  it("salva: telefones só com dígitos e sem repetir, conexão inexistente descartada, nome vazio volta ao padrão", async () => {
    const res = await request(app)
      .put("/api/settings/ai-assistant")
      .set("Authorization", `Bearer ${admin}`)
      .send(body({ enabled: true, name: "  ", connectionIds: [connectionId, "00000000-0000-4000-8000-000000000000"], testPhones: ["(65) 99928-6623", "65999286623", "12"] }));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Assistente Virtual");
    expect(res.body.connectionIds).toEqual([connectionId]);
    expect(res.body.testPhones).toEqual(["65999286623"]);
    expect((await getAiAssistantSettings()).enabled).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "SETTINGS_AI_ASSISTANT_UPDATED" } })).toBe(1);
  });

  it("recusa texto grande demais", async () => {
    const res = await request(app).put("/api/settings/ai-assistant").set("Authorization", `Bearer ${admin}`).send(body({ greeting: "x".repeat(1001) }));
    expect(res.status).toBe(400);
  });

  it("quem o assistente atende: ligado, conexão escolhida e, em Modo teste, só os telefones da lista (com ou sem 55 e o 9)", () => {
    const settings = { ...DEFAULT_AI_ASSISTANT_SETTINGS, enabled: true, connectionIds: ["c1"], testPhones: ["65999286623"] };
    expect(assistantAnswers(settings, "c1", "5565999286623")).toBe(true);
    expect(assistantAnswers(settings, "c1", "556599286623")).toBe(true);
    expect(assistantAnswers(settings, "c1", "5565911112222")).toBe(false);
    expect(assistantAnswers(settings, "c2", "5565999286623")).toBe(false);
    expect(assistantAnswers({ ...settings, enabled: false }, "c1", "5565999286623")).toBe(false);
    expect(assistantAnswers({ ...settings, testMode: false }, "c1", "5565911112222")).toBe(true);
  });

  it("toda resposta começa com o nome em negrito", () => {
    expect(aiAssistantReply("Assistente Virtual", "Olá!")).toBe("*Assistente Virtual:*\n\nOlá!");
    expect(aiAssistantReply(" ", "Olá!")).toBe("*Assistente Virtual:*\n\nOlá!");
  });

  it("situação: IA fora do ar é informada, não estoura erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const res = await request(app).get("/api/settings/ai-assistant/status").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachable: false, modelReady: false, model: "qwen2.5:3b", transcriptionModel: "large-v3-turbo" });
    expect(res.body.error).toContain("não está acessível");
  });

  it("situação: serviço no ar, modelo pronto só quando já baixado", async () => {
    let models: string[] = [];
    let whisperReady = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/health")
          ? new Response(JSON.stringify({ ready: whisperReady }), { status: 200 })
          : new Response(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }), { status: 200 })
      )
    );
    const before = await request(app).get("/api/settings/ai-assistant/status").set("Authorization", `Bearer ${admin}`);
    expect(before.body).toMatchObject({ reachable: true, modelReady: false, transcriptionReady: false });
    models = ["qwen2.5:3b"];
    whisperReady = true;
    const after = await request(app).get("/api/settings/ai-assistant/status").set("Authorization", `Bearer ${admin}`);
    expect(after.body).toMatchObject({ reachable: true, modelReady: true, transcriptionReady: true, error: null });
  });
});

describe("Assistente Virtual: status \"Com a IA\" (IN_AI)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("conta como conversa em aberto do cliente, como a do Fluxo — a mensagem seguinte cai nela", async () => {
    const { findActiveConversationForContact } = await import("../src/modules/conversations/conversations.service");
    const connection = await createTestConnection("Central");
    const contact = await prisma.contact.create({ data: { phone: "5565999286623", name: "Cliente", whatsappConnectionId: connection.id } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connection.id, status: "IN_AI" } });
    expect((await findActiveConversationForContact(contact.id))?.id).toBe(conversation.id);
  });

  it("respondida pelo celular, sai da IA (Atendido pelo celular)", async () => {
    const { findOrOpenConversationForDeviceSentMessage } = await import("../src/modules/conversations/conversations.service");
    const connection = await createTestConnection("Central");
    const contact = await prisma.contact.create({ data: { phone: "5565999286623", name: "Cliente", whatsappConnectionId: connection.id } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connection.id, status: "IN_AI" } });
    await findOrOpenConversationForDeviceSentMessage(connection.id, contact.id);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("HANDLED_EXTERNALLY");
  });
});

describe("Transcrever áudio (atendentes)", () => {
  let agentToken: string;
  let conversationId: string;
  let audioId: string;
  let textId: string;

  beforeEach(async () => {
    await resetDatabase();
    vi.unstubAllGlobals();
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../src/config/env");
    fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.UPLOAD_DIR, "teste-audio.ogg"), Buffer.from("OggS"));
    const connection = await createTestConnection("Central");
    const agent = await createTestUser({ email: "ana-audio@test.dev", role: "AGENT", whatsappConnectionId: connection.id });
    agentToken = await login("ana-audio@test.dev");
    const contact = await prisma.contact.create({ data: { phone: "5565999286623", name: "Cliente", whatsappConnectionId: connection.id } });
    const conversation = await prisma.conversation.create({ data: { contactId: contact.id, whatsappConnectionId: connection.id, status: "IN_PROGRESS", assignedAgentId: agent.id, acceptedAt: new Date() } });
    conversationId = conversation.id;
    const audio = await prisma.message.create({ data: { conversationId, direction: "INBOUND", type: "AUDIO", status: "DELIVERED" } });
    await prisma.messageAttachment.create({ data: { messageId: audio.id, fileName: "a.ogg", mimeType: "audio/ogg", sizeBytes: 4, storageKey: "teste-audio.ogg", kind: "AUDIO" } });
    audioId = audio.id;
    textId = (await prisma.message.create({ data: { conversationId, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body: "oi" } })).id;
  });

  const transcribe = (messageId: string, token = agentToken) =>
    request(app).post(`/api/conversations/${conversationId}/messages/${messageId}/transcribe`).set("Authorization", `Bearer ${token}`);
  const features = () => request(app).get("/api/ai-features").set("Authorization", `Bearer ${agentToken}`);

  it("desligado (padrão): sem botão e a rota recusa — áudio só é transcrito com o assistente", async () => {
    expect((await features()).body).toEqual({ agentTranscription: false });
    expect((await transcribe(audioId)).status).toBe(403);
  });

  it("ligado: transcreve, guarda na mensagem e o segundo clique só devolve o texto", async () => {
    await updateAiAssistantSettingsForTest({ agentTranscription: true });
    expect((await features()).body).toEqual({ agentTranscription: true });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "quero a segunda via" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await transcribe(audioId);
    expect(res.status).toBe(200);
    expect(res.body.transcription).toBe("quero a segunda via");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: audioId } })).transcription).toBe("quero a segunda via");
    expect((await transcribe(audioId)).body.transcription).toBe("quero a segunda via");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await prisma.auditLog.count({ where: { action: "AUDIO_TRANSCRIBED" } })).toBe(1);
  });

  it("serviço de transcrição fora do ar: erro legível, nada gravado; mensagem que não é áudio é recusada", async () => {
    await updateAiAssistantSettingsForTest({ agentTranscription: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await transcribe(audioId);
    expect(res.status).toBe(502);
    expect(res.body.message).toContain("Não foi possível transcrever");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: audioId } })).transcription).toBeNull();
    expect((await transcribe(textId)).status).toBe(400);
  });

  it("atendente que não está na conversa não transcreve", async () => {
    await updateAiAssistantSettingsForTest({ agentTranscription: true });
    await createTestUser({ email: "bia-audio@test.dev", role: "AGENT" });
    const other = await login("bia-audio@test.dev");
    expect((await transcribe(audioId, other)).status).toBe(403);
  });
});

async function updateAiAssistantSettingsForTest(patch: Partial<typeof DEFAULT_AI_ASSISTANT_SETTINGS>) {
  const { updateAiAssistantSettings } = await import("../src/modules/ai-assistant/ai-assistant.service");
  await updateAiAssistantSettings({ ...DEFAULT_AI_ASSISTANT_SETTINGS, ...patch });
}
