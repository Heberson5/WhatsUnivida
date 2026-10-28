import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { readTar } from "../src/lib/tar";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

async function entriesOf(archive: Buffer) {
  const names: string[] = [];
  await readTar(Readable.from(gunzipSync(archive)), async (entry) => {
    names.push(entry.name);
    entry.stream.resume();
    await new Promise((resolve) => entry.stream.on("end", resolve));
  });
  return names;
}

describe("Configurações › Backup", () => {
  let adminToken: string;
  let agentToken: string;
  let backup: Buffer;
  const uploadName = `backup-test-${Date.now()}.txt`;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.chatRoom.deleteMany();
    await createTestUser({ email: "admin-bk@test.dev", role: "ADMIN", displayName: "Admin Backup" });
    await createTestUser({ email: "ana-bk@test.dev", role: "AGENT", displayName: "Ana" });
    adminToken = await loginAs("admin-bk@test.dev");
    agentToken = await loginAs("ana-bk@test.dev");
    fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.UPLOAD_DIR, uploadName), "anexo de teste");
    // Some data of every kind: arrays, JSON, enums, dates.
    const general = (await request(app).get("/api/internal-chat/rooms").set("Authorization", `Bearer ${agentToken}`)).body[0];
    await request(app).post(`/api/internal-chat/rooms/${general.id}/messages`).set("Authorization", `Bearer ${agentToken}`).send({ body: "mensagem que precisa voltar", mentions: ["ALL"] }).expect(201);
  });

  afterAll(async () => {
    fs.rmSync(path.join(env.UPLOAD_DIR, uploadName), { force: true });
    await prisma.chatRoom.deleteMany();
    await prisma.$disconnect();
  });

  it("só o administrador vê e baixa o backup", async () => {
    expect((await request(app).get("/api/settings/backup/info").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
    expect((await request(app).get("/api/settings/backup/download").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
    const info = (await request(app).get("/api/settings/backup/info").set("Authorization", `Bearer ${adminToken}`)).body;
    expect(info.tables).toBeGreaterThan(50);
  });

  it("baixa um .tar.gz com o manifesto, todas as tabelas e os arquivos", async () => {
    const res = await request(app).get(`/api/settings/backup/download?token=${adminToken}&files=1&sessions=0`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/whatsatendende-backup-.*\.tar\.gz/);
    backup = res.body as Buffer;
    const names = await entriesOf(backup);
    expect(names[0]).toBe("manifest.json");
    expect(names).toContain("database/User.jsonl");
    expect(names).toContain("database/ChatMessage.jsonl");
    expect(names).toContain(`files/${uploadName}`);
    expect(names.some((n) => n.startsWith("whatsapp-sessions/"))).toBe(false);
    expect(await prisma.systemSetting.findUnique({ where: { key: "backup" } })).toMatchObject({ value: { kind: "BACKUP", byName: "Admin Backup" } });
  });

  it("restaura tudo como estava, e recusa arquivo inválido ou sem a confirmação", async () => {
    // Things change after the backup...
    await prisma.chatMessage.deleteMany({ where: { body: "mensagem que precisa voltar" } });
    await createTestUser({ email: "depois@test.dev", role: "AGENT" });
    fs.rmSync(path.join(env.UPLOAD_DIR, uploadName), { force: true });

    expect((await request(app).post("/api/settings/backup/restore").set("Authorization", `Bearer ${agentToken}`).attach("file", backup, "b.tar.gz").field("confirm", "RESTAURAR")).status).toBe(403);
    expect((await request(app).post("/api/settings/backup/restore").set("Authorization", `Bearer ${adminToken}`).attach("file", backup, "b.tar.gz").field("confirm", "sim")).status).toBe(400);
    const invalid = await request(app).post("/api/settings/backup/restore").set("Authorization", `Bearer ${adminToken}`).attach("file", Buffer.from("não é backup"), "x.tar.gz").field("confirm", "RESTAURAR");
    expect(invalid.status).toBe(400);
    expect(await prisma.user.count({ where: { email: "depois@test.dev" } })).toBe(1);

    const restored = await request(app).post("/api/settings/backup/restore").set("Authorization", `Bearer ${adminToken}`).attach("file", backup, "b.tar.gz").field("confirm", "RESTAURAR");
    expect(restored.status).toBe(200);
    expect(restored.body.rows).toBeGreaterThan(0);
    const message = await prisma.chatMessage.findFirst({ where: { body: "mensagem que precisa voltar" } });
    expect(message?.mentions).toEqual(["ALL"]);
    expect(await prisma.user.count({ where: { email: "depois@test.dev" } })).toBe(0);
    expect(fs.readFileSync(path.join(env.UPLOAD_DIR, uploadName), "utf8")).toBe("anexo de teste");
    // The people of the backup can still log in.
    expect(await loginAs("ana-bk@test.dev")).toBeTruthy();
  });
});
