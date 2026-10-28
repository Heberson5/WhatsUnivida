import { PassThrough, Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parse as parseCsvSync } from "csv-parse/sync";
import type { DataSourceDialect } from "@whatsatendende/types";

export interface FetchedTable {
  columns: string[];
  rows: Record<string, string>[];
  /** When the data itself was produced (the file's last modification), if the origin says. */
  modifiedAt: Date | null;
}

// A 300 MB CSV holds about 720 thousand lines.
const MAX_ROWS = 750_000;
// Excel stores numbers with 15 significant digits: from 16 digits on, the value in the file is already rounded.
const EXCEL_SAFE_NUMBER = 1e15;
const FETCH_TIMEOUT_MS = 60_000;
// A 300 MB file over a slow link takes minutes.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// The most a .zip/.gz may hold once unpacked — a CSV compresses about 10×.
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;

/** Column names as tags use them: lowercase, no accents, words joined by "_". */
export function normalizeColumn(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** A cell as the panel shows it. "NULL" is what SQL Server Management Studio writes for an empty cell when copying results. */
function cellValue(cell: string | undefined): string {
  const value = (cell ?? "").trim();
  return value === "NULL" ? "" : value;
}

function headerColumns(header: string[]): string[] {
  const columns = header.map(normalizeColumn);
  if (columns.some((c) => !c)) throw new Error("A primeira linha precisa ter o nome de todas as colunas");
  if (new Set(columns).size !== columns.length) throw new Error("Há colunas com o mesmo nome na primeira linha");
  return columns;
}

/** One line of the sheet as a row, or null for a blank line. */
function toRow(columns: string[], cells: string[]): Record<string, string> | null {
  if (!cells.some((c) => c.trim() !== "")) return null;
  return Object.fromEntries(columns.map((c, i) => [c, cellValue(cells[i])]));
}

function toTable(header: string[], body: string[][], modifiedAt: Date | null): FetchedTable {
  const columns = headerColumns(header);
  if (body.length > MAX_ROWS) throw new Error(`A planilha tem mais de ${MAX_ROWS} linhas`);
  const rows = body.map((cells) => toRow(columns, cells)).filter((row): row is Record<string, string> => row !== null);
  return { columns, rows, modifiedAt };
}

/** UTF-8, UTF-16 (SSMS "Salvar Resultados Como" may save Unicode) or Windows-1252 (Excel/SSMS in ANSI). */
function decodeCsv(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

function parseCsv(buffer: Buffer, modifiedAt: Date | null): FetchedTable {
  const text = decodeCsv(buffer);
  const firstLine = text.slice(0, text.indexOf("\n") >>> 0);
  // Excel in Portuguese saves with ";", SQL Server Management Studio with ",".
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  // Each line becomes its row as it is read: a 300 MB file never sits in memory twice (as lines, then as rows).
  let columns: string[] | null = null;
  const rows: Record<string, string>[] = parseCsvSync(text, {
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    on_record: (cells: string[], { records }: { records: number }) => {
      if (!columns) {
        columns = headerColumns(cells);
        return null;
      }
      if (records > MAX_ROWS) throw new Error(`A planilha tem mais de ${MAX_ROWS} linhas`);
      return toRow(columns, cells);
    },
  });
  if (!columns) throw new Error("A planilha está vazia");
  return { columns, rows, modifiedAt };
}

/**
 * The parts ExcelJS' streaming reader needs, in the order it needs them, and only the workbook's first sheet.
 *
 * The reader expects the relationships, xl/workbook.xml and the shared strings to come before the sheets inside the
 * zip. Many files have the sheets first (ExcelJS itself writes sheet1.xml, sheet2.xml, sharedStrings.xml and only then
 * workbook.xml): the reader then parks the sheets in temp files while it reads on, and most of the time it ended
 * with "Cannot read properties of undefined (reading 'sheets')" — 28 of 30 reads of one such file. It also took
 * the first sheet found in the zip, which is not always the first tab. Rebuilt uncompressed (STORE) and streamed, so
 * a big sheet is never held in memory twice.
 */
async function orderedXlsx(buffer: Buffer): Promise<{ stream: Readable; hasSharedStrings: boolean }> {
  const zip = await JSZip.loadAsync(buffer);
  const text = async (name: string) => (await zip.file(name)?.async("string")) ?? null;
  const workbookXml = await text("xl/workbook.xml");
  const relsXml = await text("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw new Error("Não foi possível ler a planilha: o arquivo XLSX está incompleto ou corrompido");

  // The first <sheet> of workbook.xml is the first tab; its r:id says which file holds it.
  const firstSheetTag = /<(?:\w+:)?sheet\s[^>]*>/.exec(workbookXml)?.[0] ?? "";
  const firstSheetRelId = attribute(firstSheetTag, "r:id");
  const relationship = (relsXml.match(/<(?:\w+:)?Relationship\s[^>]*>/g) ?? []).find((tag) => attribute(tag, "Id") === firstSheetRelId);
  const targetPath = relationship ? attribute(relationship, "Target") : null;
  const sheetPath = targetPath ? (targetPath.startsWith("/") ? targetPath.slice(1) : `xl/${targetPath}`) : null;
  const sheet = sheetPath ? zip.file(sheetPath) : null;
  if (!sheet) throw new Error("Não foi possível ler a planilha: a primeira aba não foi encontrada no arquivo XLSX");

  const ordered = new JSZip();
  const copy = (name: string, as = name) => {
    const file = zip.file(name);
    if (file) ordered.file(as, file.nodeStream());
  };
  copy("[Content_Types].xml");
  copy("_rels/.rels");
  copy("xl/_rels/workbook.xml.rels");
  copy("xl/workbook.xml");
  copy("xl/sharedStrings.xml");
  copy("xl/styles.xml");
  // Kept under the name the reader recognizes (sheetN.xml), whatever the file was called.
  const asName = /^xl\/worksheets\/sheet\d+\.xml$/.test(sheet.name) ? sheet.name : "xl/worksheets/sheet1.xml";
  ordered.file(asName, sheet.nodeStream());
  // ExcelJS only takes a Node Readable; JSZip's stream is its own kind — piped through one.
  const stream = new PassThrough();
  const generated = ordered.generateNodeStream({ streamFiles: true, compression: "STORE" });
  generated.on("error", (err) => stream.destroy(err));
  generated.pipe(stream);
  return { stream, hasSharedStrings: Boolean(zip.file("xl/sharedStrings.xml")) };
}

/** An XML attribute's value inside one tag (`name="value"`). */
function attribute(tag: string, name: string): string | null {
  const at = tag.indexOf(` ${name}="`);
  if (at < 0) return null;
  const start = at + name.length + 3;
  const end = tag.indexOf('"', start);
  return end < 0 ? null : tag.slice(start, end);
}

/** Read row by row (streaming): a 250k-row sheet loaded whole takes minutes and gigabytes. Only the first sheet. */
async function parseXlsx(buffer: Buffer, modifiedAt: Date | null): Promise<FetchedTable> {
  const { stream, hasSharedStrings } = await orderedXlsx(buffer);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, { sharedStrings: "cache", styles: "cache", hyperlinks: "ignore", worksheets: "emit" });
  // A file with no shared strings (all inline): without this the reader would park the sheet in a temp file.
  if (!hasSharedStrings) (reader as unknown as { sharedStrings: string[] }).sharedStrings = [];
  const records: string[][] = [];
  for await (const sheet of reader) {
    for await (const row of sheet) {
      const width = records[0]?.length ?? row.cellCount;
      const cells: string[] = [];
      for (let i = 1; i <= width; i++) {
        const cell = row.getCell(i);
        // Excel keeps only 15 digits of a number: a longer code (a 17-digit nosso número) pasted into a General
        // cell is already rounded in the file. Taken as is it would build a boleto with the wrong number.
        if (records.length > 0 && typeof cell.value === "number" && Math.abs(cell.value) >= EXCEL_SAFE_NUMBER) {
          throw new Error(
            `A coluna "${records[0][i - 1]}" tem números com mais de 15 dígitos gravados como número, e o Excel arredonda os últimos dígitos. No Excel, formate as colunas como Texto antes de colar os dados e envie a planilha de novo.`
          );
        }
        cells.push(cell.value instanceof Date ? stringify(cell.value) : (cell.text ?? ""));
      }
      records.push(cells);
      if (records.length > MAX_ROWS + 1) throw new Error(`A planilha tem mais de ${MAX_ROWS} linhas`);
    }
    break;
  }
  if (records.length === 0) throw new Error("A planilha está vazia");
  return toTable(records[0], records.slice(1), modifiedAt);
}

const isZip = (buffer: Buffer) => buffer.subarray(0, 2).toString("latin1") === "PK";
const isHtml = (buffer: Buffer) => /^\s*<(!doctype|html)/i.test(buffer.subarray(0, 200).toString("utf8"));
const TOO_BIG_UNPACKED = `O arquivo compactado passa de ${MAX_UNPACKED_BYTES / 1024 / 1024} MB depois de descompactado. Envie só os contratos e as colunas usados.`;

/**
 * A CSV/TXT/XLSX sent compressed — .gz, or a .zip with one of them inside — comes out as the file itself. An XLSX is
 * also a zip (with xl/workbook.xml): it is not unpacked here.
 */
async function unpack(buffer: Buffer): Promise<Buffer> {
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED_BYTES });
    } catch (err) {
      throw new Error((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? TOO_BIG_UNPACKED : "Não consegui descompactar o arquivo .gz");
    }
  }
  if (!isZip(buffer) || buffer.includes("xl/workbook.xml")) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const inside = Object.values(zip.files).filter((f) => !f.dir && !f.name.startsWith("__MACOSX") && /\.(csv|txt|xlsx)$/i.test(f.name));
  if (inside.length !== 1) throw new Error("O .zip precisa ter dentro um único arquivo CSV, TXT ou XLSX");
  const unpacked = await inside[0].async("nodebuffer");
  if (unpacked.length > MAX_UNPACKED_BYTES) throw new Error(TOO_BIG_UNPACKED);
  return unpacked;
}

