import { describe, it, expect } from "vitest";
import { decodeText, NotTextError } from "./textDecode";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const utf8 = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

function utf16(text: string, littleEndian: boolean, withBom = true): ArrayBuffer {
  const out: number[] = withBom ? (littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (const unit of text) {
    const code = unit.charCodeAt(0);
    out.push(...(littleEndian ? [code & 0xff, code >> 8] : [code >> 8, code & 0xff]));
  }
  return bytes(...out);
}

describe("decodeText — lê o .txt como o Bloco de Notas", () => {
  it("UTF-8 (o padrão de hoje)", () => {
    expect(decodeText(utf8("Ação ótima — teste ✓"))).toEqual({ text: "Ação ótima — teste ✓", encoding: "utf-8" });
  });

  it("UTF-8 com marca de ordem (BOM): a marca não vira um caractere estranho no começo", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Olá")]).buffer;
    expect(decodeText(withBom)).toEqual({ text: "Olá", encoding: "utf-8" });
  });

  it("UTF-16 (Bloco de Notas antigo, 'Unicode'), pequeno e grande", () => {
    expect(decodeText(utf16("Olá, mundo", true))).toEqual({ text: "Olá, mundo", encoding: "utf-16le" });
    expect(decodeText(utf16("Olá, mundo", false))).toEqual({ text: "Olá, mundo", encoding: "utf-16be" });
  });

  it("ANSI do Windows (windows-1252), que não é UTF-8 válido: acentos, euro e aspas curvas", () => {
    // "Ação € “ok”" in windows-1252
    const ansi = bytes(0x41, 0xe7, 0xe3, 0x6f, 0x20, 0x80, 0x20, 0x93, 0x6f, 0x6b, 0x94);
    expect(decodeText(ansi)).toEqual({ text: "Ação € “ok”", encoding: "windows-1252" });
  });

  it("todo o trecho 0x80–0x9F do ANSI do Windows (€ ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ)", () => {
    const all = Array.from({ length: 32 }, (_, i) => 0x80 + i);
    const text = decodeText(new Uint8Array(all).buffer).text;
    expect(text).toHaveLength(32);
    expect(text.charAt(0)).toBe("€");
    expect(text.charAt(0x13)).toBe("“"); // 0x93
    expect(text.charAt(0x14)).toBe("”"); // 0x94
    expect(text.charAt(0x16)).toBe("–"); // 0x96
    expect(text.charAt(0x19)).toBe("™"); // 0x99
    expect(text.charAt(0x1f)).toBe("Ÿ"); // 0x9F
  });

  it("ANSI longo (mais de um bloco de leitura) sai inteiro", () => {
    const body = Array.from({ length: 20000 }, (_, i) => (i % 2 ? 0xe9 : 0x61)); // "aéaé..."
    const text = decodeText(new Uint8Array(body).buffer).text;
    expect(text).toHaveLength(20000);
    expect(text.startsWith("aéaé")).toBe(true);
    expect(text.endsWith("aé")).toBe(true);
  });

  it("não confunde um UTF-8 válido com ANSI", () => {
    // "é" in UTF-8 is C3 A9 — read as windows-1252 it would be "Ã©".
    expect(decodeText(bytes(0xc3, 0xa9)).text).toBe("é");
  });

  it("junta as quebras de linha do Windows (CRLF) e do Mac antigo (CR) em uma só forma", () => {
    expect(decodeText(utf8("a\r\nb\rc\nd")).text).toBe("a\nb\nc\nd");
  });

  it("arquivo vazio", () => {
    expect(decodeText(new ArrayBuffer(0))).toEqual({ text: "", encoding: "utf-8" });
  });

  it("um arquivo que não é texto (figura com nome .txt) é recusado, não mostrado como lixo", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52);
    expect(() => decodeText(png)).toThrow(NotTextError);
  });
});
