import { normalizeContactName } from "@whatsatendende/types";
import { Prisma, type DataSource, type Role } from "@prisma/client";
import {
  DATA_SOURCE_ROLES,
  PERMISSION,
  contractStatusOf,
  birthdayPersonKey,
  businessDay,
  daysUntilBirthday,
  parseBirthDate,
  type ContactBirthdayEntry,
  type ContactContractDTO,
  type ClientBeneficiaryDTO,
  type ClientContractDTO,
  type ClientDataDTO,
  type ClientParcelDTO,
  type DataSourceDTO,
  type DataSourceKind,
  type DataSourceRole,
  type DataSourceStatus,
  type DataTagRenderDTO,
  type DataTagsDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { isPermissionAllowed } from "../../lib/permissions";
import { phoneKey } from "../../lib/phone-key";
import { env } from "../../config/env";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { fetchFromDatabase, fetchFromLink, fetchFromMicrosoft, microsoftToken, parseSpreadsheet, type DatabaseConfig, type FetchedTable, type MicrosoftApp } from "./data-source-fetch";

const INSERT_CHUNK = 5_000;
const HOUR_MS = 3_600_000;
/** How long a button click waits for the read before answering "processando" (nginx gives up on a request after 60 s). */
const ANSWER_WITHIN_MS = 25_000;

/** Sources being read right now — a 500k-row sheet takes minutes. One process serves the API, so memory is enough. */
const syncing = new Map<string, Promise<DataSourceDTO>>();

type Secrets = { clientSecret?: string; refreshToken?: string; password?: string };
export type ColumnMap = Partial<Record<DataSourceRole, string>>;
export type Row = Record<string, string>;

export function readSecrets(source: Pick<DataSource, "secrets">): Secrets {
  return source.secrets ? (JSON.parse(decryptSecret(source.secrets)) as Secrets) : {};
}

export function writeSecrets(secrets: Secrets): string | null {
  const clean = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
  return Object.keys(clean).length ? encryptSecret(JSON.stringify(clean)) : null;
}

export function sourceStatus(source: DataSource, now = new Date()): DataSourceStatus {
  if (!source.active) return "INACTIVE";
  if (source.lastSyncError) return "ERROR";
  if (source.rowCount === 0 || !source.dataUpdatedAt) return "EMPTY";
  if (now.getTime() - source.dataUpdatedAt.getTime() > source.maxAgeHours * HOUR_MS) return "STALE";
  return "OK";
}

const STATUS_REASON: Record<Exclude<DataSourceStatus, "OK">, string> = {
  INACTIVE: "A fonte de dados está desativada.",
  ERROR: "A última atualização da fonte de dados deu erro.",
  EMPTY: "A fonte de dados ainda não trouxe nenhuma linha.",
  STALE: "Os dados passaram do prazo de atualização da fonte.",
};

export function toDataSourceDTO(source: DataSource): DataSourceDTO {
  const secrets = readSecrets(source);
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    active: source.active,
    status: sourceStatus(source),
    config: source.config as Record<string, string | number | null>,
    hasSecrets: source.kind === "MICROSOFT" ? Boolean(secrets.refreshToken) : Boolean(secrets.password),
    columnMap: source.columnMap as ColumnMap,
    sensitiveColumns: source.sensitiveColumns,
    overrideContactName: source.overrideContactName,
    maxAgeHours: source.maxAgeHours,
    refreshMinutes: source.refreshMinutes,
    columns: source.columns,
    rowCount: source.rowCount,
    dataUpdatedAt: source.dataUpdatedAt?.toISOString() ?? null,
    lastSyncAt: source.lastSyncAt?.toISOString() ?? null,
    lastSyncError: source.lastSyncError,
    syncing: syncing.has(source.id),
    allConnections: source.allConnections,
    connectionIds: source.connectionIds,
    bankLayouts: source.bankLayouts as Record<string, string>,
  };
}

// --- CRUD --------------------------------------------------------------------

export interface DataSourceInput {
  name: string;
  kind: DataSourceKind;
  config: Record<string, string | number | null>;
  /** Only the keys sent are replaced; an empty string keeps what's saved. */
  secrets?: Secrets;
  columnMap?: ColumnMap;
  sensitiveColumns?: string[];
  overrideContactName?: boolean;
  maxAgeHours?: number;
  refreshMinutes?: number;
  allConnections?: boolean;
  connectionIds?: string[];
  bankLayouts?: Record<string, string>;
}

