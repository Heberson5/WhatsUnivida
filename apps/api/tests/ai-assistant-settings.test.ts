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
    expect(aiAssistantReply("Assistente Virtual", "Olá!")).toBe("*Assistente Virtual:* Olá!");
    expect(aiAssistantReply(" ", "Olá!")).toBe("*Assistente Virtual:* Olá!");
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
