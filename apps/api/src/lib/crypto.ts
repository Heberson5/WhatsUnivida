import crypto from "node:crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTED_PREFIX = "enc:v1:";

// SETTINGS_ENCRYPTION_KEY is an arbitrary-length secret (same convention as
// the JWT secrets) — sha256 it down to exactly the 32 bytes aes-256-gcm
// requires, rather than asking the operator to produce a key of the exact
// byte length themselves.
const key = crypto.createHash("sha256").update(env.SETTINGS_ENCRYPTION_KEY).digest();

/**
 * At-rest encryption for secrets that live in SystemSetting.value (a plain
 * JSON blob) — currently just the SMTP password (see settings.service.ts).
 * Without this, anyone with read access to the database (a backup, a
 * restored snapshot, another compromised service sharing the DB) gets the
 * mail server's real credentials in plain text. IV is random per call and
 * stored alongside the ciphertext (safe to do — it's not the secret), and
 * GCM's auth tag detects any tampering with the stored value.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ENCRYPTED_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypts a value produced by encryptSecret. Anything without the
 * ENCRYPTED_PREFIX is treated as legacy plaintext (a value saved before
 * this encryption existed) and returned as-is — see
 * settings.service.ts's updateEmailSettings, which re-encrypts it the next
 * time it's saved. This keeps an existing production deployment's stored
 * SMTP password working across the upgrade with no manual migration step.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  const raw = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
