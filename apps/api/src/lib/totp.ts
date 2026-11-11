import crypto from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238, the kind every authenticator app reads: SHA-1, 6 digits, 30 seconds) —
 * written here over node:crypto so the second step of the login depends on no outside package.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[\s=-]/g, "")) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("segredo inválido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 random bits, as the RFC recommends for SHA-1. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export const totpStepAt = (now: Date) => Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

export function totpCodeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * The step this code belongs to — now, or one step to either side (a phone's clock a few seconds off, a code typed as
 * it was changing) — or null when it matches none. Compared in constant time.
 */
export function matchTotpStep(secret: string, code: string, now = new Date()): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStepAt(now);
  for (const step of [current, current - 1, current + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpCodeForStep(secret, step)), Buffer.from(digits))) return step;
  }
  return null;
}

/** What the authenticator app reads from the QR Code. */
export function totpAuthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
