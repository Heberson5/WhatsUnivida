import PDFDocument from "pdfkit";
import { BOLETO_BANKS, type BoletoLayoutModel, type BoletoLayoutSettings } from "@whatsatendende/types";
import { BANK_LOGOS } from "./bank-logos";
import { BOLETO_BANK_RULES } from "./boleto-banks";

export interface BoletoPdfData {
  /** "001" — picks the logo, printed beside it. */
  bankCode: string;
  linha: string;
  barcode: string;
  due: string;
  value: string;
  /** The day the PDF is made — Data do documento / Data de processamento, when the layout prints them. */
  issued: string;
  ourNumber: string;
  document: string | null;
  contract: string;
  wallet: string;
  payeeName: string;
  payeeDocument: string | null;
  agencyAccount: string;
  payerName: string;
  payerDocument: string | null;
  payerAddress: string | null;
  /** CEP and city, the last line of the sacado. */
  payerLocality: string | null;
  /** The layout's instruction box, already filled in for this boleto. */
  instructions: string[];
  /** The DEMONSTRATIVO model's top box, already filled in. */
  demonstrative: string[];
}

export interface BoletoPdfLayout {
  model: BoletoLayoutModel;
  perPage: number;
  settings: BoletoLayoutSettings;
}

// Interleaved 2 of 5: each digit as 5 elements, 1 = wide. Narrow = 0.254 mm (FEBRABAN), the barcode ≈ 103 mm.
const I25 = ["00110", "10001", "01001", "11000", "00101", "10100", "01100", "00011", "10010", "01010"];
const NARROW = 0.72;
const WIDE = NARROW * 3;

// A4 in points. Carnê and ficha: up to three boletos per page, one under the other, each cut along a dashed line.
const PAGE_MARGIN = 18;
const PAGE_WIDTH = 559;
const SLOT_HEIGHT = 268;
const STUB_WIDTH = 100;
const STUB_GAP = 8;
const SIDE_SHARE = 0.248; // the slip's right column: vencimento, valores
const ROW = 18;
const SIDE_ROW = 17;
const RECEIPT_HEIGHT = 89;
const DEMONSTRATIVE_HEIGHT = 200;

const LINE = "#4a6a9a";
const LABEL = "#333";
const HIGHLIGHT = "#fbf3a6";

function drawBarcode(doc: PDFKit.PDFDocument, code: string, x: number, y: number, height: number) {
  let cursor = x;
  const bar = (wide: boolean, black: boolean) => {
    const w = wide ? WIDE : NARROW;
    if (black) doc.rect(cursor, y, w, height).fill("#000");
    cursor += w;
  };
  [false, false, false, false].forEach((w, i) => bar(w, i % 2 === 0)); // start: narrow bar/space x2
  for (let i = 0; i < code.length; i += 2) {
    const bars = I25[Number(code[i])];
    const spaces = I25[Number(code[i + 1])];
    for (let j = 0; j < 5; j++) {
      bar(bars[j] === "1", true);
      bar(spaces[j] === "1", false);
    }
  }
  bar(true, true); // stop: wide bar, narrow space, narrow bar
  bar(false, false);
  bar(false, true);
}

