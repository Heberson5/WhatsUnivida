import { describe, it, expect } from "vitest";
import { buildBarcode, linhaFromBarcode } from "../src/modules/boletos/boleto-code";
import { BOLETO_BANK_RULES, bradescoOurNumberDigit, caixaDigit, itauOurNumberDac, sicrediFreeFieldDigit, sicrediOurNumberDigit } from "../src/modules/boletos/boleto-banks";

const empty = { agreement: "", ourNumber: "", wallet: "", agency: "", account: "", post: "" };
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe("Boletos: regras de cada banco, conferidas com os exemplos dos manuais oficiais", () => {
  it("Sicredi: exemplos do manual (DV do nosso número e do campo livre)", () => {
    // Manual CNAB 400, 10.7.2: soma 241 → DV 1.
    expect(sicrediFreeFieldDigit("310720000310165020062310")).toBe(1);
    // The nosso número DV of the real boletos (00/554364-1 and 00/554365-0) — cooperativa 0804, posto 22, beneficiário 00017.
    expect(sicrediOurNumberDigit("0804", "22", "00017", "00554364")).toBe(1);
    expect(sicrediOurNumberDigit("0804", "22", "00017", "00554365")).toBe(0);
  });

  it("Sicredi: boleto real da Univida (parcelas 07 e 08/2022) — linha digitável idêntica", () => {
    const fields = { ...empty, agreement: "00017", agency: "0804-4", post: "22" };
    const p7 = BOLETO_BANK_RULES["748"].build({ ...fields, ourNumber: "0000554364" });
    expect(p7.freeField).toBe("1100554364108042200017103");
    expect(p7.ourNumberPrinted).toBe("00/554364-1");
    expect(p7.agencyCodePrinted).toBe("0804.22.00017");
    expect(linhaFromBarcode(buildBarcode("748", local(2022, 7, 28), 10086, p7.freeField))).toBe("74891.10051 54364.108040 22000.171037 9 90600000010086");

    const p8 = BOLETO_BANK_RULES["748"].build({ ...fields, ourNumber: "005543650" });
    expect(linhaFromBarcode(buildBarcode("748", local(2022, 8, 29), 10086, p8.freeField))).toBe("74891.10051 54365.008041 22000.171029 4 90920000010086");
    // A nosso número with the wrong check digit is refused.
    expect(() => BOLETO_BANK_RULES["748"].build({ ...fields, ourNumber: "005543659" })).toThrow(/não confere/);
  });

  it("Bradesco: dígito de autoconferência — os três exemplos do manual (8, P e 0)", () => {
    expect(bradescoOurNumberDigit("19", "00000000002")).toBe("8");
    expect(bradescoOurNumberDigit("19", "00000000001")).toBe("P");
    expect(bradescoOurNumberDigit("19", "00000000006")).toBe("0");
    const parts = BOLETO_BANK_RULES["237"].build({ ...empty, agency: "1234-5", wallet: "09", ourNumber: "12345678901", account: "0012345-6" });
    expect(parts.freeField).toBe("1234091234567890100123450");
    expect(parts.freeField).toHaveLength(25);
  });

  it("Itaú: exemplos do manual — DAC do nosso número, DAC de agência/conta e a linha digitável inteira", () => {
    expect(itauOurNumberDac("0057", "72192", "198", "98712345")).toBe(1);
    const parts = BOLETO_BANK_RULES["341"].build({ ...empty, wallet: "110", ourNumber: "12345678", agency: "0057", account: "12345-7" });
    expect(parts.freeField).toBe("1101234567880057123457000");
    expect(parts.ourNumberPrinted).toBe("110/12345678-8");
    const barcode = buildBarcode("341", local(2002, 5, 1), 12345, parts.freeField);
    expect(barcode).toBe("34196166700000123451101234567880057123457000");
    expect(linhaFromBarcode(barcode)).toBe("34191.10121 34567.880058 71234.570001 6 16670000012345");
    expect(() => BOLETO_BANK_RULES["341"].build({ ...empty, wallet: "198", ourNumber: "1", agency: "1", account: "1" })).toThrow(/outro leiaute/);
  });

  it("Caixa (SIGCB): exemplos do manual — DV do beneficiário 7, do nosso número 7, do campo livre 1 e DV geral 4", () => {
    expect(caixaDigit("005507")).toBe(7);
    expect(caixaDigit("14000000000000019")).toBe(7);
    const parts = BOLETO_BANK_RULES["104"].build({ ...empty, agreement: "005507", ourNumber: "14222333777777777", agency: "1234" });
    expect(parts.freeField).toBe("0055077222133347777777771");
    const barcode = buildBarcode("104", local(2006, 8, 23), 32112, parts.freeField);
    expect(barcode[4]).toBe("4");
    expect(parts.walletPrinted).toBe("RG");
  });
});
