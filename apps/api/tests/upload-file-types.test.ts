import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("sending a file: allowed types", () => {
  let accessToken: string;
  let conversationId: string;

  beforeEach(async () => {
    await resetDatabase();
    const connection = await createTestConnection("Suporte");
    await createTestUser({ email: "joao-tipos@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connection.id });
    accessToken = (await request(app).post("/api/auth/login").send({ email: "joao-tipos@test.dev", password: TEST_PASSWORD })).body.accessToken;
    const { conversation } = await createWaitingConversation("5511990009998", connection.id);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${accessToken}`);
    conversationId = conversation.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function sendFile(content: string | Buffer, filename: string, contentType: string) {
    return request(app)
      .post(`/api/messages/conversations/${conversationId}/file`)
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from(content), { filename, contentType });
  }

  it("sends a Bloco de Notas file (.txt) as a document, and serves it back as text", async () => {
    const res = await sendFile("Linha 1\nLinha 2 — acentuação\n", "anotacoes.txt", "text/plain");
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("DOCUMENT");
    expect(res.body.attachments[0]).toMatchObject({ fileName: "anotacoes.txt", mimeType: "text/plain" });

    const download = await request(app).get(res.body.attachments[0].url).set("Authorization", `Bearer ${accessToken}`);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("text/plain");
    expect(download.text).toBe("Linha 1\nLinha 2 — acentuação\n");
  });

  it.each([
    ["relatorio.pdf", "application/pdf"],
    ["contrato.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["antigo.doc", "application/msword"],
  ])("still sends %s", async (filename, contentType) => {
    expect((await sendFile("x", filename, contentType)).status).toBe(201);
  });

  it.each([
    ["dados.csv", "text/csv"],
    ["pagina.html", "text/html"],
    ["programa.exe", "application/x-msdownload"],
  ])("refuses %s with a clear 400 (it used to be a 500), and records nothing", async (filename, contentType) => {
    const before = await prisma.message.count({ where: { conversationId } });
    const res = await sendFile("x", filename, contentType);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Tipo de arquivo não permitido");
    expect(res.body.message).toContain("Bloco de Notas (.txt)");
    expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
  });
});
