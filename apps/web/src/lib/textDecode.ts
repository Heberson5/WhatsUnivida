/**
 * Turns the bytes of a .txt into text the way Bloco de Notas would read it. Files
 * written on Windows come in more than one encoding and the file itself doesn't say
 * which — so: a byte-order mark wins (UTF-8 / UTF-16), else valid UTF-8 is UTF-8, and
 * anything else is the old Windows "ANSI" page (windows-1252), which is what Bloco de
 * Notas saved before UTF-8 became its default.
 */

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

/** Thrown for a file that is not text at all (a picture or a program renamed to .txt). */
export class NotTextError extends Error {
  constructor() {
    super("O arquivo não é um texto");
    this.name = "NotTextError";
  }
}

function startsWith(bytes: Uint8Array, ...prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

// windows-1252 is ISO-8859-1 except for 0x80–0x9F, where it has the euro sign, curly quotes, dashes... (0x81, 0x8D, 0x8F,
// 0x90 and 0x9D stay as the control characters of the same number). Done by hand because not every runtime's
// TextDecoder("windows-1252") gets that range right — some read it as plain ISO-8859-1.
const WINDOWS_1252_C1 = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

function decodeWindows1252(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const CHUNK = 8192; // String.fromCharCode takes its arguments on the stack
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const codes = Array.from(bytes.subarray(start, start + CHUNK), (byte) => (byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_C1.charCodeAt(byte - 0x80) : byte));
    chunks.push(String.fromCharCode(...codes));
  }
  return chunks.join("");
}

function decodeWith(encoding: Exclude<TextEncodingName, "windows-1252">, bytes: Uint8Array, fatal = false): string {
  return new TextDecoder(encoding, { fatal }).decode(bytes);
}

export function decodeText(buffer: ArrayBuffer): DecodedText {
  const bytes = new Uint8Array(buffer);
  let decoded: DecodedText;

  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) {
    decoded = { text: decodeWith("utf-8", bytes.subarray(3)), encoding: "utf-8" };
  } else if (startsWith(bytes, 0xff, 0xfe)) {
    decoded = { text: decodeWith("utf-16le", bytes.subarray(2)), encoding: "utf-16le" };
  } else if (startsWith(bytes, 0xfe, 0xff)) {
    decoded = { text: decodeWith("utf-16be", bytes.subarray(2)), encoding: "utf-16be" };
  } else {
    try {
      decoded = { text: decodeWith("utf-8", bytes, true), encoding: "utf-8" };
    } catch {
      decoded = { text: decodeWindows1252(bytes), encoding: "windows-1252" };
    }
  }

  // A real text has no NUL characters; a file that does is binary (or UTF-16 with no mark, which can't be told apart safely).
  if (decoded.text.includes("\u0000")) throw new NotTextError();
  return { ...decoded, text: decoded.text.replace(/\r\n?/g, "\n") };
}