/** CSV/TXT or XLSX, told apart by content (an XLSX is a zip: starts with "PK"), possibly inside a .zip or .gz. */
export async function parseSpreadsheet(packed: Buffer, modifiedAt: Date | null): Promise<FetchedTable> {
  const buffer = await unpack(packed);
  if (isZip(buffer)) return parseXlsx(buffer, modifiedAt);
  if (isHtml(buffer)) {
    throw new Error("O link abriu uma página, não a planilha. Confira se o compartilhamento está como \"Qualquer pessoa com o link\".");
  }
  return parseCsv(buffer, modifiedAt);
}

function encodeShareUrl(url: string): string {
  return `u!${Buffer.from(url).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-")}`;
}

/** The direct-download addresses to try for a shared link (OneDrive personal/business, Google Sheets or a file on Google Drive). */
export function downloadCandidates(link: string): string[] {
  const url = new URL(link);
  const google = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (google) {
    const gid = url.hash.match(/gid=(\d+)/)?.[1] ?? url.searchParams.get("gid");
    return [`https://docs.google.com/spreadsheets/d/${google[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`];
  }
  // A file uploaded to Google Drive (not converted to Google Planilhas). confirm=t skips the "can't scan for viruses"
  // page Google shows instead of a big file; the older address is the fallback.
  const driveFile = url.hostname === "drive.google.com" ? (url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get("id")) : null;
  if (driveFile) {
    return [`https://drive.usercontent.google.com/download?id=${driveFile}&export=download&confirm=t`, `https://drive.google.com/uc?export=download&id=${driveFile}`];
  }
  const withDownload = new URL(link);
  withDownload.searchParams.set("download", "1");
  if (/1drv\.ms|onedrive\.live\.com/.test(url.hostname)) {
    return [`https://api.onedrive.com/v1.0/shares/${encodeShareUrl(link)}/root/content`, withDownload.toString()];
  }
  return [withDownload.toString()];
}

