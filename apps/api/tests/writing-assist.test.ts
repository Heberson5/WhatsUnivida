import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createWaitingConversation, createTestConnection, TEST_PASSWORD } from "./helpers";

const app = createApp();
const login = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;

const TEXT = "Bom dia Maria, vc viu isso amanha na Acme. nos vai";
const match = (word: string, category: string, issueType: string, replacement?: string) => ({
  offset: TEXT.indexOf(word),
  length: word.length,
  message: "Erro",
  replacements: replacement ? [{ value: replacement }] : [],
  rule: { issueType, category: { id: category } },
});
const FOUND = [
  match("Maria", "TYPOS", "misspelling", "Mara"),
  match("vc", "FORMAL", "style", "você"),
  match("amanha", "MISSPELLING", "misspelling", "amanhã"),
  match("Acme", "TYPOS", "misspelling"),
  match("nos", "CASING", "typographical", "Nos"),
  match("vai", "GRAMMAR", "grammar", "vamos"),
];

describe("Corretor: o que vira alerta e quem configura", () => {
  let admin: string;
  let manager: string;
  let agent: string;
  let conversationId: string;
  const words = (body: { offset: number; length: number }[]) => body.map((i) => TEXT.slice(i.offset, i.offset + i.length));
  const check = async (extra: object = {}) => (await request(app).post("/api/writing-assist/check").set("Authorization", `Bearer ${agent}`).send({ text: TEXT, ...extra })).body;
  const configure = (token: string, body: object) => request(app).patch("/api/writing-assist/settings").set("Authorization", `Bearer ${token}`).send(body);

  beforeEach(async () => {
    await resetDatabase();
    await prisma.systemSetting.deleteMany({ where: { key: "writingAssist" } });
    await createTestUser({ email: "admin-w@test.dev", role: "ADMIN" });
    await createTestUser({ email: "gestor-w@test.dev", role: "MANAGER" });
    await createTestUser({ email: "agente-w@test.dev", role: "AGENT", displayName: "Agente" });
    admin = await login("admin-w@test.dev");
    manager = await login("gestor-w@test.dev");
    agent = await login("agente-w@test.dev");
    const connection = await createTestConnection("Corretor");
    const waiting = await createWaitingConversation("5565977776666", connection.id);
    await prisma.contact.update({ where: { id: waiting.contact.id }, data: { name: "Maria Souza" } });
    conversationId = waiting.conversation.id;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ matches: FOUND }))));
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("marca tudo por padrão, abreviação inclusive, e o que não tem sugestão também", async () => {
    const body = await check();
    expect(words(body)).toEqual(["Maria", "vc", "amanha", "Acme", "nos", "vai"]);
    expect(body[3].replacement).toBeNull();
  });

  it("o nome do cliente e os termos da empresa não são erro", async () => {
    await configure(admin, { companyTerms: ["ACME"] }).expect(200);
    expect(words(await check({ conversationId }))).toEqual(["vc", "amanha", "nos", "vai"]);
  });

  it("cada opção desliga o seu tipo; desligado, nem chama o corretor", async () => {
    await configure(manager, { spelling: false }).expect(200);
    expect(words(await check())).toEqual(["vc", "nos", "vai"]);
    await configure(manager, { informal: false, punctuation: false }).expect(200);
    expect(words(await check())).toEqual(["vai"]);
    await configure(manager, { grammar: false }).expect(200);
    expect(await check()).toEqual([]);

    await configure(manager, { enabled: false, spelling: true }).expect(200);
    vi.mocked(fetch).mockClear();
    expect(await check()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("corretor fora do ar: nenhum alerta, o envio segue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("down");
    }));
    expect(await check()).toEqual([]);
  });

  it("só administrador e gestor configuram", async () => {
    expect((await configure(agent, { enabled: false })).status).toBe(403);
    expect((await request(app).get("/api/writing-assist/settings").set("Authorization", `Bearer ${agent}`)).status).toBe(403);
    expect((await request(app).get("/api/writing-assist/settings").set("Authorization", `Bearer ${manager}`)).body.enabled).toBe(true);
  });
});
