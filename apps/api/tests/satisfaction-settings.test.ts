import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";

const app = createApp();
const QUESTION = "De 0 a 10, o quanto você recomendaria o atendimento?";

describe("Respostas › Pesquisa: cadastro das pesquisas", () => {
  let token: string;
  let agentToken: string;
  let connectionId: string;

  const body = (overrides: Record<string, unknown> = {}) => ({
    name: "Pesquisa do suporte",
    active: false,
    connectionScope: { allConnections: true, connectionIds: [] },
    question: QUESTION,
    thanks: "Obrigado!",
    answerWindowHours: 24,
    closingWaitMinutes: 30,
    ...overrides,
  });
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const create = (payload: Record<string, unknown>) => request(app).post("/api/satisfaction-survey/surveys").set(auth()).send(payload);
  const patch = (id: string, payload: Record<string, unknown>) => request(app).patch(`/api/satisfaction-survey/surveys/${id}`).set(auth()).send(payload);
  const list = () => request(app).get("/api/satisfaction-survey/surveys").set(auth());

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-pesquisa@test.dev", role: "ADMIN" });
    await createTestUser({ email: "agente-pesquisa@test.dev", role: "AGENT" });
    connectionId = (await createTestConnection("Suporte")).id;
    token = (await request(app).post("/api/auth/login").send({ email: "admin-pesquisa@test.dev", password: TEST_PASSWORD })).body.accessToken;
    agentToken = (await request(app).post("/api/auth/login").send({ email: "agente-pesquisa@test.dev", password: TEST_PASSWORD })).body.accessToken;
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("cria, lista (as ligadas primeiro) e registra na auditoria", async () => {
    const off = await create(body({ name: "B – desligada" }));
    expect(off.status).toBe(201);
    const on = await create(body({ name: "Z – ligada", active: true, connectionScope: { allConnections: false, connectionIds: [connectionId] } }));
    expect(on.status).toBe(201);
    expect(on.body.connectionScope).toEqual({ allConnections: false, connections: [{ id: connectionId, name: "Suporte" }] });

    const names = (await list()).body.map((s: { name: string }) => s.name);
    expect(names.slice(0, 2)).toEqual(["Z – ligada", "B – desligada"]);
    expect(await prisma.auditLog.count({ where: { action: "SATISFACTION_SURVEY_CREATED" } })).toBeGreaterThanOrEqual(2);
  });

  it("uma pesquisa desligada pode ficar sem conexão (como os modelos); para ligar, precisa de conexão", async () => {
    const template = await create(body({ name: "Modelo", connectionScope: { allConnections: false, connectionIds: [] } }));
    expect(template.status).toBe(201);

    const turnOn = await patch(template.body.id, { active: true });
    expect(turnOn.status).toBe(400);
    expect(JSON.stringify(turnOn.body)).toContain("Escolha pelo menos uma conexão");

    const withConnection = await patch(template.body.id, { active: true, connectionScope: { allConnections: false, connectionIds: [connectionId] } });
    expect(withConnection.status).toBe(200);
    expect(withConnection.body.active).toBe(true);
  });

  it.each([0, 721, 1.5, -5])("recusa espera de %s minutos", async (minutes) => {
    expect((await create(body({ closingWaitMinutes: minutes }))).status).toBe(400);
  });

  it("a espera não pode passar do tempo para responder — também ao alterar só um dos dois", async () => {
    const tooLong = await create(body({ answerWindowHours: 1, closingWaitMinutes: 61 }));
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.body)).toContain("A espera pela nota não pode ser maior");

    const ok = await create(body({ answerWindowHours: 12, closingWaitMinutes: 720 }));
    expect(ok.status).toBe(201);
    expect((await patch(ok.body.id, { answerWindowHours: 1 })).status).toBe(400);
  });

  it("exclui e registra na auditoria; atendente sem permissão não vê nem altera", async () => {
    const created = await create(body({ name: "Para excluir" }));
    const removed = await request(app).delete(`/api/satisfaction-survey/surveys/${created.body.id}`).set(auth());
    expect(removed.status).toBe(204);
    expect((await list()).body.some((s: { id: string }) => s.id === created.body.id)).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "SATISFACTION_SURVEY_DELETED", entityId: created.body.id } })).toBe(1);

    const agent = { Authorization: `Bearer ${agentToken}` };
    expect((await request(app).get("/api/satisfaction-survey/surveys").set(agent)).status).toBe(403);
    expect((await request(app).post("/api/satisfaction-survey/surveys").set(agent).send(body())).status).toBe(403);
  });
});
