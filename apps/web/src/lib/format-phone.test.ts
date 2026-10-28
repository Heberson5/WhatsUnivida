import { describe, it, expect } from "vitest";
import { formatPhone, formatPhoneAsKnown } from "./format-phone";

describe("número para exibição", () => {
  it("um celular que o WhatsApp guarda sem o 9 aparece em Contatos com o 9; o número exato continua disponível", () => {
    expect(formatPhoneAsKnown("556599990000")).toBe("+55 65 99999-0000");
    expect(formatPhone("556599990000")).toBe("+55 65 9999-0000");
  });

  it("não mexe em quem já tem o 9, em fixo nem em número de fora", () => {
    expect(formatPhoneAsKnown("5511987654321")).toBe("+55 11 98765-4321");
    expect(formatPhoneAsKnown("556532221100")).toBe("+55 65 3222-1100");
    expect(formatPhoneAsKnown("14155552671")).toBe("+14155552671");
  });
});
