import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { __getProviderForTests } from "../src/modules/whatsapp/whatsapp.service";
import { BOLETO_PAYMENT_PLACES, DEFAULT_BOLETO_INSTRUCTION, DEFAULT_BOLETO_SEND_MESSAGE, fillBoletoInstructions, fillBoletoSendMessage } from "@whatsatendende/types";
import { buildBoletoFromRow } from "../src/modules/boletos/boletos.service";
import type { ColumnMap, Row } from "../src/modules/data-sources/data-sources.service";
import type { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

const HEADER = "telefone_whatsapp,codigo_cliente,nome_cliente,cpf_cnpj,numero_contrato,documento,vencimento_parcela,dias_em_atraso,saldo,forma_pagamento,vencimento_boleto,valor_boleto,nosso_numero,banco_codigo,convenio,carteira,agencia_beneficiario,conta_beneficiario,beneficiario_nome";
// Fictitious BB convênio 1234567; the second contract's first parcel is a recurring card.
const ROWS = [
  "5565999991111,1,Cliente Boleto,12345678901,C-10,D-1,10/01/2026,280,90.00,Boleto,10/01/2026,90.00,12345670000000101,001,1234567,17,1234-5,99999-9,Empresa Teste",
  "5565999991111,1,Cliente Boleto,12345678901,C-10,D-2,10/02/2026,251,90.00,Boleto,10/02/2026,90.00,12345670000000102,001,1234567,17,1234-5,99999-9,Empresa Teste",
  "5565999991111,1,Cliente Boleto,12345678901,C-10,D-3,10/12/2030,0,90.00,Boleto,10/12/2030,90.00,12345670000000103,001,1234567,17,1234-5,99999-9,Empresa Teste",
  "5565999991111,1,Cliente Boleto,12345678901,C-20,D-4,10/01/2026,280,50.00,Cartão recorrente,,,,,,,,,",
];

describe("Envio de boleto", () => {
  let adminToken: string;
  let agentToken: string;
  let conversationId: string;
  let provider: MockWhatsAppProvider;
  let parcelIds: Record<string, string>;
  let map: ColumnMap;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.dataSource.deleteMany();
    await prisma.systemSetting.deleteMany({ where: { key: { in: ["boleto-validation", "boleto-defaults", "boleto-send-message"] } } });
    await prisma.boletoLayout.deleteMany();
    await prisma.boletoInstruction.deleteMany();
    await createTestUser({ email: "admin-bol@test.dev", role: "ADMIN" });
    adminToken = await loginAs("admin-bol@test.dev");
    const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Boletos" });
    const connectionId = connection.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    provider = __getProviderForTests(connectionId) as MockWhatsAppProvider;
    const agent = await createTestUser({ email: "ana-bol@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId });
    agentToken = await loginAs("ana-bol@test.dev");
    const { conversation } = await createWaitingConversation("5565999991111", connectionId);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "IN_PROGRESS", assignedAgentId: agent.id, acceptedAt: new Date() } });
    conversationId = conversation.id;

    const source = await request(app).post("/api/data-sources").set("Authorization", `Bearer ${adminToken}`).send({ name: "Planilha", kind: "UPLOAD" });
    await request(app)
      .post(`/api/data-sources/${source.body.id}/upload`)
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", Buffer.from([HEADER, ...ROWS].join("\n")), { filename: "dados.csv", contentType: "text/csv" });
    await request(app).post(`/api/data-sources/${source.body.id}/active`).set("Authorization", `Bearer ${adminToken}`).send({ active: true });
    map = (await prisma.dataSource.findUniqueOrThrow({ where: { id: source.body.id } })).columnMap as ColumnMap;
    const rows = await prisma.dataSourceRow.findMany({ where: { dataSourceId: source.body.id } });
    parcelIds = Object.fromEntries(rows.map((r) => [(r.data as Row).documento, r.id]));
  }, 20000);

  afterAll(async () => {
    await prisma.dataSource.deleteMany();
    await prisma.$disconnect();
  });

  const preview = (ids: string[]) =>
    request(app).post(`/api/messages/conversations/${conversationId}/boletos/preview`).set("Authorization", `Bearer ${agentToken}`).send({ parcelIds: ids });

  it("banco ainda não validado não envia boleto", async () => {
    const res = await preview([parcelIds["D-1"]]);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("ainda não foi liberado");
  });

  it("validação: linha que não confere não conta; 3 boletos reais conferidos liberam o banco", async () => {
    const realLinha = async (doc: string) => {
      const row = await prisma.dataSourceRow.findUniqueOrThrow({ where: { id: parcelIds[doc] } });
      return { ourNumber: (row.data as Row).nosso_numero, linha: buildBoletoFromRow(row.data as Row, map).linha };
    };
    const wrong = await realLinha("D-1");
    const other = await realLinha("D-2");
    const mismatch = await request(app).post("/api/boletos/validation").set("Authorization", `Bearer ${adminToken}`).send({ ourNumber: wrong.ourNumber, linha: other.linha });
    expect(mismatch.status).toBe(400);
    for (const doc of ["D-1", "D-2", "D-3"]) {
      await request(app).post("/api/boletos/validation").set("Authorization", `Bearer ${adminToken}`).send(await realLinha(doc)).expect(200);
    }
    const status = await request(app).get("/api/boletos/validation").set("Authorization", `Bearer ${adminToken}`);
    expect(status.body.find((b: { code: string }) => b.code === "001")).toMatchObject({ matched: 3, enabled: true });
    // Banco do Brasil first; the other banks wait for their own 3 real boletos.
    expect(status.body.map((b: { code: string }) => b.code)).toEqual(["001", "237", "104", "341", "748"]);
    expect(status.body.filter((b: { enabled: boolean }) => b.enabled).map((b: { code: string }) => b.code)).toEqual(["001"]);
  });

  it("validação acha o nosso número escrito de outro jeito: só a sequência, sem zeros à esquerda, com espaços", async () => {
    const row = await prisma.dataSourceRow.findUniqueOrThrow({ where: { id: parcelIds["D-2"] } });
    const linha = buildBoletoFromRow(row.data as Row, map).linha;
    for (const typed of ["0000000102", "102", "1234567 0000000102"]) {
      await request(app).post("/api/boletos/validation").set("Authorization", `Bearer ${adminToken}`).send({ ourNumber: typed, linha }).expect(200);
    }
    const missing = await request(app).post("/api/boletos/validation").set("Authorization", `Bearer ${adminToken}`).send({ ourNumber: "999", linha });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toMatch(/Nenhuma parcela/);
  });

  it("não deixa pular parcela mais antiga do contrato", async () => {
    const res = await preview([parcelIds["D-2"]]);
    expect(res.body.message).toBe("Envie primeiro a parcela de 10/01/2026 — não é possível pular parcelas mais antigas");
  });

  it("cartão recorrente não tem boleto", async () => {
    const res = await preview([parcelIds["D-4"]]);
    expect(res.body.message).toContain("Cartão recorrente");
  });

  it("prévia avisa de boleto vencido e o envio exige confirmação", async () => {
    const res = await preview([parcelIds["D-1"], parcelIds["D-2"]]);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.warnings[0]).toBe("Boleto vencido em 10/01/2026 — o banco pode cobrar juros ou recusar");
    const unconfirmed = await request(app)
      .post(`/api/messages/conversations/${conversationId}/boletos/send`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ parcelIds: [parcelIds["D-1"]], message: "Segue", sendLinhas: true });
    expect(unconfirmed.status).toBe(400);
  });

  it("prévia: mensagem de envio no plural para vários boletos", async () => {
    const res = await preview([parcelIds["D-1"], parcelIds["D-2"]]);
    expect(res.body.message).toBe("Olá, Cliente! Seguem os boletos das 2 parcelas, todos no mesmo arquivo, no total de R$ 180,00.");
    const single = await preview([parcelIds["D-1"]]);
    expect(single.body.message).toBe("Olá, Cliente! Segue o boleto da parcela com vencimento em 10/01/2026, no valor de R$ 90,00.");
  });

  it("envia um só PDF com a mensagem como comentário e, se marcado, a linha digitável de cada um; nota e auditoria", async () => {
    const files = provider.sentFiles.length;
    const texts = provider.sentTexts.length;
    const res = await request(app)
      .post(`/api/messages/conversations/${conversationId}/boletos/send`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ parcelIds: [parcelIds["D-1"], parcelIds["D-2"]], message: "Seguem os boletos", confirmOverdue: true, sendLinhas: true });
    expect(res.status).toBe(201);
    expect(provider.sentFiles.length - files).toBe(1);
    expect(provider.sentFiles.at(-1)!.caption).toBe("*Ana:*\n\nSeguem os boletos");
    expect(provider.sentTexts.length - texts).toBe(2);
    // In the platform the linha shows who sent it.
    const linha = await prisma.message.findFirstOrThrow({ where: { conversationId, type: "TEXT" }, orderBy: { createdAt: "desc" } });
    expect(linha.senderAgentId).toBeTruthy();
    const d2 = await prisma.dataSourceRow.findUniqueOrThrow({ where: { id: parcelIds["D-2"] } });
    // Only the digits of the linha digitável, without the agent's name.
    expect(provider.sentTexts.at(-1)!.text).toBe(buildBoletoFromRow(d2.data as Row, map).linha.replace(/\D/g, ""));
    expect(await prisma.conversationNote.count({ where: { conversationId, body: { startsWith: "Boleto enviado por Ana" } } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: "BOLETO_SENT", entityId: conversationId } })).toBe(2);

    const textsBefore = provider.sentTexts.length;
    await request(app)
      .post(`/api/messages/conversations/${conversationId}/boletos/send`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ parcelIds: [parcelIds["D-1"], parcelIds["D-2"]], message: "", confirmOverdue: true, sendLinhas: false })
      .expect(201);
    expect(provider.sentTexts.length).toBe(textsBefore);
  });

  it("instruções: multa e juros ao dia calculados sobre o valor original", () => {
    const lines = fillBoletoInstructions(DEFAULT_BOLETO_INSTRUCTION, { cents: 12758, contract: "C-1", document: "D-9", due: "10/11/2026" });
    expect(lines[0]).toBe("-> Após Vencimento Cobrar Multa de R$ 2,55");
    expect(lines[1]).toBe("-> Após Vencimento Cobrar Juros Diários de R$ 0,04");
    expect(lines[4]).toBe("-> Contrato: C-1  Documento: D-9");
    expect(fillBoletoInstructions(DEFAULT_BOLETO_INSTRUCTION, { cents: 8363, contract: "", document: null, due: "" }).slice(0, 2)).toEqual([
      "-> Após Vencimento Cobrar Multa de R$ 1,67",
      "-> Após Vencimento Cobrar Juros Diários de R$ 0,03",
    ]);
    expect(fillBoletoSendMessage(DEFAULT_BOLETO_SEND_MESSAGE, { clientName: "", boletos: [{ due: "10/11/2026", cents: 100 }] })).toMatch(/^Olá! Segue/);
  });

  it("layouts: os 4 do Banco do Brasil e o Boleto F dos outros bancos já vêm, com prévia em PDF; renomear a mensagem renomeia a tag no layout", async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };
    const layouts = (await request(app).get("/api/boletos/layouts").set(auth)).body;
    const byBank = (code: string) => layouts.filter((l: { bankCode: string }) => l.bankCode === code);
    expect(byBank("001").map((l: { name: string }) => l.name)).toEqual(["Boleto F", "Boleto padrão", "Boleto com demonstrativo", "Ficha de compensação"]);
    for (const code of ["748", "237", "341", "104"]) {
      expect(byBank(code).map((l: { name: string }) => l.name)).toEqual(["Boleto F"]);
      expect(byBank(code)[0].settings.paymentPlace).toBe(BOLETO_PAYMENT_PLACES[code]);
    }
    expect(BOLETO_PAYMENT_PLACES["748"]).toBe("PAGÁVEL PREFERENCIALMENTE NAS COOPERATIVAS DE CRÉDITO DO SICREDI");
    for (const layout of layouts) {
      const pdf = await request(app).post("/api/boletos/layouts/preview").set(auth).send(layout).buffer(true);
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
    }
    const [instruction] = (await request(app).get("/api/boletos/instructions").set(auth)).body;
    expect(instruction.usedBy).toHaveLength(8);
    await request(app).put(`/api/boletos/instructions/${instruction.id}`).set(auth).send({ ...instruction, name: "Instruções BB" }).expect(200);
    const renamed = (await request(app).get("/api/boletos/layouts").set(auth)).body[0];
    expect(renamed.settings.instructions).toBe("{mensagem:Instruções BB}");
    const blocked = await request(app).delete(`/api/boletos/instructions/${instruction.id}`).set(auth);
    expect(blocked.status).toBe(409);
    const agentEdit = await request(app).put("/api/boletos/send-message").set("Authorization", `Bearer ${agentToken}`).send(DEFAULT_BOLETO_SEND_MESSAGE);
    expect(agentEdit.status).toBe(403);
  });
});
