import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

// A refused form used to come back as a bare "Dados invalidos" — the screen showed it with no hint of which field
// was wrong (Fontes de dados › SQL Server: "aparece erro, mas não diz qual é o erro").
describe("a recusa de um formulário diz o motivo", () => {
  let token: string;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.dataSource.deleteMany();
    await createTestUser({ email: "admin-val@test.dev", role: "ADMIN" });
    token = (await request(app).post("/api/auth/login").send({ email: "admin-val@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });

  afterAll(async () => {
    await prisma.dataSource.deleteMany();
    await prisma.$disconnect();
  });

  const save = (body: object) => request(app).post("/api/data-sources").set("Authorization", `Bearer ${token}`).send(body);

  it("banco de dados sem servidor e sem consulta: a mensagem diz o que falta preencher", async () => {
    const res = await save({ name: "ERP", kind: "DATABASE", config: { dialect: "sqlserver", port: 1433, database: "erp", user: "leitura" }, secrets: { password: "x" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.message).toContain("Preencha o servidor");
    expect(res.body.message).toContain("Preencha a consulta");
    expect(res.body.details).toBeDefined();
  });

  it("sem nome: em português, sem a mensagem em inglês da validação", async () => {
    const res = await save({ name: "  ", kind: "DATABASE", config: { dialect: "sqlserver", host: "srv", port: 1433, database: "erp", user: "leitura", query: "select 1" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Preencha o nome");
    expect(res.body.message).not.toMatch(/String must|character/);
  });

  it("consulta longa demais: diz o limite", async () => {
    const res = await save({ name: "ERP", kind: "DATABASE", config: { dialect: "sqlserver", host: "srv", port: 1433, database: "erp", user: "leitura", query: `select ${"a,".repeat(30_000)} 1` } });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("50.000");
  });

  it("a consulta de um ERP, com mais de 8000 caracteres, é aceita", async () => {
    const query = `select 1 as telefone_whatsapp, ${Array.from({ length: 400 }, (_, i) => `[coluna_com_nome_comprido_${i}]`).join(", ")} from tabela`;
    expect(query.length).toBeGreaterThan(8000);
    const res = await save({ name: "ERP longo", kind: "DATABASE", config: { dialect: "sqlserver", host: "srv", port: 1433, database: "erp", user: "leitura", query }, secrets: { password: "x" } });
    expect(res.status).toBe(201);
  });

  it("cadastro completo continua sendo salvo", async () => {
    const res = await save({ name: "ERP", kind: "DATABASE", config: { dialect: "sqlserver", host: "srv", port: 1433, database: "erp", user: "leitura", query: "select 1 as telefone_whatsapp" }, secrets: { password: "x" } });
    expect(res.status).toBe(201);
  });
});
