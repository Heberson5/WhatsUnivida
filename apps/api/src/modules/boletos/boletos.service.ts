import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DataSource, Prisma } from "@prisma/client";
import { format } from "date-fns";
import {
  BOLETO_BANK_CODES,
  BOLETO_SAMPLES_REQUIRED,
  DATA_SOURCE_ROLES,
  fillBoletoSendMessage,
  type BoletoBankValidationDTO,
  type BoletoLayoutInput,
  type BoletoPreviewDTO,
  type BoletoPreviewItemDTO,
  type DataSourceBankDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { env } from "../../config/env";
import { buildContracts, clientRows, parseBrDate, sourceStatus, usableSource, type ColumnMap, type ConversationForData, type Row } from "../data-sources/data-sources.service";
import { barcodeFromLinha, buildBarcode, freeFieldBB, linhaFromBarcode } from "./boleto-code";
import { BOLETO_BANK_RULES } from "./boleto-banks";
import { renderBoletosPdf, type BoletoPdfData } from "./boleto-pdf";
import { examplePixCode, validPixCode } from "./boleto-pix";
import { expandLayoutText, getSendMessage, layoutForBank, toLayoutInput } from "./boleto-layouts.service";

// The banks with their own boleto rule (boleto-banks.ts). Each one only sends after its validation with real boletos.
export const BANKS: Record<string, { name: string; source: string }> = Object.fromEntries(
  Object.entries(BOLETO_BANK_RULES).map(([code, bank]) => [code, { name: bank.name, source: bank.source }])
);

// Payment methods (forma_pagamento) that never get a boleto.
const NO_BOLETO_METHODS = [/cart[aã]o recorrente/i, /sem boleto/i];

const VALIDATION_KEY = "boleto-validation";
type ValidationState = Record<string, { matched: string[]; lastFailure: string | null }>;

async function readValidation(): Promise<ValidationState> {
  const row = await prisma.systemSetting.findUnique({ where: { key: VALIDATION_KEY } });
  return (row?.value as ValidationState | undefined) ?? {};
}

async function writeValidation(state: ValidationState) {
  const value = state as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: VALIDATION_KEY }, update: { value }, create: { key: VALIDATION_KEY, value } });
}

export async function getValidation(): Promise<BoletoBankValidationDTO[]> {
  const state = await readValidation();
  return BOLETO_BANK_CODES.filter((code) => BANKS[code]).map((code) => {
    const bank = BANKS[code];
    const matched = state[code]?.matched.length ?? 0;
    return { code, name: bank.name, matched, required: BOLETO_SAMPLES_REQUIRED, enabled: matched >= BOLETO_SAMPLES_REQUIRED, lastFailure: state[code]?.lastFailure ?? null };
  });
}