/** Microsoft no longer lets anyone download from a new-style OneDrive share link (1drv.ms/x/c/…) without signing in. */
const ONEDRIVE_DENIED =
  'A Microsoft não permite mais baixar automaticamente planilhas pelo link de compartilhamento do OneDrive, mesmo com "Qualquer pessoa com o link". Use "Planilha privada (conta Microsoft)", um link do Google Planilhas ou "Enviar arquivo".';

/**
 * Google Drive's "can't scan this file for viruses" page: its form downloads the file anyway. The address it posts
 * to, with its hidden fields — or null for any other page.
 */
export function googleDownloadFormUrl(html: string): string | null {
  const form = /<form[^>]*id="download-form"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  const action = form && /action="([^"]+)"/i.exec(form[0])?.[1];
  if (!form || !action) return null;
  const url = new URL(action.replace(/&amp;/g, "&"));
  for (const input of form[1].matchAll(/<input[^>]*>/gi)) {
    const name = /name="([^"]+)"/i.exec(input[0])?.[1];
    const value = /value="([^"]*)"/i.exec(input[0])?.[1];
    if (name && value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Why a Google link brought a page instead of the file, and what to do. */
function googleHint(link: string): string {
  return /\/spreadsheets\//.test(link)
    ? 'O Google Planilhas não entregou a planilha. Confira o compartilhamento ("Qualquer pessoa com o link"). Se a planilha for grande, o Google Planilhas não exporta: coloque o arquivo CSV no Google Drive sem converter para Planilhas (de preferência compactado em .zip) e use o link do arquivo.'
    : 'O Google Drive não entregou o arquivo. Confira o compartilhamento ("Qualquer pessoa com o link"). Se o arquivo for grande, compacte o CSV em .zip: fica cerca de 10 vezes menor.';
}

async function download(url: string, isOneDrive: boolean): Promise<{ body: Buffer; modifiedAt: Date | null }> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    if (isOneDrive && (res.status === 401 || res.status === 403)) throw new Error(ONEDRIVE_DENIED);
    throw new Error(`O link respondeu ${res.status}. Confira se o compartilhamento está como "Qualquer pessoa com o link".`);
  }
  const modified = res.headers.get("last-modified");
  return { body: Buffer.from(await res.arrayBuffer()), modifiedAt: modified ? new Date(modified) : null };
}

