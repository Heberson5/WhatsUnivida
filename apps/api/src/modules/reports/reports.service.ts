import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma";

export interface ReportParams {
  from: Date;
  to: Date;
  agentId?: string;
  /** Empty/undefined = every WhatsApp connection — see PROMPT: filtro podendo selecionar várias ou todas. */
  connectionIds?: string[];
  /** Browser's UTC offset in minutes — see lib/period.ts. Only needed by reports that format a date/time column. */
  tzOffsetMinutes?: number;
}

// Every report row is built with Portuguese keys directly — those keys
// double as the column headers for CSV/XLSX/PDF (Object.keys(rows[0])) and
// as the <th> labels in the on-screen table, so translating here is the one
// place that fixes all of them at once. See PROMPT: "os cabeçalhos do
// relatório e as informações devem estar tudo em português".
const STATUS_LABEL: Record<string, string> = {
  NEW: "Nova",
  WAITING: "Aguardando",
  IN_PROGRESS: "Em atendimento",
  TRANSFERRED: "Transferida",
  CLOSED: "Encerrada",
  ABANDONED: "Abandonada",
  HANDLED_EXTERNALLY: "Atendido pelo celular",
};

function minutes(ms: number | null): number | string {
  return ms === null ? "-" : Math.round(ms / 60000);
}

// Formats in the browser's local time, not the server's (this API runs in a
// container with no TZ set, i.e. UTC) — see lib/period.ts for the same
// reasoning applied to period boundaries. Pure arithmetic, no IANA timezone
// database needed since Brazil has had no DST since 2019.
function formatDateTime(d: Date | null, tzOffsetMinutes = 0): string {
  if (!d) return "-";
  const local = new Date(d.getTime() - tzOffsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}/${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

export async function getAttendanceReport({ from, to, agentId, connectionIds, tzOffsetMinutes = 0 }: ReportParams) {
  const connectionFilter = connectionIds === undefined ? undefined : { in: connectionIds };
  const conversations = await prisma.conversation.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      assignedAgentId: agentId,
      ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
    },
    include: {
      contact: true,
      assignedAgent: true,
      whatsappConnection: true,
      messages: { select: { direction: true } },
      transfers: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return conversations.map((c) => {
    const received = c.messages.filter((m) => m.direction === "INBOUND").length;
    const sent = c.messages.filter((m) => m.direction === "OUTBOUND").length;
    const acceptMs = c.acceptedAt ? c.acceptedAt.getTime() - c.enteredQueueAt.getTime() : null;
    const firstResponseMs = c.acceptedAt && c.firstResponseAt ? c.firstResponseAt.getTime() - c.acceptedAt.getTime() : null;
    const totalMs = c.closedAt ? c.closedAt.getTime() - c.enteredQueueAt.getTime() : null;

    return {
      Data: formatDateTime(c.createdAt, tzOffsetMinutes),
      Conexão: c.whatsappConnection.name,
      Cliente: c.contact.name ?? c.contact.phone,
      Telefone: c.contact.phone,
      Atendente: c.assignedAgent?.displayName ?? "-",
      "Entrada na fila": formatDateTime(c.enteredQueueAt, tzOffsetMinutes),
      Aceite: formatDateTime(c.acceptedAt, tzOffsetMinutes),
      "Até aceite (min)": minutes(acceptMs),
      "Até 1ª resposta (min)": minutes(firstResponseMs),
      Encerramento: formatDateTime(c.closedAt, tzOffsetMinutes),
      "Duração total (min)": minutes(totalMs),
      "Mensagens recebidas": received,
      "Mensagens enviadas": sent,
      Transferências: c.transfers.length,
      Status: STATUS_LABEL[c.status] ?? c.status,
    };
  });
}

export async function getPerAgentReport({ from, to, connectionIds }: ReportParams) {
  const connectionFilter = connectionIds === undefined ? undefined : { in: connectionIds };
  const agents = await prisma.user.findMany({ where: { role: "AGENT" }, orderBy: { displayName: "asc" } });

  return Promise.all(
    agents.map(async (agent) => {
      const conversations = await prisma.conversation.findMany({
        where: { assignedAgentId: agent.id, createdAt: { gte: from, lte: to }, ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}) },
      });
      const messagesSent = await prisma.message.count({
        where: {
          senderAgentId: agent.id,
          createdAt: { gte: from, lte: to },
          ...(connectionFilter ? { conversation: { whatsappConnectionId: connectionFilter } } : {}),
        },
      });
      const transfersReceived = await prisma.conversationTransfer.count({
        where: { toAgentId: agent.id, createdAt: { gte: from, lte: to }, ...(connectionFilter ? { conversation: { whatsappConnectionId: connectionFilter } } : {}) },
      });
      const transfersMade = await prisma.conversationTransfer.count({
        where: { fromAgentId: agent.id, createdAt: { gte: from, lte: to }, ...(connectionFilter ? { conversation: { whatsappConnectionId: connectionFilter } } : {}) },
      });

      const acceptDiffs = conversations.filter((c) => c.acceptedAt).map((c) => c.acceptedAt!.getTime() - c.enteredQueueAt.getTime());
      const firstResponseDiffs = conversations
        .filter((c) => c.acceptedAt && c.firstResponseAt)
        .map((c) => c.firstResponseAt!.getTime() - c.acceptedAt!.getTime());
      const handlingDiffs = conversations.filter((c) => c.acceptedAt && c.closedAt).map((c) => c.closedAt!.getTime() - c.acceptedAt!.getTime());

      const avg = (arr: number[]): number | string => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length / 60000) : "-");

      return {
        Atendente: agent.displayName,
        Conversas: conversations.length,
        "Mensagens enviadas": messagesSent,
        "Tempo médio até aceite (min)": avg(acceptDiffs),
        "Tempo médio até 1ª resposta (min)": avg(firstResponseDiffs),
        "Tempo médio de atendimento (min)": avg(handlingDiffs),
        "Transferências recebidas": transfersReceived,
        "Transferências realizadas": transfersMade,
      };
    })
  );
}