export async function listDataSources(): Promise<DataSourceDTO[]> {
  return (await prisma.dataSource.findMany({ orderBy: { createdAt: "asc" } })).map(toDataSourceDTO);
}

export async function getDataSourceOrThrow(id: string) {
  const source = await prisma.dataSource.findUnique({ where: { id } });
  if (!source) throw Errors.notFound("Fonte de dados nao encontrada");
  return source;
}

export async function createDataSource(input: DataSourceInput): Promise<DataSourceDTO> {
  const source = await prisma.dataSource.create({
    data: {
      name: input.name,
      kind: input.kind,
      config: input.config,
      secrets: writeSecrets(input.secrets ?? {}),
      columnMap: input.columnMap ?? {},
      sensitiveColumns: input.sensitiveColumns ?? [DATA_SOURCE_ROLES.cpf.column],
      overrideContactName: input.overrideContactName ?? false,
      maxAgeHours: input.maxAgeHours ?? 24,
      refreshMinutes: input.refreshMinutes ?? 60,
      allConnections: input.allConnections ?? true,
      connectionIds: input.connectionIds ?? [],
      bankLayouts: input.bankLayouts ?? {},
    },
  });
  return toDataSourceDTO(source);
}

export async function updateDataSource(id: string, input: Partial<DataSourceInput>): Promise<DataSourceDTO> {
  const source = await getDataSourceOrThrow(id);
  if (source.active) {
    await assertConnectionsFree(id, input.allConnections ?? source.allConnections, input.connectionIds ?? source.connectionIds);
  }
  const secrets = input.secrets ? writeSecrets({ ...readSecrets(source), ...Object.fromEntries(Object.entries(input.secrets).filter(([, v]) => v)) }) : undefined;
  const updated = await prisma.dataSource.update({
    where: { id },
    data: {
      name: input.name,
      config: input.config,
      secrets,
      columnMap: input.columnMap,
      sensitiveColumns: input.sensitiveColumns,
      overrideContactName: input.overrideContactName,
      maxAgeHours: input.maxAgeHours,
      refreshMinutes: input.refreshMinutes,
      allConnections: input.allConnections,
      connectionIds: input.connectionIds,
      bankLayouts: input.bankLayouts,
    },
  });
  realtimeEvents.dataSourceStatusChanged();
  return toDataSourceDTO(updated);
}

/**
 * Several sources can be active, each for its connections: a connection belongs to at most one active source linked
 * to it, and only one active source takes "Todas as conexões" (every connection not linked to another one).
 */
async function assertConnectionsFree(id: string, allConnections: boolean, connectionIds: string[]) {
  const others = await prisma.dataSource.findMany({ where: { active: true, id: { not: id } }, select: { name: true, allConnections: true, connectionIds: true } });
  if (allConnections) {
    const all = others.find((o) => o.allConnections);
    if (all) throw Errors.conflict(`A fonte "${all.name}" já está ativa para todas as conexões. Escolha as conexões desta fonte ou desative a outra.`);
    return;
  }
  if (connectionIds.length === 0) throw Errors.badRequest("Escolha ao menos uma conexão para esta fonte");
  for (const other of others.filter((o) => !o.allConnections)) {
    const shared = other.connectionIds.filter((c) => connectionIds.includes(c));
    if (shared.length === 0) continue;
    const names = await prisma.whatsAppConnection.findMany({ where: { id: { in: shared } }, select: { name: true } });
    throw Errors.conflict(`${names.map((n) => `"${n.name}"`).join(", ")} já pertence à fonte "${other.name}": uma conexão só pode estar em uma fonte ativa.`);
  }
}

export async function setDataSourceActive(id: string, active: boolean): Promise<DataSourceDTO> {
  const source = await getDataSourceOrThrow(id);
  if (active) await assertConnectionsFree(id, source.allConnections, source.connectionIds);
  const updated = await prisma.dataSource.update({ where: { id }, data: { active } });
  realtimeEvents.dataSourceStatusChanged();
  return toDataSourceDTO(updated);
}

export async function deleteDataSource(id: string) {
  await getDataSourceOrThrow(id);
  await prisma.dataSource.delete({ where: { id } });
  realtimeEvents.dataSourceStatusChanged();
}

// --- Sync --------------------------------------------------------------------

export function microsoftApp(source: DataSource): MicrosoftApp {
  const config = source.config as Record<string, string>;
  const secrets = readSecrets(source);
  if (!config.clientId || !secrets.clientSecret) throw new Error("Preencha o ID do aplicativo e o segredo da Microsoft");
  return {
    tenantId: config.tenantId || "common",
    clientId: config.clientId,
    clientSecret: secrets.clientSecret,
    redirectUri: `${env.WEB_APP_URL.replace(/\/$/, "")}/api/data-sources/microsoft/callback`,
  };
}

