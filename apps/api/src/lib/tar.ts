import { PassThrough, type Readable, type Writable } from "node:stream";

/**
 * A minimal POSIX tar (ustar) writer and reader — enough for the system backup (Configurações › Backup), which
 * streams the database tables and every uploaded file into one .tar.gz without holding it in memory.
 */

const BLOCK = 512;

// A name that doesn't fit the ustar header travels in an entry of its own right before the file (the GNU "long name"
// extension, type "L", read by every tar program): no file is ever too long to be backed up.
const LONG_NAME_ENTRY = "././@LongLink";

/** Whether a name fits the plain ustar header: 100 bytes, or 100 of name + 155 of folder split on a "/". */
function splitName(name: string): { path: Buffer; prefix: Buffer } | null {
  const whole = Buffer.from(name, "utf8");
  if (whole.length <= 100) return { path: whole, prefix: Buffer.alloc(0) };
  const cut = name.lastIndexOf("/", name.length - 1);
  if (cut <= 0) return null;
  const prefix = Buffer.from(name.slice(0, cut), "utf8");
  const path = Buffer.from(name.slice(cut + 1), "utf8");
  return prefix.length > 155 || path.length > 100 ? null : { path, prefix };
}

function header(name: string, size: number, type = "0", mtime = new Date()): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  // A long name was already written in full by its own entry: here goes what fits, for programs that ignore that entry.
  const { path, prefix } = splitName(name) ?? { path: Buffer.from(name, "utf8").subarray(0, 100), prefix: Buffer.alloc(0) };
  path.copy(buf, 0);
  buf.write("0000644\0", 100, "ascii");
  buf.write("0000000\0", 108, "ascii");
  buf.write("0000000\0", 116, "ascii");
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  buf.write(Math.floor(mtime.getTime() / 1000).toString(8).padStart(11, "0") + "\0", 136, "ascii");
  buf.write("        ", 148, "ascii");
  buf.write(type, 156, "ascii");
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
/**
 * Writes one file into the tar stream: from a buffer, or from a stream announced as `size` bytes. A file that is being
 * written while it is read (a WhatsApp session file, a log) may give more or fewer bytes than announced: the entry
 * still gets exactly `size` — the extra is left out, the missing is filled with zeros — because a backup that stops
 * halfway is worth nothing, and the header has already gone out. Returns false when that happened.
 */
export async function writeTarEntry(out: Writable, name: string, content: Buffer | { size: number; stream: Readable }): Promise<boolean> {
  const size = Buffer.isBuffer(content) ? content.length : content.size;
  if (!splitName(name)) {
    const full = Buffer.from(`${name}\0`, "utf8");
    await write(out, header(LONG_NAME_ENTRY, full.length, "L"));
    await write(out, full);
    await write(out, padding(full.length));
  }
  await write(out, header(name, size));
  let exact = true;
  if (Buffer.isBuffer(content)) {
    await write(out, content);
  } else {
    let written = 0;
    for await (const chunk of content.stream) {
      const piece = (chunk as Buffer).subarray(0, Math.max(0, size - written));
      if (piece.length < (chunk as Buffer).length) exact = false;
      written += piece.length;
      if (piece.length) await write(out, piece);
    }
    if (written < size) {
      exact = false;
      await write(out, Buffer.alloc(size - written, 0));
    }
  }
  await write(out, padding(size));
  return exact;
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
  // The full name of the next file, when it came in a "long name" entry of its own (see writeTarEntry).
  let longName: { remaining: number; pad: number; chunks: Buffer[] } | null = null;
  let pendingName: string | null = null;

  const startEntry = (block: Buffer) => {
    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(block.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(block[156] || 48);
    if (type === "L") {
      longName = { remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, chunks: [] };
      return;
    }
    const fullName = pendingName ?? (prefix ? `${prefix}/${name}` : name);
    pendingName = null;
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
      if (longName) {
        const pending = longName as { remaining: number; pad: number; chunks: Buffer[] };
        if (pending.remaining > 0) {
          if (!buffer.length) break;
          const n = Math.min(pending.remaining, buffer.length);
          pending.chunks.push(buffer.subarray(0, n));
          buffer = buffer.subarray(n);
          pending.remaining -= n;
          continue;
        }
        pendingName = Buffer.concat(pending.chunks).toString("utf8").replace(/\0.*$/s, "");
        skip = pending.pad;
        longName = null;
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
