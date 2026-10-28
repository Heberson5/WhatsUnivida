import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parseSpreadsheet } from "../src/modules/data-sources/data-source-fetch";

/** Two tabs: "Clientes" (first) and "Outra". ExcelJS writes the sheets before xl/workbook.xml inside the zip. */
async function twoTabs(options?: { useSharedStrings?: boolean }) {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("Clientes");
  first.addRow(["telefone_whatsapp", "nome_cliente", "vencimento_parcela"]);
  first.addRow(["5565999990000", "Maria", new Date(Date.UTC(2026, 10, 10))]);
  workbook.addWorksheet("Outra").addRow(["coluna_da_outra_aba"]);
  return Buffer.from(await workbook.xlsx.writeBuffer(options));
}

/** The same file with its parts rewritten in another order inside the zip. */
async function reordered(buffer: Buffer, order: (names: string[]) => string[]) {
  const zip = await JSZip.loadAsync(buffer);
  const out = new JSZip();
  for (const name of order(Object.keys(zip.files).filter((n) => !zip.files[n].dir))) out.file(name, await zip.file(name)!.async("nodebuffer"));
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const expectFirstTab = (table: Awaited<ReturnType<typeof parseSpreadsheet>>) =>
  expect(table.rows).toEqual([{ telefone_whatsapp: "5565999990000", nome_cliente: "Maria", vencimento_parcela: "10/11/2026" }]);

describe("leitura de XLSX (Fontes de dados)", () => {
  it("abas antes do workbook.xml dentro do arquivo: lê sempre, sem o erro de 'sheets' (antes falhava em 28 de 30)", async () => {
    const buffer = await twoTabs();
    for (let i = 0; i < 20; i++) expectFirstTab(await parseSpreadsheet(buffer, null));
  });

  it("na ordem do Excel (workbook.xml primeiro) também lê", async () => {
    const buffer = await reordered(await twoTabs(), (names) => [...names.filter((n) => !n.includes("worksheets/")), ...names.filter((n) => n.includes("worksheets/"))]);
    expectFirstTab(await parseSpreadsheet(buffer, null));
  });

  it("lê a primeira aba da pasta de trabalho, mesmo quando outra aba vem antes dentro do arquivo", async () => {
    // The tab order lives in workbook.xml: make "Outra" (sheet2.xml) the first tab, and put sheet2.xml first in the zip.
    const zip = await JSZip.loadAsync(await twoTabs());
    const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
    const tags = workbookXml.match(/<sheet\s[^>]*\/>/g)!;
    zip.file("xl/workbook.xml", workbookXml.replace(tags[0] + tags[1], tags[1] + tags[0]));
    const swapped = await reordered(await zip.generateAsync({ type: "nodebuffer" }), (names) => [...names.filter((n) => n.endsWith("sheet2.xml")), ...names.filter((n) => !n.endsWith("sheet2.xml"))]);
    const table = await parseSpreadsheet(swapped, null);
    expect(table.columns).toEqual(["coluna_da_outra_aba"]);
  });

  it("planilha sem textos compartilhados (texto direto na célula) também lê", async () => {
    expectFirstTab(await parseSpreadsheet(await twoTabs({ useSharedStrings: false }), null));
  });

  it("XLSX sem o workbook.xml: avisa que o arquivo está incompleto", async () => {
    const zip = await JSZip.loadAsync(await twoTabs());
    zip.remove("xl/workbook.xml");
    await expect(parseSpreadsheet(await zip.generateAsync({ type: "nodebuffer" }), null)).rejects.toThrow(/incompleto ou corrompido/);
  });
});
