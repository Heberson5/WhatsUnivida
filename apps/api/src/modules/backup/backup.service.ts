import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { finishTar, readTar, writeTarEntry } from "../../lib/tar";
import { DEFAULT_RELEASES } from "../release-notes/default-releases";

/**
 * Configurações › Backup (administrador): everything needed to move the system to another server — every table of
 * the database, the uploaded files (photos, attachments, boletos, release-note images) and, optionally, the WhatsApp
 * sessions (so the QR Code connections come back without being read again) — in one .tar.gz.
 *
 * The database goes table by table as JSON lines, read back by Postgres itself (json_populate_recordset), so the
 * file doesn't depend on pg_dump nor on the Postgres version. It is restored on a server running the same version
 * of the system (the same migrations): the restore checks that first and touches nothing otherwise.
 */

export const BACKUP_FORMAT = 1;
const BATCH = 1000;
const MIGRATIONS_TABLE = "_prisma_migrations";

export interface BackupManifest {
  format: number;
  app: "WhatsAtendende";
  version: string;
  createdAt: string;
  migrations: string[];
  tables: string[];
  includes: { files: boolean; whatsappSessions: boolean };
}

export interface BackupOptions {
  files: boolean;
  whatsappSessions: boolean;
}

async function tables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ${MIGRATIONS_TABLE} ORDER BY tablename`;
  return rows.map((r) => r.tablename);
}

async function appliedMigrations(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
  return rows.map((r) => r.migration_name);
}

const quote = (table: string) => `"${table.replace(/"/g, '""')}"`;

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join("/")] : [];
  });
}

function folderSize(dir: string): number {
  return walk(dir).reduce((sum, rel) => sum + fs.statSync(path.join(dir, rel)).size, 0);
}

export async function backupInfo() {
  const [names, last] = await Promise.all([tables(), prisma.systemSetting.findUnique({ where: { key: "backup" } })]);
  const counts = await prisma.$queryRaw<{ rows: bigint }[]>`SELECT COALESCE(SUM(n_live_tup), 0)::bigint AS rows FROM pg_stat_user_tables WHERE schemaname = 'public'`;
  return {
    version: DEFAULT_RELEASES[0]?.version ?? "",
    tables: names.length,
    approximateRows: Number(counts[0]?.rows ?? 0),
    filesBytes: folderSize(env.UPLOAD_DIR),
    whatsappSessionsBytes: folderSize(env.WHATSAPP_AUTH_DIR),
    last: (last?.value as { at: string; byName: string; kind: "BACKUP" | "RESTORE" } | null) ?? null,
  };
}