export async function fetchFromLink(link: string): Promise<FetchedTable> {
  const host = new URL(link).hostname;
  const isOneDrive = /1drv\.ms|onedrive\.live\.com/.test(host);
  const isGoogle = /(^|\.)google\.com$/.test(host);
  let lastError: Error = new Error("Não foi possível baixar a planilha do link");
  for (const candidate of downloadCandidates(link)) {
    try {
      let { body, modifiedAt } = await download(candidate, isOneDrive);
      // Google's warning page instead of a big file: confirm the download, as the page's own button does.
      const confirmUrl = isGoogle && isHtml(body) ? googleDownloadFormUrl(body.toString("utf8")) : null;
      if (confirmUrl) ({ body, modifiedAt } = await download(confirmUrl, false));
      if (isGoogle && isHtml(body)) throw new Error(googleHint(link));
      return await parseSpreadsheet(body, modifiedAt);
    } catch (err) {
      const message = (err as Error).message;
      // Google answers an error code too (a sheet too big to export, a file not shared): say what to do.
      lastError = isGoogle && message.startsWith("O link respondeu") ? new Error(`${message.split(".")[0]}. ${googleHint(link)}`) : (err as Error);
    }
  }
  throw lastError;
}

// --- Microsoft (private OneDrive/SharePoint file) ---------------------------

