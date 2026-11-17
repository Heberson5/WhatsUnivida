import crypto from "node:crypto";
import fs from "node:fs";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { createGunzip } from "node:zlib";

/**
 * Backups are protected by a password: AES-256-GCM, with the key derived from the password (scrypt) and a random salt.
 *
 *   "WABK" | version (1 byte) | salt (16) | iv (12) | ciphertext… | auth tag (16)
 *
 * The tag at the very end proves the password is right and nothing was changed — so a file is always read from disk
 * (where its end is known), never straight from the network.
 */

const MAGIC = Buffer.from("WABK");
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;
export const BACKUP_PASSWORD_MIN = 8;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Encrypts whatever flows through it: header first, the tag after the last byte. */
export function encryptingStream(password: string): Transform {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  let headerSent = false;
  const header = () => {
    if (headerSent) return null;
    headerSent = true;
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      const head = header();
      if (head) this.push(head);
      done(null, cipher.update(chunk));
    },
    flush(done: TransformCallback) {
      const head = header();
      if (head) this.push(head);
      this.push(cipher.final());
      done(null, cipher.getAuthTag());
    },
  });
}

export class BackupPasswordError extends Error {
  constructor() {
    super("Senha incorreta, ou o arquivo não é um backup deste sistema / está corrompido");
  }
}

/** True when the file starts like a password-protected backup. */
export function isEncryptedBackup(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** The plain content of an encrypted backup file. A wrong password (or a changed file) fails at the end of the stream. */
export function decryptingStream(file: string, password: string): Readable {
  const size = fs.statSync(file).size;
  if (size < HEADER_BYTES + TAG_BYTES || !isEncryptedBackup(file)) throw new BackupPasswordError();
  const fd = fs.openSync(file, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    fs.readSync(fd, header, 0, HEADER_BYTES, 0);
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  if (header[MAGIC.length] !== VERSION) throw new BackupPasswordError();
  const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + 1 + SALT_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const body = fs.createReadStream(file, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 });
  body.on("error", (err) => decipher.destroy(err));
  return body.pipe(decipher);
}

/**
 * The backup's tar stream: decrypted and unzipped, with any failure along the way (wrong password, changed file,
 * cut-off gzip) reaching whoever reads it — never left as an "error" event nobody listens to, which would bring the
 * whole API down.
 */
export function openBackup(file: string, password: string): Readable {
  const plain = decryptingStream(file, password);
  const gunzip = createGunzip();
  plain.on("error", (err) => gunzip.destroy(err));
  return plain.pipe(gunzip);
}