async function fetchTable(source: DataSource): Promise<FetchedTable> {
  const config = source.config as Record<string, string>;
  if (source.kind === "LINK") {
    if (!config.url) throw new Error("Informe o link da planilha");
    return fetchFromLink(config.url);
  }
  if (source.kind === "MICROSOFT") {
    const secrets = readSecrets(source);
    if (!secrets.refreshToken) throw new Error("Entre com a conta Microsoft para ler o arquivo");
    const token = await microsoftToken(microsoftApp(source), { refreshToken: secrets.refreshToken });
    if (token.refreshToken) await prisma.dataSource.update({ where: { id: source.id }, data: { secrets: writeSecrets({ ...secrets, refreshToken: token.refreshToken }) } });
    return fetchFromMicrosoft(config.shareUrl, token.accessToken);
  }
  if (source.kind === "DATABASE") {
    return fetchFromDatabase({ ...(config as unknown as Omit<DatabaseConfig, "password">), port: Number(config.port), password: readSecrets(source).password ?? "" });
  }
  throw new Error("Envie o arquivo da planilha de novo para atualizar");
}

/** Fills the roles the source doesn't map yet with the columns of the same name (the WhatsAtendende script's names). */
function completeColumnMap(current: ColumnMap, columns: string[]): ColumnMap {
  const map: ColumnMap = { ...current };
  for (const [role, { column }] of Object.entries(DATA_SOURCE_ROLES) as [DataSourceRole, { column: string }][]) {
    if (!map[role] && columns.includes(column)) map[role] = column;
  }
  return map;
}

async function storeTable(source: DataSource, table: FetchedTable) {
  const columnMap = completeColumnMap(source.columnMap as ColumnMap, table.columns);
  // A sheet exported straight from the ERP names it its own way ("telefone", "celular", "fone_whatsapp"...).
  if (!columnMap.phone || !table.columns.includes(columnMap.phone)) columnMap.phone = table.columns.find((c) => /whats|celular|telefone|fone/.test(c));
  const phoneColumn = columnMap.phone;
  if (!phoneColumn) {
    // Keep the columns so Editar can offer them for "Telefone (WhatsApp)".
    await prisma.dataSource.update({ where: { id: source.id }, data: { columns: table.columns } });
    throw new Error("Não achei a coluna do telefone. Clique em Editar, escolha qual coluna é o telefone e envie o arquivo de novo.");
  }
  const rows = table.rows.flatMap((data, line) => {
    const key = phoneKey(data[phoneColumn]);
    return key ? [{ dataSourceId: source.id, phoneKey: key, line, data }] : [];
  });
  if (rows.length === 0) throw new Error("Nenhuma linha tem um telefone válido (55 + DDD + número)");
  await prisma.$transaction(
    async (tx) => {
      await tx.dataSourceRow.deleteMany({ where: { dataSourceId: source.id } });
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) await tx.dataSourceRow.createMany({ data: rows.slice(i, i + INSERT_CHUNK) });
      await tx.dataSource.update({
        where: { id: source.id },
        data: {
          columns: table.columns,
          columnMap,
          rowCount: rows.length,
          dataUpdatedAt: table.modifiedAt ?? new Date(),
          lastSyncAt: new Date(),
          lastSyncError: null,
        },
      });
    },
    { timeout: 300_000 }
  );
  // From the rows just read, not read back from the database: a big sheet would sit in memory twice.
  if (source.overrideContactName && columnMap.clientName) await overrideContactNames(rows, columnMap);
  if (columnMap.contract) await fillContactContracts(rows, columnMap);
  if (columnMap.beneficiaries) await fillContactBirthdays(rows, columnMap);
}

/** Contract numbers of a client as Contatos › Contrato keeps them. */
function contractNumbersOf(contracts: { number: string }[]): string | null {
  return contracts.map((c) => c.number).filter((n) => n !== "Sem contrato").join(", ") || null;
}

type StoredRow = { phoneKey: string; data: Row };

/**
 * Contatos › Contrato from the list, replaced at every upload: every contract of the phone (of every client on it),
 * with its status — green active, yellow suspended, red canceled with date and reason. A contact no longer in the
 * list loses the list's contracts; a number typed by hand in the client panel stays only while the list has none.
 */
