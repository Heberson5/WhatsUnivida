import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { createClosingMessage } from "../src/modules/closing-messages/closing-messages.service";
import { createSurvey } from "../src/modules/satisfaction/satisfaction.service";
import { CONVERSATION_UNDO_WINDOW_MS } from "@whatsatendende/types";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const QUESTION = "De 0 a 10, o quanto você recomendaria o atendimento?";

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Gestão › Encerrar sem enviar mensagem", () => {
  let connectionId: string;
  let adminToken: string;
  let anaToken: string;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await resetDatabase();
    const admin = await createTestUser({ email: "admin-silent@test.dev", role: "ADMIN", displayName: "Administrador" });
    adminToken = await loginAs("admin-silent@test.dev");
    connectionId = (await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "SuporteSilent" })).body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    await createTestUser({ email: "ana-silent@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    anaToken = await loginAs("ana-silent@test.dev");
    await createClosingMessage({ name: "Padrão", text: "Obrigado pelo contato!", active: true, userIds: [admin.id], connectionScope: { allConnections: true, connectionIds: [] } });
    await prisma.satisfactionSurveyConfig.deleteMany();
    await createSurvey({
      name: "Pesquisa",
      active: true,
      connectionScope: { allConnections: false, connectionIds: [connectionId] },
      question: QUESTION,
      thanks: "Obrigado!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
    });
  }, 20000);

  afterEach(() => vi.useRealTimers());
  afterAll(async () => prisma.$disconnect());

  const textsTo = (phone: string) => provider.sentTexts.filter((m) => m.chatId.startsWith(`${phone}@`)).map((m) => m.text);

  async function closeFromGestao(phone: string, sendClosingMessage: boolean) {
    const { conversation } = await createWaitingConversation(phone, connectionId);
    expect((await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${anaToken}`)).status).toBe(200);
    const base = textsTo(phone).length;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const res = await request(app).post(`/api/conversations/${conversation.id}/gestao-close`).set("Authorization", `Bearer ${adminToken}`).send({ sendClosingMessage });
    expect(res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNDO_WINDOW_MS + 1000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { conversation, sent: textsTo(phone).slice(base) };
  }

  it("sem mensagem de encerramento, a pesquisa também não vai para o cliente", async () => {
    const { conversation, sent } = await closeFromGestao("5565977770001", false);
    expect(sent).toEqual([]);
    expect(await prisma.satisfactionSurvey.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it("com a mensagem de encerramento, a pesquisa continua sendo enviada", async () => {
    const { conversation, sent } = await closeFromGestao("5565977770002", true);
    expect(sent.some((t) => t.includes(QUESTION))).toBe(true);
    expect(await prisma.satisfactionSurvey.count({ where: { conversationId: conversation.id } })).toBe(1);
  });
});
