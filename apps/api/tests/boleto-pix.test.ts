import { describe, it, expect } from "vitest";
import { DATA_SOURCE_ROLES, DEFAULT_BOLETO_LAYOUT_SETTINGS } from "@whatsatendende/types";
import { examplePixCode, validPixCode } from "../src/modules/boletos/boleto-pix";
import { buildBoletoFromRow } from "../src/modules/boletos/boletos.service";
import { renderBoletosPdf, type BoletoPdfData } from "../src/modules/boletos/boleto-pdf";
import type { ColumnMap, Row } from "../src/modules/data-sources/data-sources.service";

// Every role on the spreadsheet script's column name; fictitious BB convênio 1234567.
const MAP = Object.fromEntries(Object.entries(DATA_SOURCE_ROLES).map(([role, { column }]) => [role, column])) as ColumnMap;
const ROW: Row = {
  vencimento_boleto: "10/12/2030",
  valor_boleto: "90.00",
  forma_pagamento: "Boleto",
  nosso_numero: "12345670000000101",
  banco_codigo: "001",
  convenio: "1234567",
  carteira: "17",
  agencia_beneficiario: "1234-5",
  conta_beneficiario: "99999-9",
};

describe("PIX do boleto", () => {
  it("aceita só um PIX copia e cola válido, conferido pelo CRC", () => {
    const code = examplePixCode(9000);
    expect(validPixCode(code)).toBe(code);
    expect(validPixCode(`  ${code}  `)).toBe(code);
    // One character changed on the way (the value): the CRC no longer checks.
    expect(validPixCode(code.replace("90.00", "99.00"))).toBeNull();
    // A bare PIX key is not a QR Code to print.
    expect(validPixCode("12.345.678/0001-90")).toBeNull();
    expect(validPixCode("")).toBeNull();
    expect(validPixCode(undefined)).toBeNull();
  });

  it("o boleto leva o PIX da fonte — ou nenhum", () => {
    const code = examplePixCode(9000);
    expect(buildBoletoFromRow({ ...ROW, qr_code_boleto: code }, MAP).pix).toBe(code);
    expect(buildBoletoFromRow(ROW, MAP).pix).toBeNull();
    expect(buildBoletoFromRow({ ...ROW, qr_code_boleto: "codigo-cortado" }, MAP).pix).toBeNull();
    // A source synced before the column existed (role unmapped) still finds it by the script's name.
    const { pixCode: _unmapped, ...oldMap } = MAP;
    expect(buildBoletoFromRow({ ...ROW, qr_code_boleto: code }, oldMap).pix).toBe(code);
  });

  it("o PDF sai com e sem o QR Code", async () => {
    const boleto: BoletoPdfData = {
      bankCode: "001",
      linha: "00190.00009 01234.567004 00000.101170 1 00000000009000",
      barcode: "00191000000000090000000001234567000000010117",
      due: "10/12/2030",
      value: "R$ 90,00",
      issued: "01/11/2026",
      ourNumber: "12345670000000101",
      document: "D-1",
      contract: "C-10",
      wallet: "17",
      payeeName: "EMPRESA EXEMPLO LTDA",
      payeeDocument: null,
      agencyAccount: "1234-5/99999-9",
      payerName: "CLIENTE DE EXEMPLO",
      payerDocument: null,
      payerAddress: null,
      payerLocality: null,
      instructions: ["Não receber após 30 dias do vencimento"],
      demonstrative: [],
      pix: null,
    };
    const layout = { model: "CARNE" as const, perPage: 3, settings: DEFAULT_BOLETO_LAYOUT_SETTINGS };
    const withoutPix = await renderBoletosPdf([{ layout, boletos: [boleto] }]);
    const withPix = await renderBoletosPdf([{ layout, boletos: [{ ...boleto, pix: examplePixCode(9000) }] }]);
    expect(withoutPix.subarray(0, 4).toString()).toBe("%PDF");
    expect(withPix.subarray(0, 4).toString()).toBe("%PDF");
    expect(withPix.length).toBeGreaterThan(withoutPix.length);
  });
});