async function fillContactContracts(rows: StoredRow[], columnMap: ColumnMap) {
  const byPhone = new Map<string, Map<string, ContactContractDTO>>();
  for (const row of rows) {
    const data = row.data as Row;
    const number = data[columnMap.contract!]?.trim();
    if (!number) continue;
    if (!byPhone.has(row.phoneKey)) byPhone.set(row.phoneKey, new Map());
    const contracts = byPhone.get(row.phoneKey)!;
    if (contracts.has(number)) continue;
    const status = contractStatusOf(columnMap.contractStatus ? data[columnMap.contractStatus] : null);
    contracts.set(number, {
      number,
      status,
      canceledAt: status === "CANCELED" ? (columnMap.cancelDate ? data[columnMap.cancelDate]?.trim() || null : null) : null,
      cancelReason: status === "CANCELED" ? (columnMap.cancelReason ? data[columnMap.cancelReason]?.trim() || null : null) : null,
    });
  }
  const contacts = await prisma.contact.findMany({ where: { phone: { not: null }, isGroup: false }, select: { id: true, phone: true, contracts: true, contractNumber: true } });
  for (const contact of contacts) {
    // Active first, then suspended, then canceled.
    const order = { ACTIVE: 0, SUSPENDED: 1, CANCELED: 2 } as const;
    const list = [...(byPhone.get(phoneKey(contact.phone) ?? "")?.values() ?? [])].sort((a, b) => (order[a.status ?? "ACTIVE"] ?? 0) - (order[b.status ?? "ACTIVE"] ?? 0));
    const contracts = list.length ? list : null;
    if (JSON.stringify(contracts) === JSON.stringify(contact.contracts ?? null)) continue;
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        contracts: contracts ? (contracts as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        ...(contracts && { contractNumber: contracts.map((c) => c.number).join(", ") }),
      },
    });
  }
}

/**
 * Aniversário do cliente: everyone of the phone's contracts with a birth date (the titular and the beneficiaries of the
 * "beneficiarios" column), replaced at every upload. Canceled contracts are left out — nobody is congratulated for them.
 */