function text(
  doc: PDFKit.PDFDocument,
  value: string,
  x: number,
  y: number,
  width: number,
  size: number,
  options: { bold?: boolean; align?: "left" | "right"; color?: string } = {}
) {
  doc
    .fillColor(options.color ?? "#000")
    .font(options.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(size)
    // One line, cut with "…": the height is what keeps a long name from wrapping over the next field.
    .text(value, x, y, { width, height: size * 1.2, align: options.align ?? "left", ellipsis: true });
}

interface CellOptions {
  bold?: boolean;
  /** Up to two lines when it doesn't fit in one. */
  wrap?: boolean;
  align?: "left" | "right";
  highlight?: boolean;
  /** Slip cells are boxed; stub cells only have a line under them. */
  boxed?: boolean;
}

function cell(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, label: string, value: string, options: CellOptions = {}) {
  if (options.highlight) doc.rect(x, y, w, h).fill(HIGHLIGHT);
  doc.lineWidth(0.6).strokeColor(LINE);
  if (options.boxed) doc.rect(x, y, w, h).stroke();
  else doc.moveTo(x, y + h).lineTo(x + w, y + h).stroke();
  text(doc, label, x + 2, y + 1.5, w - 4, 5, { color: LABEL });
  if (!value) return;
  // A text too long for one line (Itaú's payment place) goes on two smaller ones.
  doc.font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(6.5);
  if (options.wrap && doc.widthOfString(value) > w - 6) {
    doc
      .fillColor("#000")
      .fontSize(5)
      .text(value, x + 3, y + 7, { width: w - 6, height: 12, lineGap: -1 });
    return;
  }
  text(doc, value, x + 3, y + h - 8.5, w - 6, 6.5, { bold: options.bold, align: options.align });
}

/** A row of boxed cells sharing `width` by their shares. */
function cellRow(doc: PDFKit.PDFDocument, x: number, y: number, width: number, cells: [string, string, number, CellOptions?][]) {
  let cx = x;
  for (const [label, value, share, options] of cells) {
    cell(doc, cx, y, width * share, ROW, label, value, { boxed: true, ...options });
    cx += width * share;
  }
}

function bankHeader(doc: PDFKit.PDFDocument, data: BoletoPdfData, settings: BoletoLayoutSettings, x: number, y: number) {
  if (settings.showLogo) doc.image(BANK_LOGOS[data.bankCode], x, y + 3.5, { width: 71, height: 8.6 });
  else text(doc, BOLETO_BANKS[data.bankCode].toUpperCase(), x, y + 5, 71, 7, { bold: true });
  doc.lineWidth(1).strokeColor(LINE).moveTo(x + 75, y + 1).lineTo(x + 75, y + 16).stroke();
  // The code with its check digit, as each bank prints it ("748-X", "341-7"...).
  text(doc, BOLETO_BANK_RULES[data.bankCode]?.codeWithDigit ?? data.bankCode, x + 78, y + 4, 40, 9, { bold: true, color: "#666" });
}

const documentDate = (data: BoletoPdfData, settings: BoletoLayoutSettings) => (settings.documentDate === "PRINT" ? data.issued : "");
const processDate = (data: BoletoPdfData, settings: BoletoLayoutSettings) => (settings.processDate === "PRINT" ? data.issued : "");
const payeeLine = (data: BoletoPdfData, settings: BoletoLayoutSettings) =>
  `${data.payeeName}${settings.showPayeeDocument && data.payeeDocument ? ` — ${data.payeeDocument}` : ""}`;

/** Recibo do sacado: the narrow stub on the left of the carnê, kept by the client. */
function drawStub(doc: PDFKit.PDFDocument, data: BoletoPdfData, settings: BoletoLayoutSettings, top: number) {
  const x = PAGE_MARGIN;
  const w = STUB_WIDTH;
  bankHeader(doc, data, settings, x, top);
  doc.lineWidth(1).strokeColor(LINE).moveTo(x, top + 18).lineTo(x + w, top + 18).stroke();
  let y = top + 19;
  const stacked: [string, string, CellOptions?][] = [
    ["Vencimento", data.due, { align: "right" }],
    ["Agência / Código Cedente", data.agencyAccount, { align: "right" }],
    ["Nosso Número", data.ourNumber, { align: "right" }],
    ["Número do Documento", data.document ?? data.contract],
  ];
  for (const [label, value, options] of stacked) {
    cell(doc, x, y, w, ROW, label, value, options);
    y += ROW;
  }
  cell(doc, x, y, w * 0.45, ROW, "Espécie Moeda", "R$");
  cell(doc, x + w * 0.45, y, w * 0.55, ROW, "Carteira", data.wallet);
  y += ROW;
  cell(doc, x, y, w * 0.45, ROW, "Aceite", settings.acceptance);
  y += ROW;
  const valueRow = SIDE_ROW - 2;
  const values: [string, string][] = [
    ["1 (=) Valor do Documento", data.value],
    ["2 (-) Desconto / Abatimento", ""],
    ["3 (-) Outras Deduções", ""],
    ["4 (+) Mora / Multa", ""],
    ["5 (+) Outros Acréscimos", ""],
    ["6 (=) Valor Cobrado", ""],
  ];
  for (const [label, value] of values) {
    cell(doc, x, y, w, valueRow, label, value, { align: "right" });
    y += valueRow;
  }
  cell(doc, x, y, w, 22, "Sacado", data.payerName);
  y += 25;
  text(doc, "Recibo do Sacado", x + 1, y, w, 5.5, { color: LABEL });
  text(doc, "autenticar no verso", x, y + 8, w, 4.5, { align: "right", color: LABEL });
}

/** Recibo do pagador across the page (padrão and demonstrativo models), above the cut. */
function drawReceipt(doc: PDFKit.PDFDocument, data: BoletoPdfData, settings: BoletoLayoutSettings, top: number) {
  const x = PAGE_MARGIN;
  const w = PAGE_WIDTH;
  bankHeader(doc, data, settings, x, top);
  text(doc, data.linha, x + 150, top + 4, w - 150, 10, { bold: true, align: "right" });
  let y = top + 19;
  const payer = `${data.payerName}${settings.showPayerDocument && data.payerDocument ? ` — ${data.payerDocument}` : ""}`;
  cellRow(doc, x, y, w, [
    ["Beneficiário", payeeLine(data, settings), 0.5],
    ["Agência / Código do Beneficiário", data.agencyAccount, 0.3],
    ["Vencimento", data.due, 0.2, { align: "right", highlight: settings.highlight }],
  ]);
  y += ROW;
  cellRow(doc, x, y, w, [
    ["Pagador", payer, 0.5],
    ["Nosso Número", data.ourNumber, 0.3, { align: "right" }],
    ["(=) Valor do Documento", data.value, 0.2, { align: "right", bold: true, highlight: settings.highlight }],
  ]);
  y += ROW;
  cellRow(doc, x, y, w, [
    ["Número do Documento", data.document ?? data.contract, 0.25],
    ["Espécie Documento", settings.documentKind, 0.15],
    ["Data do Documento", documentDate(data, settings), 0.2],
    ["Espécie Moeda", "R$", 0.1],
    ["(=) Valor Cobrado", "", 0.3],
  ]);
  y += ROW + 4;
  text(doc, "Recibo do Pagador", x + 1, y, 200, 6.5, { bold: true, color: LABEL });
  text(doc, "Autenticação mecânica", x + w - 200, y, 200, 5.5, { align: "right", color: LABEL });
}

/** Ficha de compensação: what the bank reads, with the barcode. */
function drawSlip(doc: PDFKit.PDFDocument, data: BoletoPdfData, settings: BoletoLayoutSettings, x: number, top: number, width: number) {
  const sideWidth = Math.round(width * SIDE_SHARE);
  const main = width - sideWidth;
  const side = x + main;
  const highlight = settings.highlight;
  bankHeader(doc, data, settings, x, top);
  text(doc, data.linha, x + 150, top + 4, width - 150, 10, { bold: true, align: "right" });
  let y = top + 19;

  cell(doc, x, y, main, ROW, "Local de Pagamento", settings.paymentPlace, { boxed: true, wrap: true });
  cell(doc, side, y, sideWidth, ROW, "Vencimento", data.due, { boxed: true, align: "right", highlight });
  y += ROW;
  cell(doc, x, y, main, ROW, "Cedente", data.payeeName, { boxed: true });
  if (settings.showPayeeDocument && data.payeeDocument) text(doc, data.payeeDocument, x + main - 120, y + ROW - 8.5, 117, 6.5, { align: "right" });
  cell(doc, side, y, sideWidth, ROW, "Agência / Código Cedente", data.agencyAccount, { boxed: true, align: "right" });
  y += ROW;
  cellRow(doc, x, y, main, [
    ["Data do Documento", documentDate(data, settings), 0.21],
    ["Número do Documento", data.document ?? data.contract, 0.22],
    ["Espécie Documento", settings.documentKind, 0.17],
    ["Aceite", settings.acceptance, 0.13],
    ["Data Process.", processDate(data, settings), 0.27],
  ]);
  cell(doc, side, y, sideWidth, ROW, "Nosso Número", data.ourNumber, { boxed: true, align: "right" });
  y += ROW;
  cellRow(doc, x, y, main, [
    ["Uso do Banco", "", 0.12],
    ["Cip", "", 0.09],
    ["Carteira", data.wallet, 0.17],
    ["Espécie Moeda", "R$", 0.17],
    ["Quantidade", "", 0.17],
    ["Valor", "", 0.28],
  ]);
  cell(doc, side, y, sideWidth, ROW, "1 (=) Valor do Documento", data.value, { boxed: true, align: "right", highlight, bold: true });
  y += ROW;

  const instructionsHeight = SIDE_ROW * 5;
  cell(doc, x, y, main, instructionsHeight, "Instruções de responsabilidade do Cedente", "", { boxed: true });
  data.instructions.slice(0, 8).forEach((line, i) => text(doc, line, x + 8, y + 10 + i * 8.5, main - 16, 6.5));
  ["2 (-) Desconto / Abatimento", "3 (-) Outras Deduções", "4 (+) Mora / Multa", "5 (+) Outros Acréscimos", "6 (=) Valor Cobrado"].forEach((label, i) =>
    cell(doc, side, y + i * SIDE_ROW, sideWidth, SIDE_ROW, label, "", { boxed: true })
  );
  y += instructionsHeight;

  const payerHeight = 36;
  doc.lineWidth(0.6).strokeColor(LINE).rect(x, y, width, payerHeight).stroke();
  text(doc, "Sacado:", x + 2, y + 1.5, 60, 5, { color: LABEL });
  text(doc, `${data.payerName}  (${data.contract})`, x + 8, y + 8, main - 70, 6.5, { bold: true });
  if (settings.showPayerDocument && data.payerDocument) text(doc, data.payerDocument, side - 60, y + 8, 120, 6.5, { bold: true });
  if (settings.showPayerAddress && data.payerAddress) text(doc, data.payerAddress, x + 8, y + 16.5, width - 16, 6.5, { bold: true });
  if (settings.showPayerAddress && data.payerLocality) text(doc, data.payerLocality, x + 8, y + 25, width - 16, 6.5, { bold: true });
  y += payerHeight;
  text(doc, "Sacador / Avalista:", x + 2, y + 1.5, 100, 5, { color: LABEL });
  if (settings.showGuarantor) text(doc, payeeLine(data, { ...settings, showPayeeDocument: true }), x + 60, y + 0.5, main - 60, 6.5);
  doc.lineWidth(1).strokeColor(LINE).moveTo(x, y + 8).lineTo(x + width, y + 8).stroke();
  text(doc, "Ficha de Compensação", side - 20, y + 11, sideWidth + 20, 8, { bold: true, align: "right", color: "#777" });
  drawBarcode(doc, data.barcode, x + 6, y + 11, 37);
}

function cutLine(doc: PDFKit.PDFDocument, y: number) {
  doc.lineWidth(0.5).strokeColor("#888").dash(1, { space: 2.5 }).moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + PAGE_WIDTH, y).stroke().undash();
}

