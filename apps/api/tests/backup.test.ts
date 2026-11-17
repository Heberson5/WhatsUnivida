import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { readTar } from "../src/lib/tar";
import { openBackup } from "../src/lib/backup-crypto";
import { __resetDriveTokenForTests } from "../src/lib/google-drive";
import { writeBackup } from "../src/modules/backup/backup.service";
import { runNightlyBackup } from "../src/modules/backup/drive-backup.service";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";
import { fakeGoogle } from "./fake-google";

vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "10000000";
});

const app = createApp();
const PASSWORD = "senha-do-backup-123";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wa-backup-test-"));

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

/** The names inside a password-protected backup file. */
async function entriesOf(file: string, password = PASSWORD) {
  const names: string[] = [];
  await readTar(openBackup(file, password), async (entry) => {
    names.push(entry.name);
    entry.stream.resume();
    await new Promise((resolve) => entry.stream.on("end", resolve));
  });
  return names;
}

async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Configurações › Backup", () => {
  let adminToken: string;
  let agentToken: string;
  let adminId: string;
  let backupFile: string;
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });
  const uploadName = `backup-test-${Date.now()}.txt`;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.chatRoom.deleteMany();
    await prisma.systemSetting.deleteMany({ where: { key: { in: ["googleDrive", "driveBackup", "backupPassword", "backup"] } } });
    adminId = (await createTestUser({ email: "admin-bk@test.dev", role: "ADMIN", displayName: "Admin Backup" })).id;
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
    fs.rmSync(scratch, { recursive: true, force: true });
    await prisma.chatRoom.deleteMany();
    await prisma.systemSetting.deleteMany({ where: { key: { in: ["googleDrive", "driveBackup", "backupPassword"] } } });
    await prisma.$disconnect();
  });

  it("só o administrador vê, baixa e configura o backup", async () => {
    const agent = { Authorization: `Bearer ${agentToken}` };
    expect((await request(app).get("/api/settings/backup/info").set(agent)).status).toBe(403);
    expect((await request(app).get("/api/settings/backup/settings").set(agent)).status).toBe(403);
    expect((await request(app).post("/api/settings/backup/download-ticket").set(agent).send({ password: PASSWORD })).status).toBe(403);
    expect((await request(app).put("/api/settings/backup/password").set(agent).send({ password: PASSWORD, confirm: PASSWORD })).status).toBe(403);
    const info = (await request(app).get("/api/settings/backup/info").set(auth())).body;
    expect(info.tables).toBeGreaterThan(50);
  });

  it("baixa um backup protegido por senha, com o manifesto, todas as tabelas e os arquivos — por um link que vale uma vez", async () => {
    expect((await request(app).post("/api/settings/backup/download-ticket").set(auth()).send({ password: "curta" })).status).toBe(400);
    const { url } = (await request(app).post("/api/settings/backup/download-ticket").set(auth()).send({ password: PASSWORD, files: true, sessions: false })).body;
    expect(url).toMatch(/^\/api\/settings\/backup\/download\/[\w-]+$/);
    const res = await request(app).get(url).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/backup-.*\.wabk/);
    const body = res.body as Buffer;
    expect(body.subarray(0, 4).toString()).toBe("WABK");
    // Without the password nothing inside can be read: not even the table names.
    expect(body.includes(Buffer.from("database/User.jsonl"))).toBe(false);
    backupFile = path.join(scratch, "backup.wabk");
    fs.writeFileSync(backupFile, body);
    const names = await entriesOf(backupFile);
    expect(names[0]).toBe("manifest.json");
    expect(names).toContain("database/User.jsonl");
    expect(names).toContain("database/ChatMessage.jsonl");
    expect(names).toContain(`files/${uploadName}`);
    expect(names.some((n) => n.startsWith("whatsapp-sessions/"))).toBe(false);
    await expect(entriesOf(backupFile, "senha-errada-123")).rejects.toThrow();
    // The link works once.
    expect((await request(app).get(url)).status).toBe(404);
    let marker = await prisma.systemSetting.findUnique({ where: { key: "backup" } });
    for (let i = 0; i < 50 && !marker; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      marker = await prisma.systemSetting.findUnique({ where: { key: "backup" } });
    }
    expect(marker).toMatchObject({ value: { kind: "BACKUP", byName: "Admin Backup" } });
  });

  it("restaura tudo como estava; recusa senha errada, arquivo inválido ou sem a confirmação, sem mudar nada", async () => {
    await prisma.chatMessage.deleteMany({ where: { body: "mensagem que precisa voltar" } });
    await createTestUser({ email: "depois@test.dev", role: "AGENT" });
    fs.rmSync(path.join(env.UPLOAD_DIR, uploadName), { force: true });
    const restore = (fields: Record<string, string>, file: Buffer | string = backupFile, token = adminToken) => {
      const req = request(app).post("/api/settings/backup/restore").set("Authorization", `Bearer ${token}`).attach("file", file, "b.wabk");
      for (const [k, v] of Object.entries(fields)) void req.field(k, v);
      return req;
    };

    expect((await restore({ confirm: "RESTAURAR", password: PASSWORD }, Buffer.from("x"), agentToken)).status).toBe(403);
    expect((await restore({ confirm: "sim", password: PASSWORD })).status).toBe(400);
    const noPassword = await restore({ confirm: "RESTAURAR" });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.message).toMatch(/senha/i);
    const wrong = await restore({ confirm: "RESTAURAR", password: "senha-errada-123" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/Senha do backup incorreta/);
    expect((await restore({ confirm: "RESTAURAR", password: PASSWORD }, Buffer.from("não é backup"))).status).toBe(400);
    expect(await prisma.user.count({ where: { email: "depois@test.dev" } })).toBe(1);

    const restored = await restore({ confirm: "RESTAURAR", password: PASSWORD });
    expect(restored.status).toBe(200);
    expect(restored.body.rows).toBeGreaterThan(0);
    const message = await prisma.chatMessage.findFirst({ where: { body: "mensagem que precisa voltar" } });
    expect(message?.mentions).toEqual(["ALL"]);
    expect(await prisma.user.count({ where: { email: "depois@test.dev" } })).toBe(0);
    expect(fs.readFileSync(path.join(env.UPLOAD_DIR, uploadName), "utf8")).toBe("anexo de teste");
    expect(await loginAs("ana-bk@test.dev")).toBeTruthy();
  });

  it("um backup antigo, sem senha (.tar.gz), continua sendo restaurado", async () => {
    const plain = path.join(scratch, "antigo.tar.gz");
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    await writeBackup(out, { files: false, whatsappSessions: false }, { userId: "", name: "teste" });
    fs.writeFileSync(plain, Buffer.concat(chunks));
    await createTestUser({ email: "some-com-o-antigo@test.dev", role: "AGENT" });
    const res = await request(app).post("/api/settings/backup/restore").set(auth()).attach("file", plain, "antigo.tar.gz").field("confirm", "RESTAURAR");
    expect(res.status).toBe(200);
    expect(await prisma.user.count({ where: { email: "some-com-o-antigo@test.dev" } })).toBe(0);
  });

  it("depois de restaurar num servidor novo, o número sequencial (seq) continua após o maior restaurado", async () => {
    await prisma.$executeRawUnsafe(`ALTER SEQUENCE "User_seq_seq" RESTART WITH 1`);
    const restored = await request(app).post("/api/settings/backup/restore").set(auth()).attach("file", backupFile, "b.wabk").field("confirm", "RESTAURAR").field("password", PASSWORD);
    expect(restored.status).toBe(200);
    const { _max } = await prisma.user.aggregate({ _max: { seq: true } });
    expect(_max.seq).toBeGreaterThan(1);
    const created = await createTestUser({ email: "novo-pos-restore@test.dev", role: "AGENT" });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.seq).toBe(_max.seq! + 1);
  });

  describe("Google Drive", () => {
    let google: ReturnType<typeof fakeGoogle>;
    const original = { auth: env.GOOGLE_AUTH_URL, token: env.GOOGLE_TOKEN_URL, revoke: env.GOOGLE_REVOKE_URL, api: env.GOOGLE_API_URL, free: env.BACKUP_MIN_FREE_MB };
    const backupsOnDrive = () => [...google.files.values()].filter((f) => f.name.endsWith(".wabk"));
    const settings = async () => (await request(app).get("/api/settings/backup/settings").set(auth())).body;

    beforeAll(async () => {
      // The restores above brought back the session of the backup: log in again.
      adminToken = await loginAs("admin-bk@test.dev");
      adminId = (await prisma.user.findFirstOrThrow({ where: { email: "admin-bk@test.dev" } })).id;
      google = fakeGoogle();
      await new Promise<void>((resolve) => google.server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(google.server.address() as AddressInfo).port}`;
      Object.assign(env, { GOOGLE_AUTH_URL: `${base}/auth`, GOOGLE_TOKEN_URL: `${base}/token`, GOOGLE_REVOKE_URL: `${base}/revoke`, GOOGLE_API_URL: base });
      __resetDriveTokenForTests();
    });

    afterAll(async () => {
      Object.assign(env, { GOOGLE_AUTH_URL: original.auth, GOOGLE_TOKEN_URL: original.token, GOOGLE_REVOKE_URL: original.revoke, GOOGLE_API_URL: original.api, BACKUP_MIN_FREE_MB: original.free });
      await new Promise((resolve) => google.server.close(resolve));
    });

    it("conecta uma vez com a conta Google do administrador, pedindo só os arquivos que o sistema cria", async () => {
      expect((await request(app).post("/api/settings/backup/drive/connect").set(auth())).status).toBe(502);
      await request(app).patch("/api/settings/backup/drive").set(auth()).send({ clientId: "cliente-123.apps.googleusercontent.com", clientSecret: "segredo-123" }).expect(200);
      const before = await settings();
      expect(before.drive).toMatchObject({ configured: true, connected: false, redirectUri: expect.stringMatching(/\/api\/settings\/backup\/google-drive\/callback$/) });
      expect(before.drive.folderName).toMatch(/^Backups — /);
      // The client secret is never sent back.
      expect(JSON.stringify(before)).not.toContain("segredo-123");

      const { url } = (await request(app).post("/api/settings/backup/drive/connect").set(auth())).body;
      const params = new URL(url).searchParams;
      expect(params.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.file");
      expect(params.get("access_type")).toBe("offline");
      const forged = await request(app).get("/api/settings/backup/google-drive/callback").query({ code: "codigo-bom", state: "falso.falso" });
      expect(forged.headers.location).toMatch(/secao=backup&drive=erro$/);
      const back = await request(app).get("/api/settings/backup/google-drive/callback").query({ code: "codigo-bom", state: params.get("state") });
      expect(back.status).toBe(302);
      expect(back.headers.location).toMatch(/\/configuracoes\?secao=backup&drive=conectado$/);
      expect((await settings()).drive).toMatchObject({ connected: true, accountEmail: "dono@gmail.com" });
      const stored = await prisma.systemSetting.findUniqueOrThrow({ where: { key: "googleDrive" } });
      expect(JSON.stringify(stored.value)).not.toContain("renovacao-1");
    });

    it("envia ao Drive com a senha de backup, na pasta deste sistema, e guarda só os mais recentes", async () => {
      const send = () => request(app).post("/api/settings/backup/drive/backup").set(auth()).send({ files: true, sessions: false });
      expect((await send()).status).toBe(400); // no backup password yet
      expect((await request(app).put("/api/settings/backup/password").set(auth()).send({ password: PASSWORD, confirm: "outra-senha-123" })).status).toBe(400);
      await request(app).put("/api/settings/backup/password").set(auth()).send({ password: PASSWORD, confirm: PASSWORD }).expect(204);
      expect((await settings()).hasBackupPassword).toBe(true);
      await request(app).patch("/api/settings/backup/auto").set(auth()).send({ keep: 2 }).expect(200);

      for (let i = 1; i <= 3; i++) {
        expect((await send()).status).toBe(202);
        await until(async () => !(await settings()).running, "the backup to finish");
      }
      const s = await settings();
      expect(s.lastError).toBeNull();
      expect(s.lastBackupAt).toBeTruthy();
      const kept = backupsOnDrive();
      expect(kept).toHaveLength(2);
      const folder = [...google.files.values()].find((f) => f.id === kept[0].parents[0])!;
      expect(folder.name).toMatch(/^Backups — /);
      expect(folder.parents).toEqual(["root"]);
      const local = path.join(scratch, "do-drive.wabk");
      fs.writeFileSync(local, kept[0].data);
      expect(await entriesOf(local)).toContain(`files/${uploadName}`);

      const listed = (await request(app).get("/api/settings/backup/drive/files").set(auth())).body;
      expect(listed.connected).toBe(true);
      expect(listed.files.map((f: { id: string }) => f.id).sort()).toEqual(kept.map((f) => f.id).sort());
    });

    it("restaura um backup do Drive (a senha de backup cadastrada abre o arquivo)", async () => {
      await createTestUser({ email: "depois-do-drive@test.dev", role: "AGENT" });
      const [latest] = (await request(app).get("/api/settings/backup/drive/files").set(auth())).body.files;
      expect((await request(app).post(`/api/settings/backup/drive/files/${latest.id}/restore`).set(auth()).send({ confirm: "não" })).status).toBe(400);
      expect((await request(app).post(`/api/settings/backup/drive/files/${latest.id}/restore`).set(auth()).send({ confirm: "RESTAURAR", password: "senha-errada-123" })).status).toBe(400);
      const res = await request(app).post(`/api/settings/backup/drive/files/${latest.id}/restore`).set(auth()).send({ confirm: "RESTAURAR" });
      expect(res.status).toBe(200);
      expect(await prisma.user.count({ where: { email: "depois-do-drive@test.dev" } })).toBe(0);
      // The Drive connection is part of the data: it is still there after the restore.
      adminToken = await loginAs("admin-bk@test.dev");
      expect((await settings()).drive.connected).toBe(true);
      expect((await settings()).running).toBe(false);
    });

    it("backup automático: uma vez por noite a partir da hora marcada; falhas avisam os administradores", async () => {
      adminId = (await prisma.user.findFirstOrThrow({ where: { email: "admin-bk@test.dev" } })).id;
      expect(await runNightlyBackup(new Date("2027-03-10T07:30:00Z"))).toBe("SKIPPED"); // turned off
      // The connections (WhatsApp sessions) go by default.
      expect((await settings()).auto.includeSessions).toBe(true);
      const sessionDir = path.join(env.WHATSAPP_AUTH_DIR, "conexao-backup-teste");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "creds.json"), "{}");
      await request(app).patch("/api/settings/backup/auto").set(auth()).send({ enabled: true, keep: 3, includeFiles: false }).expect(200);
      // BACKUP_HOUR 3h in the business time zone (UTC-4) = 07:00 UTC.
      expect(await runNightlyBackup(new Date("2027-03-10T06:30:00Z"))).toBe("SKIPPED");
      expect(await runNightlyBackup(new Date("2027-03-10T07:30:00Z"))).toBe("DONE");
      expect(await runNightlyBackup(new Date("2027-03-10T09:30:00Z"))).toBe("SKIPPED"); // already today
      const local = path.join(scratch, "noturno.wabk");
      fs.writeFileSync(local, backupsOnDrive().sort((a, b) => b.createdTime.localeCompare(a.createdTime))[0].data);
      expect((await entriesOf(local)).some((n) => n.startsWith("files/"))).toBe(false); // includeFiles: false
      expect(await entriesOf(local)).toContain("whatsapp-sessions/conexao-backup-teste/creds.json");
      fs.rmSync(sessionDir, { recursive: true, force: true });
      expect(backupsOnDrive()).toHaveLength(3);

      await prisma.notification.deleteMany({ where: { userId: adminId } });
      env.BACKUP_MIN_FREE_MB = 1e12;
      expect(await runNightlyBackup(new Date("2027-03-11T07:30:00Z"))).toBe("FAILED");
      env.BACKUP_MIN_FREE_MB = original.free;
      expect((await settings()).lastError).toMatch(/Pouco espaço livre/);
      expect(await prisma.notification.findFirst({ where: { userId: adminId, type: "BACKUP_ALERT" } })).toMatchObject({ title: "Backup não feito" });
      // A failure is not retried every 10 minutes: the next try is the next night.
      expect(await runNightlyBackup(new Date("2027-03-11T08:30:00Z"))).toBe("SKIPPED");

      // Authorization taken back in the Google account: the next night says so.
      google.state.revoked = true;
      __resetDriveTokenForTests();
      expect(await runNightlyBackup(new Date("2027-03-12T07:30:00Z"))).toBe("FAILED");
      expect((await settings()).lastError).toMatch(/retirou a autorização/);
      google.state.revoked = false;

      await prisma.notification.deleteMany({ where: { userId: adminId } });
      await request(app).post("/api/settings/backup/drive/disconnect").set(auth()).expect(200);
      expect(await runNightlyBackup(new Date("2027-03-13T07:30:00Z"))).toBe("FAILED");
      expect(await prisma.notification.findFirst({ where: { userId: adminId, type: "BACKUP_ALERT" } })).toMatchObject({ title: "Backup automático parado" });
    });

    it("não liga o backup automático sem a senha de backup", async () => {
      await prisma.systemSetting.deleteMany({ where: { key: "backupPassword" } });
      expect((await request(app).patch("/api/settings/backup/auto").set(auth()).send({ enabled: true })).status).toBe(400);
    });
  });
});
