import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("sending a file: any type, like WhatsApp Web", () => {
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
    ["arquivos.rar", "application/vnd.rar"],
    ["arquivos.7z", "application/x-7z-compressed"],
    ["dados.csv", "text/csv"],
    ["pagina.html", "text/html"],
    ["programa.exe", "application/x-msdownload"],
    ["logo.svg", "image/svg+xml"],
    ["foto.heic", "image/heic"],
    ["sem-tipo.cdr", "application/octet-stream"],
  ])("sends %s as a document", async (filename, contentType) => {
    const res = await sendFile("x", filename, contentType);
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("DOCUMENT");
  });

  it("sends a JPG as a picture and an MP4 as a video", async () => {
    expect((await sendFile("x", "foto.jpg", "image/jpeg")).body.type).toBe("IMAGE");
    expect((await sendFile("x", "video.mp4", "video/mp4")).body.type).toBe("VIDEO");
  });

  it("a file that could run code is only downloaded; a picture still opens on the screen", async () => {
    const svg = await sendFile("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "logo.svg", "image/svg+xml");
    const svgDownload = await request(app).get(svg.body.attachments[0].url).set("Authorization", `Bearer ${accessToken}`);
    expect(svgDownload.status).toBe(200);
    expect(svgDownload.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(svgDownload.headers["content-type"]).toContain("application/octet-stream");

    const png = await sendFile("x", "foto.png", "image/png");
    const pngDownload = await request(app).get(png.body.attachments[0].url).set("Authorization", `Bearer ${accessToken}`);
    expect(pngDownload.headers["content-disposition"]).toMatch(/^inline;/);
    expect(pngDownload.headers["content-type"]).toContain("image/png");
  });
});