async function fillContactBirthdays(rows: StoredRow[], columnMap: ColumnMap) {
  const byPhone = new Map<string, Map<string, ContactBirthdayEntry>>();
  for (const row of rows) {
    const data = row.data as Row;
    if (columnMap.contractStatus && contractStatusOf(data[columnMap.contractStatus]) === "CANCELED") continue;
    const contract = columnMap.contract ? data[columnMap.contract]?.trim() || null : null;
    for (const entry of (data[columnMap.beneficiaries!] ?? "").split(" | ")) {
      const [name, relation, birth] = entry.split(";").map((p) => p.trim());
      if (!name || !parseBirthDate(birth)) continue;
      if (!byPhone.has(row.phoneKey)) byPhone.set(row.phoneKey, new Map());
      const people = byPhone.get(row.phoneKey)!;
      const key = birthdayPersonKey(name);
      if (!people.has(key)) people.set(key, { name, relation: relation || null, birth, holder: relation?.toLowerCase() === "titular", contract });
    }
  }
  const contacts = await prisma.contact.findMany({ where: { phone: { not: null }, isGroup: false }, select: { id: true, phone: true, birthdays: true } });
  for (const contact of contacts) {
    const list = [...(byPhone.get(phoneKey(contact.phone) ?? "")?.values() ?? [])];
    const birthdays = list.length ? list : null;
    if (JSON.stringify(birthdays) === JSON.stringify(contact.birthdays ?? null)) continue;
    await prisma.contact.update({ where: { id: contact.id }, data: { birthdays: birthdays ? (birthdays as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  }
}

/** The client chosen in the panel: their contracts go to Contatos › Contrato when it is still empty. */
export async function rememberContractNumber(contact: { id: string; contractNumber: string | null }, data: ClientDataDTO) {
  const numbers = data.client ? contractNumbersOf(data.client.contracts) : null;
  if (contact.contractNumber || !numbers) return;
  await prisma.contact.update({ where: { id: contact.id }, data: { contractNumber: numbers } });
}

/** "O nome da planilha substitui o do contato" — only when the phone belongs to a single client. */
async function overrideContactNames(rows: StoredRow[], columnMap: ColumnMap) {
  const namesByPhone = new Map<string, Set<string>>();
  for (const row of rows) {
    const name = normalizeContactName((row.data as Row)[columnMap.clientName!]);
    if (!name) continue;
    if (!namesByPhone.has(row.phoneKey)) namesByPhone.set(row.phoneKey, new Set());
    namesByPhone.get(row.phoneKey)!.add(name);
  }
  const contacts = await prisma.contact.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true, name: true } });
  for (const contact of contacts) {
    const names = namesByPhone.get(phoneKey(contact.phone) ?? "");
    if (names?.size !== 1) continue;
    const [name] = names;
    if (contact.name !== name) await prisma.contact.update({ where: { id: contact.id }, data: { name } });
  }
}

async function alertDataSourceViewers(source: DataSource, error: string) {
  const roles: Role[] = ["AGENT", "MANAGER", "ADMIN"];
  const allowedRoles: Role[] = [];
  for (const role of roles) if (await isPermissionAllowed(role, PERMISSION.FONTES_DADOS_VER)) allowedRoles.push(role);
  const users = await prisma.user.findMany({ where: { role: { in: allowedRoles }, status: "ACTIVE" }, select: { id: true } });
  for (const user of users) {
    const notification = await createNotification({
      userId: user.id,
      type: "DATA_SOURCE_ERROR",
      title: `Fonte de dados "${source.name}" com erro`,
      body: `${error} Os atendentes estão vendo "Dados do cliente indisponíveis".`,
      entityType: "DataSource",
      entityId: source.id,
    });
    realtimeEvents.notificationCreated(user.id, toNotificationDTO(notification));
  }
}

/**
 * Reads the source again (or the uploaded file) and records the outcome. Never throws: the error is saved on the
 * source. A read already running for the source is joined, not repeated.
 */
export function syncDataSource(id: string, uploaded?: Buffer): Promise<DataSourceDTO> {
  const running = syncing.get(id);
  if (running) return running;
  const job = readAndStore(id, uploaded)
    .finally(() => syncing.delete(id))
    .then(async () => {
      realtimeEvents.dataSourceStatusChanged();
      return toDataSourceDTO(await getDataSourceOrThrow(id));
    });
  syncing.set(id, job);
  return job;
}

async function readAndStore(id: string, uploaded?: Buffer) {
  const source = await getDataSourceOrThrow(id);
  try {
    await storeTable(source, uploaded ? await parseSpreadsheet(uploaded, new Date()) : await fetchTable(source));
  } catch (err) {
    const message = (err as Error).message || "Erro desconhecido ao ler a fonte de dados";
    logger.warn({ err, dataSourceId: id }, "data source sync failed");
    await prisma.dataSource.update({ where: { id }, data: { lastSyncAt: new Date(), lastSyncError: message } });
    if (source.active && source.lastSyncError !== message) await alertDataSourceViewers(source, message);
  }
}

/** A click on Enviar arquivo / Atualizar agora / Ativa: the result if the read ends quickly, else the source marked "syncing". */
export async function startSync(id: string, uploaded?: Buffer): Promise<DataSourceDTO> {
  if (syncing.has(id)) throw Errors.conflict("Esta fonte ainda está sendo lida. Aguarde terminar.");
  const job = syncDataSource(id, uploaded);
  const answerAnyway = new Promise<null>((resolve) => setTimeout(() => resolve(null), ANSWER_WITHIN_MS).unref());
  return (await Promise.race([job, answerAnyway])) ?? toDataSourceDTO(await getDataSourceOrThrow(id));
}

/** Server timer: refreshes each active source when its interval is due (an uploaded file is only refreshed by a new upload). */
export async function syncDueDataSources(now = new Date()) {
  const sources = await prisma.dataSource.findMany({ where: { active: true, kind: { not: "UPLOAD" } } });
  for (const source of sources) {
    if (syncing.has(source.id)) continue;
    if (source.lastSyncAt && now.getTime() - source.lastSyncAt.getTime() < source.refreshMinutes * 60_000) continue;
    await syncDataSource(source.id);
  }
}

// --- Client data ---------------------------------------------------------------

/** The active source of a connection: the one linked to it, else the one for "Todas as conexões". */
export async function sourceForConnection(connectionId: string | null) {
  const linked = connectionId ? await prisma.dataSource.findFirst({ where: { active: true, allConnections: false, connectionIds: { has: connectionId } } }) : null;
  return linked ?? (await prisma.dataSource.findFirst({ where: { active: true, allConnections: true } }));
}

/** The conversation's source, when its data can be used right now. */
export async function usableSource(conversation: Pick<ConversationForData, "whatsappConnectionId">) {
  const source = await sourceForConnection(conversation.whatsappConnectionId);
  return source && sourceStatus(source) === "OK" ? source : null;
}

// Shown in the panel some other way (the contract's header, its boletos and beneficiaries) or only a rule for the
// system (parcelas para suspender): never as a plain line.
const PANEL_ROLES_SHOWN_ELSEWHERE: DataSourceRole[] = [
  "contract", "plan", "contractStatus", "cancelDate", "cancelReason", "beneficiaries", "suspensionThreshold", "document", "parcelDue", "daysLate", "parcelValue", "fine",
  "interest", "updatedValue", "paymentMethod", "boletoDue", "boletoValue", "ourNumber", "pixCode", "bankCode", "agency", "account", "agreement",
  "wallet", "walletVariation", "post", "payeeName", "payeeDocument",
];
// Bookkeeping columns of the spreadsheet script: the panel already shows the client chosen and the beneficiaries counted.
const PANEL_HIDDEN_COLUMN = /^(clientes_neste_telefone|(quantidade|qtd|qtde)_(de_)?beneficiarios|qr_code_boleto)$/;
// A contract's own columns go inside its card; the rest is about the person.
const CONTRACT_COLUMN = /contrato|plano|vencimento|parcela|atraso|adesao/;

function distinct(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())))];
}

