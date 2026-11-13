import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import ExcelJS from "exceljs";
import { SAUBERLICH_CREDIT, sauberlichCopyright } from "@whatsatendende/types";
import { toPdf, toXlsx } from "../src/modules/reports/reports.service";
import { renderCustomEmailHtml, renderEmailTemplateHtml } from "../src/modules/settings/settings.service";

/** The text drawn on each page of a PDF made by pdfkit (standard fonts write it as hex in deflated content streams). */
function pdfPagesText(pdf: Buffer): string[] {
  const raw = pdf.toString("latin1");
  const pages: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    if (!/\bBT\b/.test(content)) continue;
    pages.push([...content.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join(""));
  }
  return pages;
}

describe("marca Sauberlich System", () => {
  it("o texto da marca e o direito autoral do login", () => {
    expect(SAUBERLICH_CREDIT).toBe("Desenvolvido por Sauberlich System");
    expect(sauberlichCopyright(2026)).toBe("© 2026 Sauberlich System · Todos os direitos reservados");
  });

  it("todo e-mail do sistema leva a marca no rodapé, embaixo do nome da empresa", () => {
    expect(renderEmailTemplateHtml("PASSWORD_RESET", { title: "Redefinir senha", bodyText: "Olá", buttonText: "Redefinir" })).toContain(SAUBERLICH_CREDIT);
    expect(renderCustomEmailHtml("Aviso", "Texto")).toContain(SAUBERLICH_CREDIT);
  });

  it("o PDF do relatório leva a marca em todas as páginas", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ Atendente: `Pessoa ${i}`, Conversas: i, Encerradas: i }));
    const pages = pdfPagesText(await toPdf(rows, "Relatório"));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page).toContain(SAUBERLICH_CREDIT);
    const empty = pdfPagesText(await toPdf([], "Relatório"));
    expect(empty[0]).toContain(SAUBERLICH_CREDIT);
  });

  it("a planilha exportada leva a marca no rodapé da impressão", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await toXlsx([{ A: 1 }], "Relatório"));
    expect(workbook.worksheets[0].headerFooter.oddFooter).toContain(SAUBERLICH_CREDIT);
  });
});