/** One boleto in its place on the page, as the layout's model draws it. */
function drawBoleto(doc: PDFKit.PDFDocument, data: BoletoPdfData, layout: BoletoPdfLayout, slot: number) {
  const { settings } = layout;
  const top = PAGE_MARGIN + slot * SLOT_HEIGHT;
  switch (layout.model) {
    case "CARNE":
      drawStub(doc, data, settings, top);
      drawSlip(doc, data, settings, PAGE_MARGIN + STUB_WIDTH + STUB_GAP, top, PAGE_WIDTH - STUB_WIDTH - STUB_GAP);
      cutLine(doc, top + SLOT_HEIGHT - 6);
      return;
    case "FICHA":
      drawSlip(doc, data, settings, PAGE_MARGIN, top, PAGE_WIDTH);
      cutLine(doc, top + SLOT_HEIGHT - 6);
      return;
    case "PADRAO":
      drawReceipt(doc, data, settings, PAGE_MARGIN);
      cutLine(doc, PAGE_MARGIN + RECEIPT_HEIGHT + 18);
      drawSlip(doc, data, settings, PAGE_MARGIN, PAGE_MARGIN + RECEIPT_HEIGHT + 34, PAGE_WIDTH);
      return;
    case "DEMONSTRATIVO": {
      doc.lineWidth(0.6).strokeColor(LINE).rect(PAGE_MARGIN, PAGE_MARGIN, PAGE_WIDTH, DEMONSTRATIVE_HEIGHT).stroke();
      text(doc, "Demonstrativo", PAGE_MARGIN + 4, PAGE_MARGIN + 4, 200, 7.5, { bold: true, color: LABEL });
      data.demonstrative.slice(0, 16).forEach((line, i) => text(doc, line, PAGE_MARGIN + 10, PAGE_MARGIN + 20 + i * 11, PAGE_WIDTH - 20, 8.5));
      const receiptTop = PAGE_MARGIN + DEMONSTRATIVE_HEIGHT + 14;
      drawReceipt(doc, data, settings, receiptTop);
      cutLine(doc, receiptTop + RECEIPT_HEIGHT + 18);
      drawSlip(doc, data, settings, PAGE_MARGIN, receiptTop + RECEIPT_HEIGHT + 34, PAGE_WIDTH);
    }
  }
}

/**
 * The boletos in one PDF. Each group comes out in its layout, starting on a new page: carnê and ficha put up to
 * `perPage` boletos one under the other; padrão and demonstrativo, one per page.
 */
export function renderBoletosPdf(groups: { layout: BoletoPdfLayout; boletos: BoletoPdfData[] }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    for (const { layout, boletos } of groups) {
      boletos.forEach((data, i) => {
        const slot = i % layout.perPage;
        if (slot === 0) doc.addPage();
        drawBoleto(doc, data, layout, slot);
      });
    }
    doc.end();
  });
}
