import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Records the name each file is sent to the customer's WhatsApp with (and answers "the number exists").
const sentNames: string[] = [];
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    lookupNumber: vi.fn(async (_connectionId: string, phone: string) => ({ phone })),
    sendOutboundFile: vi.fn(async (...args: Parameters<typeof actual.sendOutboundFile>) => {
      sentNames.push(args[4]);
      return actual.sendOutboundFile(...args);
    }),
  };
});
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();
const NAME = "Manutenção de Atendimentos Funerários 04-11.xlsx";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function loginAs(email: string) {
  return (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;
}

describe("nome de arquivo com acento (o upload lia o nome do navegador como Latin-1)", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    sentNames.length = 0;
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("na conversa: o nome fica certo no sistema, no WhatsApp do cliente e no download", async () => {
    await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
    const token = await loginAs("joao@test.dev");
    const { conversation } = await createWaitingConversation("5511990009999", connectionId);
    await request(app).post(`/api/conversations/${conversation.id}/accept`).set("Authorization", `Bearer ${token}`);

    const sent = await request(app)
      .post(`/api/messages/conversations/${conversation.id}/file`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("planilha"), { filename: NAME, contentType: XLSX });
    expect(sent.status).toBe(201);
    expect(sent.body.attachments[0].fileName).toBe(NAME);
    expect(sentNames).toEqual([NAME]);

    const download = await request(app).get(`/api/messages/attachments/${sent.body.attachments[0].id}/download`).set("Authorization", `Bearer ${token}`);
    expect(download.headers["content-disposition"]).toBe(
      `attachment; filename="Manutencao de Atendimentos Funerarios 04-11.xlsx"; filename*=UTF-8''${encodeURIComponent(NAME)}`
    );
  });

  it("no chat interno: o nome aparece certo para quem recebe", async () => {
    await createTestUser({ email: "ana@test.dev", role: "AGENT", displayName: "Ana" });
    const token = await loginAs("ana@test.dev");
    const general = (await request(app).get("/api/internal-chat/rooms").set("Authorization", `Bearer ${token}`)).body[0];
    const sent = await request(app)
      .post(`/api/internal-chat/rooms/${general.id}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("planilha"), { filename: NAME, contentType: XLSX });
    expect(sent.status).toBe(201);
    expect(sent.body.attachment.name).toBe(NAME);
    const stored = await prisma.chatMessage.findUniqueOrThrow({ where: { id: sent.body.id } });
    expect(stored.attachmentName).toBe(NAME);
  });

  it("todo upload da API passa pela configuração que lê o nome em UTF-8 (lib/upload.ts)", () => {
    const src = path.join(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) =>
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (full.endsWith(".ts") && !full.endsWith(path.join("lib", "upload.ts")) && /\bmulter\(/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(src, full));
      });
    walk(src);
    expect(offenders).toEqual([]);
  });
});