export const MICROSOFT_SCOPE = "offline_access Files.Read.All User.Read";

export interface MicrosoftApp {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function microsoftAuthorizeUrl(app: MicrosoftApp, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    redirect_uri: app.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPE,
    state,
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/authorize?${params}`;
}

/** Exchanges an authorization code or a refresh token; Microsoft rotates the refresh token on every use. */
export async function microsoftToken(app: MicrosoftApp, grant: { code: string } | { refreshToken: string }) {
  const body = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, scope: MICROSOFT_SCOPE });
  if ("code" in grant) {
    body.set("grant_type", "authorization_code");
    body.set("code", grant.code);
  } else {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", grant.refreshToken);
  }
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`A conta Microsoft recusou o acesso: ${json.error_description?.split("\r\n")[0] ?? res.status}. Entre de novo com a conta Microsoft.`);
  return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null };
}

export async function fetchFromMicrosoft(shareUrl: string, accessToken: string): Promise<FetchedTable> {
  const base = `https://graph.microsoft.com/v1.0/shares/${encodeShareUrl(shareUrl)}/driveItem`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const meta = await fetch(base, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!meta.ok) throw new Error(`O arquivo não foi encontrado na conta Microsoft (${meta.status}). Confira o link e se a conta tem acesso a ele.`);
  const item = (await meta.json()) as { lastModifiedDateTime?: string };
  const content = await fetch(`${base}/content`, { headers, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!content.ok) throw new Error(`Não foi possível baixar o arquivo da conta Microsoft (${content.status})`);
  return parseSpreadsheet(Buffer.from(await content.arrayBuffer()), item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null);
}

// --- Database (read-only) ----------------------------------------------------

export interface DatabaseConfig {
  dialect: DataSourceDialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  query: string;
}

/** Only a single SELECT (or WITH … SELECT) — this integration never writes. */
export function assertReadOnlyQuery(query: string): void {
  const sql = query.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(sql) || sql.includes(";")) throw new Error("A consulta precisa ser um único SELECT");
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|into)\b/i.test(sql)) {
    throw new Error("A consulta só pode ler dados (SELECT), sem alterar nada");
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10).split("-").reverse().join("/");
  return String(value);
}

function rowsToTable(records: Record<string, unknown>[], columnNames: string[]): FetchedTable {
  return toTable(
    columnNames,
    records.map((r) => columnNames.map((c) => stringify(r[c]))),
    new Date()
  );
}

export async function fetchFromDatabase(config: DatabaseConfig): Promise<FetchedTable> {
  assertReadOnlyQuery(config.query);
  if (config.dialect === "sqlserver") {
    const mssql = await import("mssql");
    const pool = await new mssql.ConnectionPool({
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      requestTimeout: FETCH_TIMEOUT_MS,
      options: { encrypt: false, trustServerCertificate: true, readOnlyIntent: true },
    }).connect();
    try {
      const result = await pool.request().query(config.query);
      return rowsToTable(result.recordset, Object.keys(result.recordset.columns ?? {}));
    } finally {
      await pool.close();
    }
  }
  if (config.dialect === "postgres") {
    const { Client } = await import("pg");
    const client = new Client({ host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, statement_timeout: FETCH_TIMEOUT_MS });
    await client.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(config.query);
      await client.query("ROLLBACK");
      return rowsToTable(result.rows, result.fields.map((f) => f.name));
    } finally {
      await client.end();
    }
  }
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, connectTimeout: FETCH_TIMEOUT_MS });
  try {
    await connection.query("START TRANSACTION READ ONLY");
    const [rows, fields] = await connection.query({ sql: config.query, timeout: FETCH_TIMEOUT_MS });
    await connection.query("ROLLBACK");
    return rowsToTable(rows as Record<string, unknown>[], (fields as { name: string }[]).map((f) => f.name));
  } finally {
    await connection.end();
  }
}