function maskValue(value: string): string {
  return value.length <= 2 ? "••" : `${"•".repeat(Math.min(8, value.length - 2))}${value.slice(-2)}`;
}

function partialCpf(value: string | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 11) return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  if (digits.length === 14) return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/****-**`;
  return null;
}

export function parseBrDate(value: string | undefined): Date | null {
  const m = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

function ageOn(birth: Date, today: Date): number {
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

/**
 * "Nome;Parentesco;dd/mm/aaaa;Sim|Não" entries separated by " | " — the
 * titular first. Older files used "Nome (Parentesco) / Nome": still read,
 * just without age and agregado.
 */
export function parseBeneficiaries(value: string | undefined, today = new Date()): ClientBeneficiaryDTO[] {
  if (!value) return [];
  if (!value.includes(";")) {
    return value.split(" / ").map((entry) => {
      const m = entry.trim().match(/^(.*?)(?:\s*\(([^)]*)\))?$/);
      const relation = m?.[2]?.trim() || null;
      return { name: (m?.[1] ?? entry).trim(), relation, age: null, aggregated: false, holder: relation?.toLowerCase() === "titular" };
    });
  }
  return value.split(" | ").map((entry) => {
    const [name, relation, birth, aggregated] = entry.split(";").map((p) => p.trim());
    const birthDate = parseBrDate(birth);
    const day = businessDay(today, env.BUSINESS_TZ_OFFSET_MINUTES);
    return {
      name,
      relation: relation || null,
      age: birthDate ? ageOn(birthDate, today) : null,
      aggregated: /^s(im)?$/i.test(aggregated ?? ""),
      holder: relation?.toLowerCase() === "titular",
      birthday: birthDate ? birth.slice(0, 5) : null,
      daysUntilBirthday: birthDate ? daysUntilBirthday(birth, day) : null,
    };
  });
}

