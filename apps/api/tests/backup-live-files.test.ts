import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { finishTar, readTar, writeTarEntry } from "../src/lib/tar";

// See PROMPT: "o Backup para poder levar os dados e conexão para o outro sistema, não está baixando" — the backup
// runs with the system in use: a WhatsApp session file changes or disappears while it is being read, and a file may
// have a name too long for the plain tar header. None of that may stop the download halfway.

async function archive(write: (out: PassThrough) => Promise<void>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  await write(out);
  await finishTar(out);
  out.end();
  return Buffer.concat(chunks);
}

async function entriesOf(tar: Buffer): Promise<Record<string, Buffer>> {
  const found: Record<string, Buffer> = {};
  await readTar(Readable.from([tar]), async (entry) => {
    const parts: Buffer[] = [];
    for await (const c of entry.stream) parts.push(c as Buffer);
    found[entry.name] = Buffer.concat(parts);
  });
  return found;
}

describe("backup com o sistema em uso", () => {
  const LONG = `whatsapp-sessions/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90/${"sender-key-120363041234567890@g.us--".repeat(4)}5565999286623--0.json`;
  const ACCENTS = `files/release-notes/${"Manutenção programada da conexão — relatório de ocorrências ".repeat(3)}.pdf`;

  it("nome longo demais para o cabeçalho comum vai e volta inteiro, e arquivos normais continuam iguais", async () => {
    expect(Buffer.byteLength(path.basename(LONG))).toBeGreaterThan(100);
    const tar = await archive(async (out) => {
      await writeTarEntry(out, "manifest.json", Buffer.from("{}"));
      await writeTarEntry(out, LONG, Buffer.from("sessao"));
      await writeTarEntry(out, ACCENTS, Buffer.from("pdf"));
      await writeTarEntry(out, "database/User.jsonl", Buffer.from("linha\n"));
    });
    const entries = await entriesOf(tar);
    expect(Object.keys(entries)).toEqual(["manifest.json", LONG, ACCENTS, "database/User.jsonl"]);
    expect(entries[LONG].toString()).toBe("sessao");
    expect(entries[ACCENTS].toString()).toBe("pdf");
  });

  it("o arquivo gerado é lido pelo tar do sistema, com os nomes longos", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-tar-"));
    try {
      const file = path.join(dir, "b.tar.gz");
      const gzip = createGzip();
      const done = new Promise<void>((resolve, reject) => gzip.pipe(fs.createWriteStream(file)).on("finish", () => resolve()).on("error", reject));
      await writeTarEntry(gzip, "manifest.json", Buffer.from("{}"));
      await writeTarEntry(gzip, LONG, Buffer.from("sessao"));
      await finishTar(gzip);
      gzip.end();
      await done;
      const listed = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");
      expect(listed).toEqual(["manifest.json", LONG]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo que encolhe, cresce ou some durante a leitura não interrompe o backup: o que vem depois continua íntegro", async () => {
    const failing = Readable.from(
      (async function* () {
        yield Buffer.from("come");
        throw new Error("ENOENT: sumiu");
      })()
    );
    const swallow = Readable.from(
      (async function* () {
        try {
          for await (const c of failing) yield c as Buffer;
        } catch {
          // gone halfway
        }
      })()
    );
    let results: boolean[] = [];
    const tar = await archive(async (out) => {
      results = [
        await writeTarEntry(out, "sessions/encolheu.json", { size: 10, stream: Readable.from([Buffer.from("abc")]) }),
        await writeTarEntry(out, "sessions/cresceu.json", { size: 4, stream: Readable.from([Buffer.from("abcdefgh"), Buffer.from("ijkl")]) }),
        await writeTarEntry(out, "sessions/sumiu.json", { size: 8, stream: swallow }),
        await writeTarEntry(out, "sessions/exato.json", { size: 3, stream: Readable.from([Buffer.from("xyz")]) }),
        await writeTarEntry(out, "database/Depois.jsonl", Buffer.from("intacto")),
      ];
    });
    expect(results).toEqual([false, false, false, true, true]);
    const entries = await entriesOf(tar);
    expect(entries["sessions/encolheu.json"]).toEqual(Buffer.concat([Buffer.from("abc"), Buffer.alloc(7)]));
    expect(entries["sessions/cresceu.json"].toString()).toBe("abcd");
    expect(entries["sessions/sumiu.json"]).toEqual(Buffer.concat([Buffer.from("come"), Buffer.alloc(4)]));
    expect(entries["sessions/exato.json"].toString()).toBe("xyz");
    expect(entries["database/Depois.jsonl"].toString()).toBe("intacto");
  });
});
