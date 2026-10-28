import { describe, it, expect } from "vitest";
import { barcodeFromLinha, buildBarcode, dueFactor, freeFieldBB, linhaFromBarcode, mod10, mod11Barcode } from "../src/modules/boletos/boleto-code";

describe("código de barras e linha digitável", () => {
  it("dígitos verificadores", () => {
    expect(mod10("001900000")).toBe(9);
    expect(mod11Barcode("0019373700000001000500940144816060680935031")).toBe(3);
  });

  it("fator de vencimento, inclusive depois do reinício de 22/02/2025", () => {
    expect(dueFactor(new Date(2000, 6, 3))).toBe("1000");
    expect(dueFactor(new Date(2025, 1, 21))).toBe("9999");
    expect(dueFactor(new Date(2025, 1, 22))).toBe("1000");
    expect(dueFactor(new Date(2026, 9, 19))).toBe(String(1000 + 604));
  });

  it("monta a linha do BB e a linha passa na conferência dos dígitos", () => {
    const free = freeFieldBB("1234567", "12345670000000123", "17");
    expect(free).toBe("0000001234567000000012317");
    const barcode = buildBarcode("001", new Date(2026, 10, 10), 8990, free);
    expect(barcode).toHaveLength(44);
    const linha = linhaFromBarcode(barcode);
    expect(linha).toMatch(/^\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14}$/);
    expect(barcodeFromLinha(linha)).toBe(barcode);
    const tampered = linha.replace(/\d(?=\s\d{14}$)/, (d) => String((Number(d) + 1) % 10));
    expect(barcodeFromLinha(tampered)).toBeNull();
  });

  it("recusa convênio fora do padrão", () => {
    expect(() => freeFieldBB("12345", "1", "17")).toThrow();
  });
});

describe("nosso número como o boleto imprime", () => {
  it("aceita convênio + nosso número com o dígito depois do traço", () => {
    expect(freeFieldBB("1234567", "12345670000000123-4", "17")).toBe(freeFieldBB("1234567", "0000000123", "17"));
  });
});
