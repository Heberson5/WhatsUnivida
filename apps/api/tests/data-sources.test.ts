import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { gzipSync } from "node:zlib";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { phoneKey } from "../src/lib/phone-key";
import { downloadCandidates, assertReadOnlyQuery, fetchFromLink, parseSpreadsheet } from "../src/modules/data-sources/data-source-fetch";
import { parseBeneficiaries, syncDueDataSources } from "../src/modules/data-sources/data-sources.service";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

// Fictitious data in the shape the WhatsAtendende script produces (SQL Server Management Studio CSV).
const CSV = [
  "telefone_whatsapp,codigo_cliente,nome_cliente,cpf_cnpj,numero_contrato,plano,situacao_contrato,beneficiarios,parcelas_suspensao,documento,vencimento_parcela,dias_em_atraso,saldo,multa,juros,valor_atualizado,forma_pagamento",
  "5565999990001,10,Maria Teste,12345678901,C-1,Plano Ouro,Ativo,Maria Teste;Titular;01/02/1980;Não | João Teste;Filho;15/06/2010;Não,2,D-1,10/08/2026,70,89.90,1.80,2.10,93.80,Boleto",
  "5565999990001,10,Maria Teste,12345678901,C-1,Plano Ouro,Ativo,Maria Teste;Titular;01/02/1980;Não | João Teste;Filho;15/06/2010;Não,2,D-2,10/09/2026,39,89.90,1.80,1.17,92.87,Boleto",
  "5565999990001,10,Maria Teste,12345678901,C-1,Plano Ouro,Ativo,Maria Teste;Titular;01/02/1980;Não | João Teste;Filho;15/06/2010;Não,2,D-3,10/11/2026,0,89.90,0.00,0.00,89.90,Boleto",
  "6599990002,20,Ana Um,11122233344,C-2,Plano Prata,Ativo,,3,,,,,,,,",
  "556599990002,21,Ana Dois,55566677788,C-3,Plano Prata,Ativo,,3,,,,,,,,",
].join("\n");