function digits(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** "1.234,56", "1234.56" or "89,9" → cents. */
export function parseMoneyCents(value: string | undefined): number | null {
  const raw = (value ?? "").replace(/[^\d.,-]/g, "");
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

interface BuiltBoleto {
  bank: string;
  due: Date;
  cents: number;
  ourNumber: string;
  barcode: string;
  linha: string;
  /** As each bank prints them (Sicredi "00/554364-1", "0804.22.00017"...); null = the source's own. */
  ourNumberPrinted: string;
  agencyCodePrinted: string | null;
  walletPrinted: string | null;
  /** The PIX copia e cola the source brings for this boleto (checked); null = this boleto has no PIX. */
  pix: string | null;
}

/** The boleto of one source row — or the reason it can't be generated. Nothing typed by a person goes in. */
export function buildBoletoFromRow(data: Row, map: ColumnMap): BuiltBoleto {
  const col = (role: keyof ColumnMap) => (map[role] ? data[map[role]!] : undefined);
  const method = col("paymentMethod") ?? "";
  if (NO_BOLETO_METHODS.some((re) => re.test(method))) throw new Error(`Parcela sem boleto: ${method}`);
  const bank = digits(col("bankCode")).padStart(3, "0");
  if (!BANKS[bank]) throw new Error(`Banco ${bank || "não informado"} não tem envio de boleto`);
  const due = parseBrDate(col("boletoDue")) ?? parseBrDate(col("parcelDue"));
  if (!due) throw new Error("Parcela sem vencimento");
  const cents = parseMoneyCents(col("boletoValue")) ?? parseMoneyCents(col("parcelValue"));
  if (!cents) throw new Error("Parcela sem valor");
  const ourNumber = col("ourNumber") ?? "";
  if (!digits(ourNumber)) throw new Error("Parcela sem nosso número");
  const parts = BOLETO_BANK_RULES[bank].build({
    agreement: col("agreement") ?? "",
    ourNumber,
    wallet: col("wallet") ?? "",
    agency: col("agency") ?? "",
    account: col("account") ?? "",
    post: col("post") ?? "",
  });
  const barcode = buildBarcode(bank, due, cents, parts.freeField);
  const linha = linhaFromBarcode(barcode);
  if (barcodeFromLinha(linha) !== barcode) throw new Error("A linha digitável não passou na conferência dos dígitos");
  // A source synced before this column existed has it unmapped: the script's column name still finds it.
  const pix = validPixCode(data[map.pixCode ?? DATA_SOURCE_ROLES.pixCode.column]);
  return { bank, due, cents, ourNumber, barcode, linha, ourNumberPrinted: parts.ourNumberPrinted, agencyCodePrinted: parts.agencyCodePrinted, walletPrinted: parts.walletPrinted, pix };
}

const withoutLeadingZeros = (value: string) => value.replace(/^0+/, "");

/**
 * The parcel with this nosso número, written either way: with or without leading zeros (Excel drops them), and as
 * printed on a Banco do Brasil boleto (convênio + sequence, 17 digits, maybe "-DV") or as the sequence alone.
 */
async function findRowByOurNumber(sourceId: string, column: string, ourNumber: string) {
  const typed = digits(ourNumber);
  const keys = [...new Set([withoutLeadingZeros(typed), ...(typed.length >= 17 ? [withoutLeadingZeros(typed.slice(7, 17))] : [])])].filter(Boolean);
  if (keys.length === 0) return null;
  const found = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "DataSourceRow"
    WHERE "dataSourceId" = ${sourceId}
      AND (
        ltrim(regexp_replace(data->>${column}, '\D', '', 'g'), '0') = ANY(${keys})
        OR (length(regexp_replace(data->>${column}, '\D', '', 'g')) IN (17, 18)
            AND ltrim(substr(regexp_replace(data->>${column}, '\D', '', 'g'), 8, 10), '0') = ANY(${keys}))
      )
    ORDER BY line
    LIMIT 1`;
  return found[0] ? prisma.dataSourceRow.findUnique({ where: { id: found[0].id } }) : null;
}

/**
 * Admin check before a bank is enabled: the nosso número and the linha of a
 * REAL boleto. The system builds it from the source row with that nosso
 * número; it only counts when the two linhas are identical.
 */
export async function submitValidationSample(ourNumber: string, realLinha: string): Promise<BoletoBankValidationDTO[]> {
  const sources = (await prisma.dataSource.findMany({ where: { active: true } })).filter((s) => sourceStatus(s) === "OK");
  if (sources.length === 0) throw Errors.badRequest("Ative uma fonte de dados funcionando antes de validar boletos");
  const withOurNumber = sources.filter((s) => (s.columnMap as ColumnMap).ourNumber);
  if (withOurNumber.length === 0) throw Errors.badRequest("A fonte não tem a coluna do nosso número");
  const realBarcode = barcodeFromLinha(realLinha);
  if (!realBarcode) throw Errors.badRequest("A linha digitável informada tem dígitos verificadores errados — confira a digitação");
  const bank = realBarcode.slice(0, 3);
  if (!BANKS[bank]) throw Errors.badRequest("Banco sem envio de boleto");
  const wanted = digits(ourNumber);
  // Any active source may have it: the boleto is the same whichever connection sends it.
  let found: { row: NonNullable<Awaited<ReturnType<typeof findRowByOurNumber>>>; map: ColumnMap } | null = null;
  for (const source of withOurNumber) {
    const map = source.columnMap as ColumnMap;
    const row = await findRowByOurNumber(source.id, map.ourNumber!, ourNumber);
    if (row) {
      found = { row, map };
      break;
    }
  }
  if (!found) throw Errors.badRequest("Nenhuma parcela da fonte de dados tem esse nosso número");
  const { row, map } = found;

  const state = await readValidation();
  const bankState = state[bank] ?? { matched: [], lastFailure: null };
  let failure: string | null = null;
  try {
    const built = buildBoletoFromRow(row.data as Row, map);
    if (built.barcode !== realBarcode) failure = `A linha gerada (${built.linha}) é diferente da linha real`;
  } catch (err) {
    failure = (err as Error).message;
  }
  if (failure) bankState.lastFailure = failure;
  else if (!bankState.matched.includes(wanted)) bankState.matched.push(wanted);
  state[bank] = bankState;
  await writeValidation(state);
  if (failure) throw Errors.badRequest(`Não confere: ${failure}. O envio deste banco continua bloqueado.`);
  return getValidation();
}

export async function resetValidation(bank: string): Promise<BoletoBankValidationDTO[]> {
  const state = await readValidation();
  delete state[bank];
  await writeValidation(state);
  return getValidation();
}

interface SelectedParcel {
  rowId: string;
  data: Row;
  contract: string;
  document: string | null;
  boleto: BuiltBoleto;
}

/**
 * The parcels picked, checked: same client, every older open parcel of the
 * same contract included (no skipping), bank validated, boleto generated.
 */
async function resolveSelection(conversation: ConversationForData, parcelIds: string[]): Promise<{ source: DataSource; map: ColumnMap; parcels: SelectedParcel[] }> {
  const source = await usableSource(conversation);
  if (!source) throw Errors.badRequest("Dados do cliente indisponíveis no momento");
  const { map, byClient, selectedKey } = await clientRows(source, conversation);
  if (!selectedKey) throw Errors.badRequest("Escolha o cliente primeiro");
  const rows = byClient.get(selectedKey)!;
  const contracts = buildContracts(rows, map);
  const validation = await getValidation();
  const selected = new Set(parcelIds);
  const parcels: SelectedParcel[] = [];
  for (const contract of contracts) {
    const picked = contract.parcels.filter((p) => selected.has(p.id));
    if (picked.length === 0) continue;
    const lastPicked = contract.parcels.findIndex((p) => p.id === picked[picked.length - 1].id);
    const skipped = contract.parcels.slice(0, lastPicked).find((p) => !selected.has(p.id));
    if (skipped) throw Errors.badRequest(`Envie primeiro a parcela de ${skipped.due} — não é possível pular parcelas mais antigas`);
    for (const parcel of picked) {
      const row = rows.find((r) => r.id === parcel.id)!;
      let boleto: BuiltBoleto;
      try {
        boleto = buildBoletoFromRow(row.data, map);
      } catch (err) {
        throw Errors.badRequest(`Parcela de ${parcel.due}: ${(err as Error).message}`);
      }
      if (!validation.find((v) => v.code === boleto.bank)?.enabled) {
        throw Errors.badRequest(`O envio de boleto do ${BANKS[boleto.bank].name} ainda não foi liberado (falta validar com boletos reais)`);
      }
      parcels.push({ rowId: row.id, data: row.data, contract: contract.number, document: parcel.document, boleto });
    }
    parcelIds = parcelIds.filter((id) => !picked.some((p) => p.id === id));
  }
  if (parcelIds.length > 0 || parcels.length === 0) throw Errors.badRequest("Parcela não encontrada para este cliente");
  return { source, map, parcels };
}

function previewItem(p: SelectedParcel, today: Date): BoletoPreviewItemDTO {
  return {
    parcelId: p.rowId,
    contract: p.contract,
    document: p.document,
    due: format(p.boleto.due, "dd/MM/yyyy"),
    value: formatMoney(p.boleto.cents),
    overdue: p.boleto.due < today,
    linha: p.boleto.linha,
    pix: p.boleto.pix,
  };
}

// A boleto without PIX never mentions it: lines of the instructions or the send message that talk about PIX go away.
const PIX_LINE = /\bpix\b/i;
function withoutPixLines(text: string, hasPix: boolean): string {
  return hasPix ? text : text.split("\n").filter((line) => !PIX_LINE.test(line)).join("\n");
}
const pixLines = (lines: string[], hasPix: boolean) => (hasPix ? lines : lines.filter((line) => !PIX_LINE.test(line)));

function todayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export async function previewBoletos(conversation: ConversationForData & { contact: { name: string | null; phone: string | null } }, parcelIds: string[]): Promise<BoletoPreviewDTO> {
  const { map, parcels } = await resolveSelection(conversation, parcelIds);
  const today = todayStart();
  const items = parcels.map((p) => previewItem(p, today));
  const clientName = (map.clientName && parcels[0].data[map.clientName]) || conversation.contact.name || "";
  return {
    items,
    // Dados › Mensagem de envio: the plural one when several boletos go in the PDF.
    message: withoutPixLines(
      fillBoletoSendMessage(await getSendMessage(), { clientName, boletos: parcels.map((p, i) => ({ due: items[i].due, cents: p.boleto.cents })) }),
      items.some((item) => item.pix)
    ),
    warnings: items.filter((i) => i.overdue).map((i) => `Boleto vencido em ${i.due} — o banco pode cobrar juros ou recusar`),
  };
}

export interface PreparedBoletos {
  items: BoletoPreviewItemDTO[];
  pdf: Buffer;
  fileName: string;
  storageKey: string;
}

/** Builds the one PDF with every parcel's boleto (saved to uploads) for sending; the caller sends and records it. */
export async function prepareBoletos(
  conversation: ConversationForData & { contact: { name: string | null; phone: string | null } },
  parcelIds: string[],
  confirmOverdue: boolean
): Promise<PreparedBoletos> {
  const { source, map, parcels } = await resolveSelection(conversation, parcelIds);
  const today = todayStart();
  const issued = format(new Date(), "dd/MM/yyyy");
  const col = (data: Row, role: keyof ColumnMap) => (map[role] ? data[map[role]!] : undefined) || null;
  const items = parcels.map((p) => previewItem(p, today));
  const overdue = items.find((item) => item.overdue);
  if (overdue && !confirmOverdue) throw Errors.badRequest(`Boleto vencido em ${overdue.due} — confirme o envio`);
  const instructions = await prisma.boletoInstruction.findMany();
  // Each bank's boletos in the layout this source chose for it.
  const groups = new Map<string, { layout: BoletoLayoutInput; boletos: BoletoPdfData[] }>();
  for (const [i, p] of parcels.entries()) {
    if (!groups.has(p.boleto.bank)) {
      groups.set(p.boleto.bank, { layout: toLayoutInput(await layoutForBank(source.bankLayouts as Record<string, string>, p.boleto.bank)), boletos: [] });
    }
    const group = groups.get(p.boleto.bank)!;
    const fill = { cents: p.boleto.cents, contract: p.contract, document: p.document, due: items[i].due };
    group.boletos.push({
      bankCode: p.boleto.bank,
      linha: p.boleto.linha,
      barcode: p.boleto.barcode,
      due: items[i].due,
      value: items[i].value,
      issued,
      ourNumber: p.boleto.ourNumberPrinted,
      document: p.document,
      contract: p.contract,
      wallet: p.boleto.walletPrinted ?? col(p.data, "wallet") ?? "",
      payeeName: col(p.data, "payeeName") ?? "",
      payeeDocument: col(p.data, "payeeDocument"),
      agencyAccount: p.boleto.agencyCodePrinted ?? [col(p.data, "agency"), col(p.data, "account")].filter(Boolean).join("/"),
      payerName: col(p.data, "clientName") ?? conversation.contact.name ?? "",
      payerDocument: col(p.data, "cpf"),
      payerAddress: col(p.data, "payerAddress"),
      payerLocality: [col(p.data, "payerZip"), col(p.data, "payerCity")].filter(Boolean).join("   ") || null,
      instructions: pixLines(expandLayoutText(group.layout.settings.instructions, instructions, fill), Boolean(p.boleto.pix)),
      demonstrative: pixLines(expandLayoutText(group.layout.settings.demonstrative, instructions, fill), Boolean(p.boleto.pix)),
      pix: p.boleto.pix,
    });
  }
  const pdf = await renderBoletosPdf([...groups.values()]);
  const storageKey = `${randomUUID()}.pdf`;
  fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), pdf);
  const contracts = [...new Set(items.map((item) => item.contract))];
  const fileName =
    items.length === 1
      ? `boleto-${items[0].contract}-${items[0].due.replace(/\//g, "-")}.pdf`
      : `boletos-${contracts.length === 1 ? `${contracts[0]}-` : ""}${items.length}-parcelas.pdf`;
  return { items, pdf, storageKey, fileName };
}


/** Fictitious data of each bank for the layout preview — never a real convênio. */
function previewFields(bank: string, n: number) {
  const fields: Record<string, { agreement: string; ourNumber: string; wallet: string; agency: string; account: string; post: string }> = {
    "001": { agreement: "1234567", ourNumber: `123456700000001${String(n).padStart(2, "0")}`, wallet: "17", agency: "1234-5", account: "99999-9", post: "" },
    "748": { agreement: "12345", ourNumber: `2620000${n}`, wallet: "1", agency: "0101-1", account: "", post: "01" },
    "237": { agreement: "", ourNumber: `000000000${String(n).padStart(2, "0")}`, wallet: "09", agency: "1234-5", account: "0099999-9", post: "" },
    "341": { agreement: "", ourNumber: `000000${String(n).padStart(2, "0")}`, wallet: "109", agency: "1234", account: "99999-9", post: "" },
    "104": { agreement: "123456", ourNumber: `1400000000000000${n}`, wallet: "RG", agency: "1234", account: "", post: "" },
  };
  return fields[bank] ?? fields["001"];
}

/** Dados › Layouts de boleto: the layout being edited, with fictitious boletos — a full page of them. */
export async function previewLayoutPdf(layout: BoletoLayoutInput): Promise<Buffer> {
  const instructions = await prisma.boletoInstruction.findMany();
  const boletos = Array.from({ length: layout.perPage }, (_, i): BoletoPdfData => {
    const due = new Date(2026, 10 + i, 10);
    const cents = 12758;
    const parts = BOLETO_BANK_RULES[layout.bankCode].build(previewFields(layout.bankCode, i + 1));
    const ourNumber = parts.ourNumberPrinted;
    const barcode = buildBarcode(layout.bankCode, due, cents, parts.freeField);
    const dueText = format(due, "dd/MM/yyyy");
    const fill = { cents, contract: "C-10", document: `D-${i + 1}`, due: dueText };
    return {
      bankCode: layout.bankCode,
      linha: linhaFromBarcode(barcode),
      barcode,
      due: dueText,
      value: formatMoney(cents),
      issued: format(new Date(), "dd/MM/yyyy"),
      ourNumber,
      document: `D-${i + 1}`,
      contract: "C-10",
      wallet: parts.walletPrinted ?? previewFields(layout.bankCode, 1).wallet,
      payeeName: "EMPRESA EXEMPLO LTDA",
      payeeDocument: "00.000.000/0001-00",
      agencyAccount: parts.agencyCodePrinted ?? "1234-5/99999-9",
      payerName: "CLIENTE DE EXEMPLO DA SILVA",
      payerDocument: "000.000.000-00",
      payerAddress: "RUA DOS EXEMPLOS, 100 - CENTRO",
      payerLocality: "78000-000   CIDADE EXEMPLO",
      instructions: pixLines(expandLayoutText(layout.settings.instructions, instructions, fill), i === 0),
      demonstrative: pixLines(expandLayoutText(layout.settings.demonstrative, instructions, fill), i === 0),
      // The first boleto with a fictitious PIX, the others without: the preview shows both ways.
      pix: i === 0 ? examplePixCode(cents) : null,
    };
  });
  return renderBoletosPdf([{ layout, boletos }]);
}

/** The banks in a source's parcels — to choose each one's layout. */
export async function sourceBanks(sourceId: string): Promise<DataSourceBankDTO[]> {
  const source = await prisma.dataSource.findUnique({ where: { id: sourceId } });
  if (!source) throw Errors.notFound("Fonte de dados não encontrada");
  const column = (source.columnMap as ColumnMap).bankCode;
  if (!column) return [];
  const counts = await prisma.$queryRaw<{ code: string; parcels: bigint }[]>`
    SELECT lpad(regexp_replace(data->>${column}, '\D', '', 'g'), 3, '0') AS code, count(*) AS parcels
    FROM "DataSourceRow" WHERE "dataSourceId" = ${sourceId} AND coalesce(data->>${column}, '') <> ''
    GROUP BY 1 ORDER BY 2 DESC`;
  const validation = await getValidation();
  return counts
    .filter((c) => c.code !== "000")
    .map((c) => ({
      code: c.code,
      name: BANKS[c.code]?.name ?? `Banco ${c.code}`,
      parcels: Number(c.parcels),
      enabled: Boolean(validation.find((v) => v.code === c.code)?.enabled),
    }));
}