export async function getMessagesReport({ from, to, agentId, connectionIds }: ReportParams) {
  const connectionFilter = connectionIds === undefined ? undefined : { in: connectionIds };
  const conversationFilter = {
    ...(agentId ? { assignedAgentId: agentId } : {}),
    ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
  };
  const [received, sent] = await Promise.all([
    prisma.message.count({ where: { direction: "INBOUND", createdAt: { gte: from, lte: to }, conversation: conversationFilter } }),
    prisma.message.count({ where: { direction: "OUTBOUND", createdAt: { gte: from, lte: to }, conversation: conversationFilter } }),
  ]);
  return { Recebidas: received, Enviadas: sent, Total: received + sent };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))];
  return lines.join("\n");
}

/** Spreadsheet export — see PROMPT: "Relatórios poder extrair em ... xlsx." */
export async function toXlsx(rows: Record<string, unknown>[], sheetName: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "WhatsUnivida";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31)); // Excel's own sheet-name length limit

  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    // Content-aware width (not just the header text) so a long client name
    // or connection name isn't left visually squeezed — see PROMPT: "as
    // linhas devem aparecer corretamente os dados, não pode cortar as informações".
    sheet.columns = headers.map((h) => {
      const longestValue = rows.reduce((max, row) => {
        const value = row[h];
        const len = value === null || value === undefined ? 0 : String(value).length;
        return Math.max(max, len);
      }, 0);
      return { header: h, key: h, width: Math.min(Math.max(h.length, longestValue) + 4, 45) };
    });
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0097B4" } };
    rows.forEach((row) => sheet.addRow(row));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** PDF export — see PROMPT: "Relatórios poder extrair em PDF". A plain, readable tabular layout — no external headless-browser dependency. */
export function toPdf(rows: Record<string, unknown>[], title: string, tzOffsetMinutes = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).fillColor("#14202b").text(title);
    doc.fontSize(9).fillColor("#64748b").text(`Gerado em ${formatDateTime(new Date(), tzOffsetMinutes)}`);
    doc.moveDown();

    if (rows.length === 0) {
      doc.fontSize(11).fillColor("#14202b").text("Nenhum dado para o período selecionado.");
      doc.end();
      return;
    }

    const headers = Object.keys(rows[0]);
    const cellRows = rows.map((row) => headers.map((h) => (row[h] === null || row[h] === undefined ? "-" : String(row[h]))));
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cellPadding = 8;
    const fontSize = headers.length > 10 ? 7 : 8;
    doc.fontSize(fontSize);

    // Content-aware column widths (header + every cell in that column, up to
    // a per-column cap) instead of an equal split — a wall of narrow columns
    // is exactly what forced the old ellipsis truncation. Any column still
    // too narrow for its content wraps onto extra lines below instead of
    // cutting text, so nothing is ever lost — see PROMPT: "não pode cortar
    // as informações".
    const maxColWidth = pageWidth / Math.max(3, headers.length - 2);
    const naturalWidths = headers.map((h, i) => {
      const headerWidth = doc.font("Helvetica-Bold").widthOfString(h);
      const contentWidth = cellRows.reduce((max, cells) => Math.max(max, doc.font("Helvetica").widthOfString(cells[i])), 0);
      return Math.min(Math.max(headerWidth, contentWidth) + cellPadding * 2, maxColWidth);
    });
    const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
    // Stretch columns to fill the page when there's room to spare; shrink
    // proportionally (not by cutting) when the natural widths overflow it.
    const scale = totalNatural > 0 ? pageWidth / totalNatural : 1;
    const colWidths = naturalWidths.map((w) => w * scale);
    const colX = colWidths.reduce<number[]>((acc, w, i) => [...acc, i === 0 ? doc.page.margins.left : acc[i - 1] + colWidths[i - 1]], []);

    let y = doc.y;

    function rowHeightFor(cells: string[], bold: boolean): number {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
      const lineHeights = cells.map((text, i) => doc.heightOfString(text, { width: colWidths[i] - cellPadding * 2 }));
      return Math.max(...lineHeights, fontSize + 4) + cellPadding;
    }

    const drawRow = (values: string[], opts: { header?: boolean; shaded?: boolean }) => {
      const height = rowHeightFor(values, Boolean(opts.header));
      if (opts.header) {
        doc.rect(doc.page.margins.left, y, pageWidth, height).fill("#0097B4");
      } else if (opts.shaded) {
        doc.rect(doc.page.margins.left, y, pageWidth, height).fill("#f4f7f9");
      }
      doc.font(opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor(opts.header ? "#ffffff" : "#14202b");
      values.forEach((value, i) => {
        doc.text(value, colX[i] + cellPadding / 2, y + cellPadding / 2, { width: colWidths[i] - cellPadding });
      });
      y += height;
    };

    drawRow(headers, { header: true });
    rows.forEach((row, idx) => {
      const cells = cellRows[idx];
      const height = rowHeightFor(cells, false);
      if (y + height > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawRow(headers, { header: true });
      }
      drawRow(cells, { shaded: idx % 2 === 1 });
    });

    doc.end();
  });
}
