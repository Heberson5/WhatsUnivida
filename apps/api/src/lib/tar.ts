import { PassThrough, type Readable, type Writable } from "node:stream";

/**
 * A minimal POSIX tar (ustar) writer and reader — enough for the system backup (Configurações › Backup), which
 * streams the database tables and every uploaded file into one .tar.gz without holding it in memory.
 */

const BLOCK = 512;

function header(name: string, size: number, mtime = new Date()): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  let path = Buffer.from(name, "utf8");
  let prefix = Buffer.alloc(0);
  // ustar: up to 100 bytes of name plus 155 of prefix (split on a "/").
  if (path.length > 100) {
    const cut = name.lastIndexOf("/", name.length - 1);
    const candidatePrefix = Buffer.from(name.slice(0, cut), "utf8");
    const candidateName = Buffer.from(name.slice(cut + 1), "utf8");
    if (cut <= 0 || candidatePrefix.length > 155 || candidateName.length > 100) throw new Error(`Caminho longo demais para o backup: ${name}`);
    prefix = candidatePrefix;
    path = candidateName;
  }
  path.copy(buf, 0);
  buf.write("0000644\0", 100, "ascii");
  buf.write("0000000\0", 108, "ascii");
  buf.write("0000000\0", 116, "ascii");
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  buf.write(Math.floor(mtime.getTime() / 1000).toString(8).padStart(11, "0") + "\0", 136, "ascii");
  buf.write("        ", 148, "ascii");
  buf.write("0", 156, "ascii");
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");
  prefix.copy(buf, 345);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buf;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);

function write(out: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.write(chunk)) return resolve();
    const onDrain = () => {
      out.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      out.off("drain", onDrain);
      reject(err);
    };
    out.once("drain", onDrain);
    out.once("error", onError);
  });
}

/** Writes one file into the tar stream: from a buffer, or from a stream of exactly `size` bytes. */
export async function writeTarEntry(out: Writable, name: string, content: Buffer | { size: number; stream: Readable }): Promise<void> {
  const size = Buffer.isBuffer(content) ? content.length : content.size;
  await write(out, header(name, size));
  if (Buffer.isBuffer(content)) {
    await write(out, content);
  } else {
    let written = 0;
    for await (const chunk of content.stream) {
      written += (chunk as Buffer).length;
      await write(out, chunk as Buffer);
    }
    if (written !== size) throw new Error(`O arquivo ${name} mudou de tamanho durante o backup`);
  }
  await write(out, padding(size));
}

/** The two empty blocks that close a tar archive. */
export function finishTar(out: Writable): Promise<void> {
  return write(out, Buffer.alloc(BLOCK * 2, 0));
}

export interface TarEntry {
  name: string;
  size: number;
  /** The entry's bytes — must be fully consumed (or drained) before the next entry arrives. */
  stream: Readable;
}

/** Reads a tar stream entry by entry, calling `onEntry` for each regular file (awaited before moving on). */
export async function readTar(input: Readable, onEntry: (entry: TarEntry) => Promise<void>): Promise<void> {
  let buffer = Buffer.alloc(0);
  let current: { name: string; remaining: number; pad: number; stream: PassThrough; done: Promise<void> } | null = null;
  let skip = 0;

  const startEntry = (block: Buffer) => {
    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(block.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(block[156] || 48);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (type !== "0" && type !== "\0") {
      skip = size + ((BLOCK - (size % BLOCK)) % BLOCK);
      return;
    }
    const stream = new PassThrough();
    current = { name: fullName, remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, stream, done: onEntry({ name: fullName, size, stream }) };
    if (size === 0) stream.end();
  };

  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    for (;;) {
      if (skip > 0) {
        const n = Math.min(skip, buffer.length);
        buffer = buffer.subarray(n);
        skip -= n;
        if (skip > 0) break;
        continue;
      }
      if (current) {
        const entry = current as { name: string; remaining: number; pad: number; stream: PassThrough; done: Promise<void> };
        if (entry.remaining > 0) {
          if (!buffer.length) break;
          const n = Math.min(entry.remaining, buffer.length);
          const piece = buffer.subarray(0, n);
          buffer = buffer.subarray(n);
          entry.remaining -= n;
          if (!entry.stream.write(piece)) await new Promise((resolve) => entry.stream.once("drain", resolve));
          if (entry.remaining === 0) entry.stream.end();
          continue;
        }
        await entry.done;
        skip = entry.pad;
        current = null;
        continue;
      }
      if (buffer.length < BLOCK) break;
      const block = buffer.subarray(0, BLOCK);
      buffer = buffer.subarray(BLOCK);
      if (block.every((b) => b === 0)) continue;
      startEntry(block);
    }
  }
  if (current) {
    const entry = current as { remaining: number; done: Promise<void>; name: string };
    if (entry.remaining > 0) throw new Error(`Backup incompleto: o arquivo ${entry.name} terminou antes do fim`);
    await entry.done;
  }
}