/** The ERP list can repeat the holder (as titular and as a beneficiary): each person once, the first mention kept. */
function uniqueBeneficiaries(list: ClientBeneficiaryDTO[]): ClientBeneficiaryDTO[] {
  const seen = new Set<string>();
  return list.filter((b) => {
    const key = b.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toInt(value: string | undefined): number {
  const n = parseInt((value ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export function buildContracts(rows: { id: string; data: Row }[], map: ColumnMap): ClientContractDTO[] {
  const col = (row: Row, role: DataSourceRole) => (map[role] ? row[map[role]!] : undefined);
  const groups = new Map<string, { id: string; data: Row }[]>();
  for (const row of rows) {
    const number = col(row.data, "contract") || "Sem contrato";
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number)!.push(row);
  }
  return [...groups.entries()].map(([number, group]) => {
    const first = group[0].data;
    const seen = new Set<string>();
    const parcels: ClientParcelDTO[] = [];
    for (const { id, data } of group) {
      const document = col(data, "document") || null;
      const due = col(data, "parcelDue") || null;
      if (!document && !due) continue;
      const key = `${document}|${due}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const daysLate = toInt(col(data, "daysLate"));
      parcels.push({
        id,
        document,
        due,
        daysLate,
        value: col(data, "parcelValue") || null,
        fine: col(data, "fine") || null,
        interest: col(data, "interest") || null,
        updatedValue: col(data, "updatedValue") || null,
        paymentMethod: col(data, "paymentMethod") || null,
        overdue: daysLate > 0,
      });
    }
    parcels.sort((a, b) => (parseBrDate(a.due ?? undefined)?.getTime() ?? 0) - (parseBrDate(b.due ?? undefined)?.getTime() ?? 0));
    const overdueCount = parcels.filter((p) => p.overdue).length;
    const threshold = toInt(col(first, "suspensionThreshold")) || null;
    const status = col(first, "contractStatus") || null;
    const canceled = contractStatusOf(status) === "CANCELED";
    return {
      number,
      plan: col(first, "plan") || null,
      status,
      overdueCount,
      suspensionThreshold: threshold,
      // The list says so ("Suspenso"), or the overdue parcels reached the ERP's limit.
      suspended: !canceled && (contractStatusOf(status) === "SUSPENDED" || (threshold !== null && overdueCount >= threshold)),
      canceledAt: canceled ? col(first, "cancelDate") || null : null,
      cancelReason: canceled ? col(first, "cancelReason") || null : null,
      beneficiaries: uniqueBeneficiaries(parseBeneficiaries(col(first, "beneficiaries"))),
      parcels,
      fields: [],
    };
  });
}

async function canViewSources(role: Role) {
  return role === "ADMIN" || isPermissionAllowed(role, PERMISSION.FONTES_DADOS_VER);
}

export interface ConversationForData {
  id: string;
  whatsappConnectionId: string | null;
  dataClientKey: string | null;
  dataSuspensionAckAt: Date | null;
  contact: { phone: string | null };
}

/** The rows of this conversation's phone grouped by client, and the client the conversation is about. */
export async function clientRows(source: DataSource, conversation: ConversationForData) {
  const map = source.columnMap as ColumnMap;
  const key = phoneKey(conversation.contact.phone);
  const rows = key ? await prisma.dataSourceRow.findMany({ where: { dataSourceId: source.id, phoneKey: key }, orderBy: { line: "asc" } }) : [];
  const byClient = new Map<string, { id: string; data: Row }[]>();
  for (const row of rows) {
    const data = row.data as Row;
    const clientKey = (map.clientKey && data[map.clientKey]) || (map.clientName && data[map.clientName]) || "1";
    if (!byClient.has(clientKey)) byClient.set(clientKey, []);
    byClient.get(clientKey)!.push({ id: row.id, data });
  }
  const selectedKey = byClient.size === 1 ? [...byClient.keys()][0] : conversation.dataClientKey && byClient.has(conversation.dataClientKey) ? conversation.dataClientKey : null;
  return { map, byClient, selectedKey };
}

export async function getClientData(conversation: ConversationForData, role: Role): Promise<ClientDataDTO> {
  const empty: ClientDataDTO = { status: "NO_SOURCE", reason: null, dataUpdatedAt: null, clients: [], selectedClientKey: null, client: null, suspensionWarningPending: false };
  const source = await sourceForConnection(conversation.whatsappConnectionId);
  if (!source) return empty;
  const status = sourceStatus(source);
  const dataUpdatedAt = source.dataUpdatedAt?.toISOString() ?? null;
  if (status !== "OK") {
    const reason = (await canViewSources(role)) ? (source.lastSyncError ?? STATUS_REASON[status]) : null;
    return { ...empty, status: "UNAVAILABLE", reason, dataUpdatedAt };
  }
  const { map, byClient, selectedKey } = await clientRows(source, conversation);
  if (byClient.size === 0) return { ...empty, status: "NOT_FOUND", dataUpdatedAt };
  const clients = [...byClient.entries()].map(([key, rows]) => ({
    key,
    name: (map.clientName && rows[0].data[map.clientName]) || key,
    cpfPartial: partialCpf(map.cpf ? rows[0].data[map.cpf] : undefined),
  }));
  if (!selectedKey) return { ...empty, status: "OK", dataUpdatedAt, clients };

  const rows = byClient.get(selectedKey)!;
  const shownElsewhere = new Set(PANEL_ROLES_SHOWN_ELSEWHERE.map((role) => map[role]).filter(Boolean));
  const shown = source.columns.filter((column) => !shownElsewhere.has(column) && !PANEL_HIDDEN_COLUMN.test(column));
  const toField = (column: string, from: { data: Row }[]) => {
    const value = distinct(from.map((r) => r.data[column])).join(", ");
    const sensitive = source.sensitiveColumns.includes(column);
    return { column, value: sensitive && value ? maskValue(value) : value, sensitive };
  };
  const fields = shown.filter((column) => !CONTRACT_COLUMN.test(column)).map((column) => toField(column, rows));
  const contractColumns = shown.filter((column) => CONTRACT_COLUMN.test(column));
  const contractOf = (row: { data: Row }) => (map.contract ? row.data[map.contract] : undefined) || "Sem contrato";
  const contracts = buildContracts(rows, map).map((contract) => ({
    ...contract,
    fields: contractColumns.map((column) => toField(column, rows.filter((r) => contractOf(r) === contract.number))),
  }));
  return {
    status: "OK",
    reason: null,
    dataUpdatedAt,
    clients: byClient.size > 1 ? clients : [],
    selectedClientKey: selectedKey,
    client: { key: selectedKey, name: (map.clientName && rows[0].data[map.clientName]) || null, fields, contracts },
    suspensionWarningPending: contracts.some((c) => c.suspended) && !conversation.dataSuspensionAckAt,
  };
}

export async function selectClient(conversation: ConversationForData, clientKey: string) {
  const source = await usableSource(conversation);
  if (!source) throw Errors.badRequest("Dados do cliente indisponíveis no momento");
  const { byClient } = await clientRows(source, conversation);
  if (!byClient.has(clientKey)) throw Errors.badRequest("Cliente não encontrado para este telefone");
  await prisma.conversation.update({ where: { id: conversation.id }, data: { dataClientKey: clientKey } });
}

/** The real value of a sensitive column (the caller audits it). */
export async function revealColumn(conversation: ConversationForData, column: string): Promise<string> {
  const source = await usableSource(conversation);
  if (!source) throw Errors.badRequest("Dados do cliente indisponíveis no momento");
  if (!source.sensitiveColumns.includes(column)) throw Errors.badRequest("Esta coluna não é sensível");
  const { byClient, selectedKey } = await clientRows(source, conversation);
  if (!selectedKey) throw Errors.badRequest("Escolha o cliente primeiro");
  return distinct(byClient.get(selectedKey)!.map((r) => r.data[column])).join(", ");
}

export async function acknowledgeSuspension(conversationId: string) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { dataSuspensionAckAt: new Date() } });
}

// --- Tags ----------------------------------------------------------------------

const TAG_PATTERN = /\{\{\s*dados\.([a-z0-9_]+)\s*\}\}/g;

export function hasDataTags(text: string): boolean {
  return /\{\{\s*dados\./.test(text);
}

/** The columns "{{" offers: the conversation's source, or every usable source when there's no conversation. */
export async function availableTags(conversation: Pick<ConversationForData, "whatsappConnectionId"> | null): Promise<DataTagsDTO> {
  if (conversation) {
    const source = await usableSource(conversation);
    return source ? { available: true, columns: source.columns } : { available: false, columns: [] };
  }
  const sources = (await prisma.dataSource.findMany({ where: { active: true } })).filter((s) => sourceStatus(s) === "OK");
  return { available: sources.length > 0, columns: distinct(sources.flatMap((s) => s.columns)) };
}

/**
 * Fills {{dados.coluna}} for this conversation's client. Any tag without a
 * value (or a sensitive one the person can't send) comes back in `missing`:
 * the message must not be sent with it.
 */
export async function renderDataTags(conversation: ConversationForData, text: string, role: Role): Promise<DataTagRenderDTO> {
  const tags = [...text.matchAll(TAG_PATTERN)].map((m) => m[1]);
  if (tags.length === 0) return { text, missing: [] };
  const source = await usableSource(conversation);
  if (!source) return { text, missing: distinct(tags) };
  const { byClient, selectedKey } = await clientRows(source, conversation);
  const rows = selectedKey ? byClient.get(selectedKey)! : [];
  const canSendSensitive = role === "ADMIN" || (await isPermissionAllowed(role, PERMISSION.CLIENTE_DADOS_SENSIVEIS_VER));
  const missing = new Set<string>();
  const rendered = text.replace(TAG_PATTERN, (match, column: string) => {
    const value = distinct(rows.map((r) => r.data[column])).join(", ");
    if (!value || (source.sensitiveColumns.includes(column) && !canSendSensitive)) {
      missing.add(column);
      return match;
    }
    return value;
  });
  return { text: rendered, missing: [...missing] };
}

/** Send-time lock: refuses a text whose tags can't all be filled for this client. */
export async function fillDataTagsOrThrow(conversation: ConversationForData, text: string, role: Role): Promise<string> {
  if (!hasDataTags(text)) return text;
  const result = await renderDataTags(conversation, text, role);
  if (result.missing.length > 0) {
    throw Errors.badRequest(
      `Não encontramos ${result.missing.map((m) => `*${m}*`).join(", ")} para este cliente na fonte de dados — a mensagem não pode ser enviada`,
      { missingTags: result.missing }
    );
  }
  return result.text;
}