describe("Fontes de dados", () => {
  let adminToken: string;
  let agentToken: string;
  let agentId: string;
  let connectionId: string;
  let sourceId: string;

  async function conversationFor(phone: string) {
    const { conversation } = await createWaitingConversation(phone, connectionId);
    return prisma.conversation.update({ where: { id: conversation.id }, data: { status: "IN_PROGRESS", assignedAgentId: agentId, acceptedAt: new Date() } });
  }

  beforeAll(async () => {
    await resetDatabase();
    await prisma.dataSource.deleteMany();
    await createTestUser({ email: "admin-ds@test.dev", role: "ADMIN" });
    adminToken = await loginAs("admin-ds@test.dev");
    const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Dados" });
    connectionId = connection.body.id;
    await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // mock provider: QR -> CONNECTED takes ~1.9s
    agentId = (await createTestUser({ email: "ana-ds@test.dev", role: "AGENT", whatsappConnectionId: connectionId })).id;
    agentToken = await loginAs("ana-ds@test.dev");
  }, 15000);

  afterAll(async () => {
    await prisma.dataSource.deleteMany();
    await prisma.$disconnect();
  });

  it("normaliza o telefone com ou sem 55 e com ou sem o 9", () => {
    expect(phoneKey("(65) 99999-0001")).toBe("556599990001");
    expect(phoneKey("5565999990001")).toBe("556599990001");
    expect(phoneKey("556599990001")).toBe("556599990001");
    expect(phoneKey("065999990001")).toBe("556599990001");
    expect(phoneKey("12345")).toBeNull();
  });

  it("monta o link de download do OneDrive e do Google Planilhas", () => {
    expect(downloadCandidates("https://docs.google.com/spreadsheets/d/abc123/edit#gid=7")).toEqual(["https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=7"]);
    expect(downloadCandidates("https://1drv.ms/x/s!AbC")[0]).toMatch(/^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u!/);
    expect(downloadCandidates("https://empresa.sharepoint.com/:x:/g/abc")).toEqual(["https://empresa.sharepoint.com/:x:/g/abc?download=1"]);
    expect(downloadCandidates("https://drive.google.com/file/d/1AbC-xyz/view?usp=sharing")).toEqual([
      "https://drive.usercontent.google.com/download?id=1AbC-xyz&export=download&confirm=t",
      "https://drive.google.com/uc?export=download&id=1AbC-xyz",
    ]);
  });

  it("arquivo grande do Google Drive: passa pela página de aviso de vírus e baixa o arquivo", async () => {
    const warning = `<!DOCTYPE html><html><body><p>O Google Drive não pode verificar este arquivo.</p>
      <form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="submit" value="Fazer o download mesmo assim"/>
      <input type="hidden" name="id" value="1AbC"><input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-123"></form></body></html>`;
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("uuid=u-123") ? new Response("telefone_whatsapp;nome_cliente\n5565999990001;Maria") : new Response(warning, { headers: { "content-type": "text/html" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const table = await fetchFromLink("https://drive.google.com/file/d/1AbC/view");
      expect(table.rows).toEqual([{ telefone_whatsapp: "5565999990001", nome_cliente: "Maria" }]);
      expect(fetchMock.mock.calls[1][0]).toBe("https://drive.usercontent.google.com/download?id=1AbC&export=download&confirm=t&uuid=u-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Google que não entrega o arquivo: explica o que fazer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>Erro</body></html>")));
    try {
      await expect(fetchFromLink("https://drive.google.com/file/d/1AbC/view")).rejects.toThrow(/compacte o CSV em \.zip/);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 413 })));
      await expect(fetchFromLink("https://docs.google.com/spreadsheets/d/abc/edit")).rejects.toThrow(/O link respondeu 413\. O Google Planilhas não entregou/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lê o CSV compactado em .gz ou dentro de um .zip", async () => {
    const csv = Buffer.from("telefone_whatsapp;nome_cliente\n5565999990001;Maria\n");
    const zip = new JSZip();
    zip.file("clientes.csv", csv);
    for (const packed of [gzipSync(csv), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })]) {
      expect((await parseSpreadsheet(packed, null)).rows).toEqual([{ telefone_whatsapp: "5565999990001", nome_cliente: "Maria" }]);
    }
    const two = new JSZip();
    two.file("a.csv", csv);
    two.file("b.csv", csv);
    await expect(parseSpreadsheet(await two.generateAsync({ type: "nodebuffer" }), null)).rejects.toThrow("um único arquivo");
  });

  it("link do OneDrive recusado pela Microsoft: explica e indica a conta Microsoft", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    try {
      await expect(fetchFromLink("https://1drv.ms/x/c/4a75/IQBb?e=abc")).rejects.toThrow(/Planilha privada \(conta Microsoft\)/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lê o CSV salvo pelo SSMS ou Excel em UTF-8, Unicode ou ANSI", async () => {
    const csv = "Nome,Cidade\r\nJosé,\"Cuiabá, MT\"\r\n";
    for (const buffer of [Buffer.from(csv, "utf8"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]), Buffer.from(csv, "latin1")]) {
      expect((await parseSpreadsheet(buffer, null)).rows).toEqual([{ nome: "José", cidade: "Cuiabá, MT" }]);
    }
  });

  it("lê o XLSX direto (só a primeira aba), com as datas como 10/11/2026", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Clientes");
    sheet.addRow(["Nome", "Telefone", "Vencimento", "Valor"]);
    sheet.addRow(["José", "(65) 99999-0000", new Date(Date.UTC(2026, 10, 10)), 1234.56]);
    workbook.addWorksheet("Outra").addRow(["ignorada"]);
    const table = await parseSpreadsheet(Buffer.from(await workbook.xlsx.writeBuffer()), null);
    expect(table.rows).toEqual([{ nome: "José", telefone: "(65) 99999-0000", vencimento: "10/11/2026", valor: "1234.56" }]);
  });

  it("acha sozinho a coluna do telefone com outro nome; sem nenhuma, guarda as colunas para escolher", async () => {
    const created = await request(app).post("/api/data-sources").set("Authorization", `Bearer ${adminToken}`).send({ name: "ERP", kind: "UPLOAD" });
    const upload = (csv: string) =>
      request(app).post(`/api/data-sources/${created.body.id}/upload`).set("Authorization", `Bearer ${adminToken}`).attach("file", Buffer.from(csv), { filename: "erp.csv", contentType: "text/csv" });
    expect((await upload("Contrato;Celular\nC1;(65) 99999-0001\n")).body).toMatchObject({ rowCount: 1, lastSyncError: null, columnMap: { phone: "celular" } });

    await prisma.dataSource.update({ where: { id: created.body.id }, data: { columnMap: {} } });
    const missing = (await upload("Contrato;Contato\nC1;(65) 99999-0001\n")).body;
    expect(missing.lastSyncError).toContain("Editar");
    expect(missing.columns).toEqual(["contrato", "contato"]);
  });

  it("célula com NULL (cópia do SQL Server) fica vazia", async () => {
    const table = await parseSpreadsheet(Buffer.from("Nome;Plano;Cidade\nJosé;NULL;Cuiabá\n"), null);
    expect(table.rows).toEqual([{ nome: "José", plano: "", cidade: "Cuiabá" }]);
  });

  it("XLSX com número de mais de 15 dígitos gravado como número (o Excel arredonda) é recusado, dizendo a coluna", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dados");
    sheet.addRow(["telefone_whatsapp", "nosso_numero"]);
    sheet.addRow(["5565999990000", 28374960000012300]);
    await expect(parseSpreadsheet(Buffer.from(await workbook.xlsx.writeBuffer()), null)).rejects.toThrow(/coluna "nosso_numero".*Texto/);
  });

  it("só aceita consulta de leitura no banco", () => {
    expect(() => assertReadOnlyQuery("SELECT * FROM clientes")).not.toThrow();
    expect(() => assertReadOnlyQuery("WITH x AS (SELECT 1 a) SELECT * FROM x")).not.toThrow();
    expect(() => assertReadOnlyQuery("DELETE FROM clientes")).toThrow();
    expect(() => assertReadOnlyQuery("SELECT 1; DROP TABLE x")).toThrow();
  });

  it("lê titular e beneficiários com idade e agregado", () => {
    const list = parseBeneficiaries("Maria;Titular;01/02/1980;Não | João;Filho;15/06/2010;Sim", new Date(2026, 9, 19));
    expect(list).toMatchObject([
      { name: "Maria", relation: "Titular", age: 46, aggregated: false, holder: true, birthday: "01/02" },
      { name: "João", relation: "Filho", age: 16, aggregated: true, holder: false, birthday: "15/06" },
    ]);
    expect(list.every((b) => typeof b.daysUntilBirthday === "number")).toBe(true);
  });

  it("sem fonte ativa: nada aparece e a tag não deixa enviar", async () => {
    const conversation = await conversationFor("5565999990001");
    const data = await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`);
    expect(data.body.status).toBe("NO_SOURCE");
    expect((await request(app).get("/api/data-sources/tags").set("Authorization", `Bearer ${agentToken}`)).body).toEqual({ available: false, columns: [] });
  });

  it("arquivo enviado vira a fonte, com contratos, parcelas, beneficiários e suspensão", async () => {
    const created = await request(app).post("/api/data-sources").set("Authorization", `Bearer ${adminToken}`).send({ name: "Planilha", kind: "UPLOAD" });
    expect(created.status).toBe(201);
    sourceId = created.body.id;
    const uploaded = await request(app)
      .post(`/api/data-sources/${sourceId}/upload`)
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", Buffer.from(CSV), { filename: "whatsatendende.csv", contentType: "text/csv" });
    expect(uploaded.body).toMatchObject({ rowCount: 5, lastSyncError: null, status: "INACTIVE" });
    expect(uploaded.body.columnMap).toMatchObject({ phone: "telefone_whatsapp", contract: "numero_contrato", suspensionThreshold: "parcelas_suspensao" });
    await request(app).post(`/api/data-sources/${sourceId}/active`).set("Authorization", `Bearer ${adminToken}`).send({ active: true }).expect(200);

    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990001" } } });
    const data = (await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`)).body;
    expect(data.status).toBe("OK");
    expect(data.client.name).toBe("Maria Teste");
    const [contract] = data.client.contracts;
    expect(contract).toMatchObject({ number: "C-1", overdueCount: 2, suspensionThreshold: 2, suspended: true });
    expect(contract.parcels.map((p: { document: string }) => p.document)).toEqual(["D-1", "D-2", "D-3"]);
    expect(contract.parcels[0]).toMatchObject({ value: "89.90", fine: "1.80", interest: "2.10", updatedValue: "93.80" });
    expect(contract.beneficiaries.map((b: { name: string; holder: boolean }) => [b.name, b.holder])).toEqual([["Maria Teste", true], ["João Teste", false]]);
    expect(data.suspensionWarningPending).toBe(true);
    expect(data.client.fields.find((f: { column: string }) => f.column === "cpf_cnpj").value).not.toContain("12345678");

    await request(app).post(`/api/conversations/${conversation.id}/client-data/suspension-ack`).set("Authorization", `Bearer ${agentToken}`).expect(204);
    const again = (await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`)).body;
    expect(again.suspensionWarningPending).toBe(false);
  });

  it("dado sensível só é revelado com permissão, e fica na auditoria", async () => {
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990001" } } });
    const denied = await request(app).post(`/api/conversations/${conversation.id}/client-data/reveal`).set("Authorization", `Bearer ${agentToken}`).send({ column: "cpf_cnpj" });
    expect(denied.status).toBe(403);
    const revealed = await request(app).post(`/api/conversations/${conversation.id}/client-data/reveal`).set("Authorization", `Bearer ${adminToken}`).send({ column: "cpf_cnpj" });
    expect(revealed.body.value).toBe("12345678901");
    expect(await prisma.auditLog.count({ where: { action: "CLIENT_SENSITIVE_DATA_REVEALED", entityId: conversation.id } })).toBe(1);
  });

  it("tags: preenche, e trava o envio quando falta o dado", async () => {
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990001" } } });
    const rendered = await request(app)
      .post(`/api/conversations/${conversation.id}/client-data/render`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ text: "Olá {{dados.nome_cliente}}, contrato {{dados.numero_contrato}}" });
    expect(rendered.body).toEqual({ text: "Olá Maria Teste, contrato C-1", missing: [] });

    const blocked = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/text`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ body: "Seu e-mail: {{dados.email}}" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain("*email*");
    const sensitive = await request(app)
      .post(`/api/conversations/${conversation.id}/client-data/render`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ text: "CPF {{dados.cpf_cnpj}}" });
    expect(sensitive.body.missing).toEqual(["cpf_cnpj"]);
  });

  it("telefone de vários clientes: o atendente escolhe", async () => {
    const conversation = await conversationFor("556599990002");
    const data = (await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`)).body;
    expect(data.client).toBeNull();
    expect(data.clients).toEqual([
      { key: "20", name: "Ana Um", cpfPartial: "***.222.333-**" },
      { key: "21", name: "Ana Dois", cpfPartial: "***.666.777-**" },
    ]);
    const chosen = await request(app).put(`/api/conversations/${conversation.id}/client-data/client`).set("Authorization", `Bearer ${agentToken}`).send({ clientKey: "21" });
    expect(chosen.body.client.name).toBe("Ana Dois");
  });

  it("respostas rápidas com tag somem para o atendente sem fonte e aparecem marcadas para a gestão", async () => {
    await request(app)
      .post("/api/quick-replies")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Contrato", shortcut: "contrato", text: "Seu contrato é {{dados.numero_contrato}}", connectionScope: { allConnections: true, connectionIds: [] } })
      .expect(201);
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990001" } } });
    const withSource = (await request(app).get(`/api/quick-replies/conversation/${conversation.id}`).set("Authorization", `Bearer ${agentToken}`)).body;
    expect(withSource.find((r: { shortcut: string }) => r.shortcut === "contrato").filledText).toBe("Seu contrato é C-1");

    await prisma.dataSource.update({ where: { id: sourceId }, data: { dataUpdatedAt: new Date(Date.now() - 25 * 3_600_000) } });
    const agentList = (await request(app).get(`/api/quick-replies/conversation/${conversation.id}`).set("Authorization", `Bearer ${agentToken}`)).body;
    expect(agentList.find((r: { shortcut: string }) => r.shortcut === "contrato")).toBeUndefined();
    const stale = (await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`)).body;
    expect(stale).toMatchObject({ status: "UNAVAILABLE", reason: null });
    const adminView = (await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${adminToken}`)).body;
    expect(adminView.reason).toContain("prazo");
  });

  it("erro na atualização avisa a gestão e deixa os dados indisponíveis", async () => {
    const link = await request(app)
      .post("/api/data-sources")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Link", kind: "LINK", config: { url: "http://127.0.0.1:9/planilha.csv" } });
    await prisma.dataSource.updateMany({ data: { active: false } });
    await request(app).post(`/api/data-sources/${link.body.id}/active`).set("Authorization", `Bearer ${adminToken}`).send({ active: true }).expect(200);
    const after = await prisma.dataSource.findUniqueOrThrow({ where: { id: link.body.id } });
    expect(after.lastSyncError).toBeTruthy();
    expect(await prisma.dataSource.count({ where: { active: true } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: "DATA_SOURCE_ERROR" } })).toBeGreaterThan(0);
    await syncDueDataSources(new Date(Date.now() + 2 * 3_600_000));
  });

  it("painel: rótulos sem colunas de controle, cada contrato com os seus dados e o titular uma vez só", async () => {
    const holderTwice = "Rita Teste;Titular;01/02/1980;Não | Rita Teste;Titular;01/02/1980;Não | Lia Teste;Filha;01/02/2015;Não";
    const csv = [
      "telefone_whatsapp,clientes_neste_telefone,codigo_cliente,nome_cliente,cidade,numero_contrato,plano,situacao_contrato,data_contrato,quantidade_beneficiarios,beneficiarios,parcelas_suspensao",
      `5565999990099,1,99,Rita Teste,Cuiabá - MT,K-1,Plano Ouro,Ativo,15/04/2014,3,${holderTwice},4`,
      "5565999990099,1,99,Rita Teste,Cuiabá - MT,K-2,Plano Prata,Ativo,03/02/2021,1,Rita Teste;Titular;01/02/1980;Não,4",
    ].join("\n");
    const created = await request(app).post("/api/data-sources").set("Authorization", `Bearer ${adminToken}`).send({ name: "ERP", kind: "UPLOAD" });
    await request(app).post(`/api/data-sources/${created.body.id}/upload`).set("Authorization", `Bearer ${adminToken}`).attach("file", Buffer.from(csv), { filename: "erp.csv", contentType: "text/csv" });
    await prisma.dataSource.updateMany({ data: { active: false } });
    await request(app).post(`/api/data-sources/${created.body.id}/active`).set("Authorization", `Bearer ${adminToken}`).send({ active: true }).expect(200);

    const conversation = await conversationFor("5565999990099");
    const { client } = (await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`)).body;
    expect(client.fields.map((f: { column: string }) => f.column)).toEqual(["telefone_whatsapp", "codigo_cliente", "nome_cliente", "cidade"]);
    expect(client.contracts.map((c: { number: string; fields: { column: string; value: string }[] }) => [c.number, c.fields])).toEqual([
      ["K-1", [{ column: "data_contrato", value: "15/04/2014", sensitive: false }]],
      ["K-2", [{ column: "data_contrato", value: "03/02/2021", sensitive: false }]],
    ]);
    expect(client.contracts[0].beneficiaries.map((b: { name: string }) => b.name)).toEqual(["Rita Teste", "Lia Teste"]);
  });


  it("Contatos › Contrato: vem da planilha, o atendente corrige e a planilha não apaga a correção", async () => {
    const source = await prisma.dataSource.findFirstOrThrow({ where: { name: "ERP" } });
    // The conversation the previous test opened for this phone.
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990099" } } });
    const contact = () => prisma.contact.findUniqueOrThrow({ where: { id: conversation.contactId } });
    await prisma.contact.update({ where: { id: conversation.contactId }, data: { contractNumber: null } });

    await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`).expect(200);
    expect((await contact()).contractNumber).toBe("K-1, K-2");

    const edited = await request(app)
      .put(`/api/conversations/${conversation.id}/contact-contract`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ contractNumber: " K-1 " });
    expect(edited.status).toBe(200);
    expect(edited.body.contractNumber).toBe("K-1");

    await request(app).post(`/api/data-sources/${source.id}/sync`).set("Authorization", `Bearer ${adminToken}`);
    await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`).expect(200);
    expect((await contact()).contractNumber).toBe("K-1");

    const found = await request(app).get("/api/contacts?search=K-1").set("Authorization", `Bearer ${adminToken}`);
    expect(found.body.items.map((c: { contractNumber: string }) => c.contractNumber)).toContain("K-1");
  });


  it("fonte por conexão: a ligada à conexão vence a de todas; não deixa duas fontes para a mesma conexão", async () => {
    const upload = async (name: string, client: string, body: Record<string, unknown> = {}) => {
      const created = await request(app).post("/api/data-sources").set("Authorization", `Bearer ${adminToken}`).send({ name, kind: "UPLOAD", ...body });
      const csv = ["telefone_whatsapp,codigo_cliente,nome_cliente", `5565999990077,1,${client}`].join("\n");
      await request(app).post(`/api/data-sources/${created.body.id}/upload`).set("Authorization", `Bearer ${adminToken}`).attach("file", Buffer.from(csv), { filename: "f.csv", contentType: "text/csv" });
      return created.body.id as string;
    };
    await prisma.dataSource.updateMany({ data: { active: false } });
    const all = await upload("Todas", "Cliente Geral");
    const linked = await upload("Só Dados", "Cliente da Conexão", { allConnections: false, connectionIds: [connectionId] });
    const otherAll = await upload("Outra geral", "X");
    const activate = (id: string) => request(app).post(`/api/data-sources/${id}/active`).set("Authorization", `Bearer ${adminToken}`).send({ active: true });
    await activate(all).expect(200);
    const conversation = await conversationFor("5565999990077");
    const nameShown = async () => (await request(app).get(`/api/conversations/${conversation.id}/client-data`).set("Authorization", `Bearer ${agentToken}`)).body.client?.name;
    expect(await nameShown()).toBe("Cliente Geral");
    await activate(linked).expect(200);
    expect(await nameShown()).toBe("Cliente da Conexão");

    const second = await activate(otherAll);
    expect(second.status).toBe(409);
    expect(second.body.message).toContain("todas as conexões");
    const sameConnection = await upload("Também Dados", "Y", { allConnections: false, connectionIds: [connectionId] });
    const clash = await activate(sameConnection);
    expect(clash.status).toBe(409);
    expect(clash.body.message).toContain("uma conexão só pode estar em uma fonte ativa");
  });
});