/** Writes a table as JSON lines into a temporary file (a tar entry needs its size before its bytes). */
async function dumpTable(table: string, file: string): Promise<number> {
  const out = fs.createWriteStream(file);
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await prisma.$queryRawUnsafe<{ j: string }[]>(`SELECT row_to_json(t)::text AS j FROM ${quote(table)} t ORDER BY ctid LIMIT ${BATCH} OFFSET ${offset}`);
    for (const row of rows) {
      if (!out.write(row.j + "\n")) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    total += rows.length;
    offset += BATCH;
    if (rows.length < BATCH) break;
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return total;
}

/** Streams the whole backup (.tar.gz) into `output`. */
export async function writeBackup(output: Writable, options: BackupOptions, by: { userId: string; name: string }): Promise<void> {
  const names = await tables();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    app: "WhatsAtendende",
    version: DEFAULT_RELEASES[0]?.version ?? "",
    createdAt: new Date().toISOString(),
    migrations: await appliedMigrations(),
    tables: names,
    includes: { files: options.files, whatsappSessions: options.whatsappSessions },
  };
  const gzip = createGzip({ level: 6 });
  const done = pipeline(gzip, output);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-backup-"));
  try {
    await writeTarEntry(gzip, "manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
    await writeTarEntry(gzip, "LEIA-ME.txt", Buffer.from(readme(manifest)));
    for (const table of names) {
      const file = path.join(tmp, `${table}.jsonl`);
      await dumpTable(table, file);
      await writeTarEntry(gzip, `database/${table}.jsonl`, { size: fs.statSync(file).size, stream: fs.createReadStream(file) });
      fs.rmSync(file, { force: true });
    }
    const folders: [boolean, string, string][] = [
      [options.files, env.UPLOAD_DIR, "files"],
      [options.whatsappSessions, env.WHATSAPP_AUTH_DIR, "whatsapp-sessions"],
    ];
    for (const [include, dir, prefix] of folders) {
      if (!include) continue;
      for (const rel of walk(dir)) {
        const full = path.join(dir, rel);
        const stat = fs.statSync(full);
        await writeTarEntry(gzip, `${prefix}/${rel}`, { size: stat.size, stream: fs.createReadStream(full) });
      }
    }
    await finishTar(gzip);
    gzip.end();
    await done;
    await prisma.systemSetting.upsert({
      where: { key: "backup" },
      create: { key: "backup", value: { at: manifest.createdAt, byName: by.name, kind: "BACKUP" } },
      update: { value: { at: manifest.createdAt, byName: by.name, kind: "BACKUP" } },
    });
  } catch (err) {
    gzip.destroy(err as Error);
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readme(m: BackupManifest): string {
  return [
    "Backup do WhatsAtendende",
    `Versão do sistema: ${m.version}`,
    `Criado em: ${m.createdAt}`,
    "",
    "Para restaurar em outro servidor:",
    "1. Instale o WhatsAtendende na MESMA versão (veja acima) e deixe-o subir uma vez.",
    "2. No arquivo .env do servidor novo, use o MESMO SETTINGS_ENCRYPTION_KEY do servidor antigo",
    "   (sem ele, as senhas guardadas — e-mail, Meta, fontes de dados — não podem ser lidas).",
    "3. Entre como administrador e vá em Configurações › Backup › Restaurar, escolhendo este arquivo.",
    "   Arquivo muito grande? Copie-o para o servidor e rode:",
    "   docker compose exec api node dist/scripts/restore-backup.js /caminho/do/arquivo.tar.gz",
    "",
    "Guarde este arquivo em local seguro: ele tem todos os dados dos clientes e das conversas.",
  ].join("\n");
}

/** Lines of a JSONL stream, `size` at a time. */
async function* batches(file: string, size: number): AsyncGenerator<string[]> {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let batch: string[] = [];
  for await (const line of lines) {
    if (!line) continue;
    batch.push(line);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

/**
 * Restores a backup: reads it whole first (into a staging folder), checks it was made by this same version of the
 * system, and only then replaces the database and the files. Anything wrong before that point changes nothing.
 */
export async function restoreBackup(input: Readable, by: { userId: string; name: string }): Promise<{ manifest: BackupManifest; rows: number; files: number }> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "wa-restore-"));
  let manifest: BackupManifest | null = null;
  let files = 0;
  try {
    await readTar(input.pipe(createGunzip()), async (entry) => {
      if (entry.name === "manifest.json") {
        const chunks: Buffer[] = [];
        for await (const c of entry.stream) chunks.push(c as Buffer);
        manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BackupManifest;
        return;
      }
      if (!manifest) throw Errors.badRequest("Arquivo inválido: não é um backup do WhatsAtendende");
      const target = path.join(staging, entry.name);
      if (!path.resolve(target).startsWith(path.resolve(staging) + path.sep)) throw Errors.badRequest("Arquivo de backup inválido");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await pipeline(entry.stream, fs.createWriteStream(target));
      if (!entry.name.startsWith("database/") && entry.name !== "LEIA-ME.txt") files++;
    }).catch((err) => {
      if (err instanceof Error && /incorrect header check|unexpected end of file/i.test(err.message)) throw Errors.badRequest("Arquivo inválido: escolha o .tar.gz baixado em Configurações › Backup");
      throw err;
    });
    const m = manifest as BackupManifest | null;
    if (!m || m.app !== "WhatsAtendende" || m.format !== BACKUP_FORMAT) throw Errors.badRequest("Arquivo inválido: não é um backup do WhatsAtendende");
    const current = await appliedMigrations();
    if (JSON.stringify(current) !== JSON.stringify(m.migrations)) {
      throw Errors.badRequest(
        `Este backup é da versão ${m.version || "anterior"} e este servidor está em outra versão. Instale a mesma versão do backup, restaure, e depois atualize.`
      );
    }
    const names = await tables();
    const missing = m.tables.filter((t) => !names.includes(t));
    if (missing.length) throw Errors.badRequest(`O backup tem tabelas que este servidor não tem: ${missing.join(", ")}`);

    let rows = 0;
    await prisma.$transaction(
      async (tx) => {
        // Foreign keys are checked by the data as a whole (it came from a consistent database), not row by row.
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRawUnsafe(`TRUNCATE ${names.map(quote).join(", ")} CASCADE`);
        for (const table of m.tables) {
          const file = path.join(staging, "database", `${table}.jsonl`);
          if (!fs.existsSync(file)) continue;
          for await (const batch of batches(file, 500)) {
            await tx.$executeRawUnsafe(`INSERT INTO ${quote(table)} SELECT * FROM json_populate_recordset(NULL::${quote(table)}, $1::json)`, `[${batch.join(",")}]`);
            rows += batch.length;
          }
        }
      },
      { timeout: 60 * 60_000, maxWait: 60_000 }
    );

    const folders: [boolean, string, string][] = [
      [m.includes.files, env.UPLOAD_DIR, "files"],
      [m.includes.whatsappSessions, env.WHATSAPP_AUTH_DIR, "whatsapp-sessions"],
    ];
    for (const [included, dir, prefix] of folders) {
      const from = path.join(staging, prefix);
      if (!included || !fs.existsSync(from)) continue;
      fs.mkdirSync(dir, { recursive: true });
      for (const rel of walk(from)) {
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(from, rel), target);
      }
    }
    const at = new Date().toISOString();
    await prisma.systemSetting.upsert({
      where: { key: "backup" },
      create: { key: "backup", value: { at, byName: by.name, kind: "RESTORE" } },
      update: { value: { at, byName: by.name, kind: "RESTORE" } },
    });
    logger.warn({ by: by.name, version: m.version, rows, files }, "backup restored");
    return { manifest: m, rows, files };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Where an uploaded backup waits while it's restored (outside the uploads it's about to replace). */
export function restoreUploadPath() {
  return path.join(os.tmpdir(), `wa-restore-upload-${randomUUID()}.tar.gz`);
}

