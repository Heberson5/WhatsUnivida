import { randomUUID } from "node:crypto";
import { normalizeContactName } from "@whatsatendende/types";
import { contactContractsOf } from "../../lib/contact-contracts";
import type { Prisma } from "@prisma/client";
import { COLUMN_SCREENS, DEFAULT_PHONE_SETTINGS, brazilianPhoneVariants, normalizeTypedPhone } from "@whatsatendende/types";
import type {
  ContactDetailDTO,
  ContactImportResultDTO,
  ContactListItemDTO,
  ContactSortField,
  ManagedTagDTO,
  NameStandardizationLastBatchDTO,
  NameStandardizationPreviewItemDTO,
  PhoneSettingsDTO,
  TagDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { toTagDTO } from "../client-panel/client-panel.service";
import { realtimeEvents } from "../../realtime/realtime";
import { getPhoneSettings } from "../phone-numbers/phone-settings.service";

/**
 * Tela de Contatos: search, tags, history, CSV import/export — plus the
 * tag management (rename, color, delete) shared with the client panel.
 * `connectionIds` follows resolveAllowedConnectionIds: undefined = every
 * contact (ADMIN), an array = only contacts of those WhatsApp connections.
 */

export interface ContactFilters {
  search?: string;
  tagId?: string;
  connectionIds?: string[];
}

const IMPORT_MAX_ROWS = 5000;

const listInclude = {
  whatsappConnection: { select: { name: true } },
  metaConnection: { select: { name: true } },
  tags: { include: { tag: true }, orderBy: { createdAt: "asc" as const } },
  _count: { select: { conversations: true } },
} satisfies Prisma.ContactInclude;

type ContactRow = Prisma.ContactGetPayload<{ include: typeof listInclude }>;

function toListItem(row: ContactRow): ContactListItemDTO {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    channel: row.channel,
    connectionName: row.whatsappConnection?.name ?? row.metaConnection?.name ?? null,
    whatsappConnectionId: row.whatsappConnectionId,
    contractNumber: row.contractNumber,
    contracts: contactContractsOf(row.contracts),
    firstName: row.firstName,
    tags: row.tags.map((t) => toTagDTO(t.tag)),
    conversationCount: row._count.conversations,
    firstConversationAt: row.firstConversationAt.toISOString(),
    lastInteractionAt: row.lastInteractionAt.toISOString(),
  };
}

function buildWhere(filters: ContactFilters): Prisma.ContactWhereInput {
  const search = filters.search?.trim();
  const digits = search?.replace(/\D/g, "");
  return {
    // WhatsApp groups are not contacts: they live in Atendimento's Grupos tab.
    isGroup: false,
    ...(filters.connectionIds && { whatsappConnectionId: { in: filters.connectionIds } }),
    ...(filters.tagId && { tags: { some: { tagId: filters.tagId } } }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { contractNumber: { contains: search, mode: "insensitive" as const } },
        ...(digits ? [{ phone: { contains: digits } }] : []),
      ],
    }),
  };
}

export interface ContactSort {
  field: ContactSortField;
  dir: "asc" | "desc";
}

/** The ORDER BY of a column; ties (same name, same date...) always fall back to the most recent interaction, then the id. */
function orderByFor({ field, dir }: ContactSort): Prisma.ContactOrderByWithRelationInput[] {
  // name, contract and connection are ordered in Portuguese by listContactsByText.
  const primary: Prisma.ContactOrderByWithRelationInput = {
    phone: { phone: { sort: dir, nulls: "last" as const } },
    conversations: { conversations: { _count: dir } },
    firstConversationAt: { firstConversationAt: dir },
    lastInteractionAt: { lastInteractionAt: dir },
  }[field as Exclude<ContactSortField, TextSortField>];
  return [primary, ...(field === "lastInteractionAt" ? [] : [{ lastInteractionAt: "desc" as const }]), { id: "asc" }];
}

// Names in Portuguese order: "ana" with "Ana", "Álvaro" before "Bruno" — the database's own collation
// (C on the server's Postgres image) would put every capital first and every accent after "z".
const ptCollator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

type TextSortField = "name" | "contract" | "connection";
const TEXT_SORT_FIELDS: ContactSortField[] = ["name", "contract", "connection"];

/** One page of contacts ordered by a text column (name, contract, connection) in Portuguese order; contacts with no value go last. */
async function listContactsByText(where: Prisma.ContactWhereInput, page: number, pageSize: number, sort: ContactSort) {
  const keys = await prisma.contact.findMany({
    where,
    select: {
      id: true,
      name: true,
      contractNumber: true,
      lastInteractionAt: true,
      whatsappConnection: { select: { name: true } },
      metaConnection: { select: { name: true } },
    },
  });
  const text = (k: (typeof keys)[number]) =>
    (sort.field === "name" ? k.name : sort.field === "contract" ? k.contractNumber : (k.whatsappConnection?.name ?? k.metaConnection?.name ?? null))?.trim() || null;
  const sign = sort.dir === "asc" ? 1 : -1;
  keys.sort((a, b) => {
    const ta = text(a);
    const tb = text(b);
    if (ta === null || tb === null) return ta === tb ? 0 : ta === null ? 1 : -1;
    return sign * ptCollator.compare(ta, tb) || b.lastInteractionAt.getTime() - a.lastInteractionAt.getTime() || a.id.localeCompare(b.id);
  });
  const ids = keys.slice((page - 1) * pageSize, page * pageSize).map((k) => k.id);
  const rows = await prisma.contact.findMany({ where: { id: { in: ids } }, include: listInclude });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { items: ids.map((id) => toListItem(byId.get(id)!)), total: keys.length };
}

export async function listContacts(filters: ContactFilters, page: number, pageSize: number, sort: ContactSort = { field: "lastInteractionAt", dir: "desc" }) {
  const where = buildWhere(filters);
  if (TEXT_SORT_FIELDS.includes(sort.field)) return listContactsByText(where, page, pageSize, sort);
  const [rows, total] = await Promise.all([
    prisma.contact.findMany({ where, include: listInclude, orderBy: orderByFor(sort), skip: (page - 1) * pageSize, take: pageSize }),
    prisma.contact.count({ where }),
  ]);
  return { items: rows.map(toListItem), total };
}

/** Throws 404 when the contact doesn't exist or sits on a connection this user can't see. */
export async function getContactOrThrow(id: string, connectionIds: string[] | undefined) {
  const row = await prisma.contact.findFirst({ where: { id, ...(connectionIds && { whatsappConnectionId: { in: connectionIds } }) }, include: listInclude });
  if (!row) throw Errors.notFound("Contato não encontrado");
  return row;
}

export async function getContactDetail(id: string, connectionIds: string[] | undefined): Promise<ContactDetailDTO> {
  const row = await getContactOrThrow(id, connectionIds);
  const conversations = await prisma.conversation.findMany({
    where: { contactId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      closedAt: true,
      assignedAgent: { select: { displayName: true } },
      satisfactionSurvey: { select: { score: true, questionId: true } },
      _count: { select: { messages: true } },
    },
  });
  return {
    ...toListItem(row),
    conversations: conversations.map((c) => ({
      id: c.id,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
      closedAt: c.closedAt?.toISOString() ?? null,
      agentName: c.assignedAgent?.displayName ?? null,
      messageCount: c._count.messages,
      satisfactionScore: c.satisfactionSurvey?.score ?? null,
      // Surveys without a question were answered on the old 1–5 scale.
      satisfactionScoreMax: c.satisfactionSurvey?.score == null ? null : c.satisfactionSurvey.questionId ? 10 : 5,
    })),
  };
}

export async function updateContact(id: string, input: { name?: string; firstName?: string | null; tagIds?: string[] }, userId: string) {
  if (input.tagIds) {
    const count = await prisma.tag.count({ where: { id: { in: input.tagIds } } });
    if (count !== new Set(input.tagIds).size) throw Errors.badRequest("Uma ou mais etiquetas são inválidas");
  }
  await prisma.$transaction([
    ...(input.name !== undefined ? [prisma.contact.update({ where: { id }, data: { name: input.name } })] : []),
    ...(input.firstName !== undefined ? [prisma.contact.update({ where: { id }, data: { firstName: input.firstName?.trim() || null } })] : []),
    ...(input.tagIds
      ? [
          prisma.contactTag.deleteMany({ where: { contactId: id, tagId: { notIn: input.tagIds } } }),
          prisma.contactTag.createMany({ data: input.tagIds.map((tagId) => ({ contactId: id, tagId, addedById: userId })), skipDuplicates: true }),
        ]
      : []),
  ]);
  if (input.tagIds) realtimeEvents.contactTagsChanged();
}

// --- CSV ---

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type ExportRow = Prisma.ContactGetPayload<{ include: typeof listInclude }>;

const EXPORT_CELLS: Record<string, (row: ExportRow, item: ContactListItemDTO) => unknown> = {
  name: (_r, item) => item.name,
  phone: (_r, item) => item.phone,
  contract: (_r, item) => item.contractNumber,
  firstName: (_r, item) => item.firstName,
  connection: (_r, item) => item.connectionName,
  tags: (_r, item) => item.tags.map((t) => t.name).join(", "),
  conversations: (_r, item) => item.conversationCount,
  firstConversationAt: (r) => r.firstConversationAt.toISOString().slice(0, 10),
  lastInteractionAt: (r) => r.lastInteractionAt.toISOString().slice(0, 10),
};

/**
 * Semicolon-separated (opens straight in Excel pt-BR), with a BOM so accents survive.
 * `columns` are the keys visible in the user's column view, in their order.
 */
export async function exportContactsCsv(filters: ContactFilters, columns: string[]): Promise<string> {
  const rows = await prisma.contact.findMany({ where: buildWhere(filters), include: listInclude, orderBy: { name: "asc" } });
  const labels = new Map(COLUMN_SCREENS.contatos.columns.map((c) => [c.key, c.label]));
  const header = columns.map((key) => labels.get(key));
  const lines = rows.map((r) => {
    const item = toListItem(r);
    return columns
      .map((key) => EXPORT_CELLS[key](r, item))
      .map(csvEscape)
      .join(";");
  });
  return "\uFEFF" + [header.join(";"), ...lines].join("\r\n");
}

/** Splits one CSV line on `delimiter`, honoring "quoted, values" and "" escapes. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

/**
 * A phone from the spreadsheet, as the number to save: Configurações › Números
 * de telefone applies (DDI padrão, 9 a mais), like a number typed in Nova
 * conversa. There is no WhatsApp to ask here, so a Brazilian mobile is saved in
 * the form its DDD usually has (see normalizeTypedPhone).
 */
export function normalizeImportPhone(raw: string, settings: PhoneSettingsDTO = DEFAULT_PHONE_SETTINGS): string | null {
  const { phone } = normalizeTypedPhone(raw, settings);
  return phone.length >= 12 && phone.length <= 15 ? phone : null;
}

const normalizeHeader = (h: string) => h.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * Columns (any order, header row required): Nome, Telefone, Etiquetas
 * (several separated by ","). A phone already on the connection — in either form of a Brazilian mobile — is not
 * duplicated and keeps its name (the planilha only names one that has none), getting just the tags; a new one is
 * created. Lines with problems are skipped and reported back.
 */
export async function importContactsCsv(csv: string, whatsappConnectionId: string, userId: string): Promise<ContactImportResultDTO> {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw Errors.badRequest("A planilha precisa ter o cabeçalho e pelo menos um contato");
  if (lines.length - 1 > IMPORT_MAX_ROWS) throw Errors.badRequest(`Importe no máximo ${IMPORT_MAX_ROWS} contatos por vez`);

  const delimiter = lines[0].includes(";") ? ";" : ",";
  const header = splitCsvLine(lines[0], delimiter).map(normalizeHeader);
  const col = { name: header.indexOf("nome"), phone: header.indexOf("telefone"), tags: header.indexOf("etiquetas") };
  if (col.phone === -1) throw Errors.badRequest('A planilha precisa de uma coluna "Telefone"');

  const result: ContactImportResultDTO = { created: 0, existing: 0, errors: [] };
  // Only tags already in Automação › Etiquetas — an unknown name is reported, never created.
  const tagsByName = new Map((await prisma.tag.findMany()).map((t) => [t.name.toLowerCase(), t]));
  const phoneSettings = await getPhoneSettings();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const phone = normalizeImportPhone(cells[col.phone] ?? "", phoneSettings);
    if (!phone) {
      result.errors.push({ line: i + 1, reason: `Telefone inválido: "${cells[col.phone] ?? ""}"` });
      continue;
    }
    const name = col.name === -1 ? "" : (normalizeContactName(cells[col.name] ?? "") ?? "").slice(0, 120);
    const tagNames = col.tags === -1 ? [] : (cells[col.tags] ?? "").split(",").map((t) => t.trim().slice(0, 40)).filter(Boolean);

    // The same customer saved under the other form of a mobile (with/without the 9) is the same contact.
    const saved = await prisma.contact.findMany({ where: { whatsappConnectionId, phone: { in: brazilianPhoneVariants(phone) } } });
    const existing = saved.find((c) => c.phone === phone) ?? saved[0] ?? null;
    const contact = existing
      ? existing.name || !name
        ? existing
        : await prisma.contact.update({ where: { id: existing.id }, data: { name } })
      : await prisma.contact.create({ data: { channel: "WHATSAPP", phone, whatsappConnectionId, name: name || null } });
    if (existing) result.existing++;
    else result.created++;

    for (const tagName of tagNames) {
      const tag = tagsByName.get(tagName.toLowerCase());
      if (!tag) {
        result.errors.push({ line: i + 1, reason: `Etiqueta "${tagName}" não está cadastrada em Automação › Etiquetas` });
        continue;
      }
      await prisma.contactTag.upsert({
        where: { contactId_tagId: { contactId: contact.id, tagId: tag.id } },
        update: {},
        create: { contactId: contact.id, tagId: tag.id, addedById: userId },
      });
    }
  }
  realtimeEvents.contactTagsChanged();
  return result;
}

// --- Etiquetas ---

export async function listManagedTags(): Promise<ManagedTagDTO[]> {
  const tags = await prisma.tag.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { contacts: true } } } });
  return tags.map((t) => ({ ...toTagDTO(t), contactCount: t._count.contacts }));
}

async function assertTagNameFree(name: string, excludeId?: string) {
  const clash = await prisma.tag.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(excludeId && { id: { not: excludeId } }) } });
  if (clash) throw Errors.conflict(`Já existe a etiqueta "${clash.name}"`);
}

type TagInput = { name: string; color: string; blockedAutoMessages?: string[]; queueUserIds?: string[] };

/** "Atendida por" only names users who attend (active or not — someone inactive just never counts as online). */
async function assertQueueUsers(userIds: string[] | undefined) {
  if (!userIds?.length) return;
  const found = await prisma.user.count({ where: { id: { in: userIds }, role: { in: ["AGENT", "MANAGER", "ADMIN"] } } });
  if (found !== userIds.length) throw Errors.badRequest("Usuário inválido em Atendida por");
}

export async function createTag(input: TagInput): Promise<TagDTO> {
  await assertTagNameFree(input.name);
  await assertQueueUsers(input.queueUserIds);
  return toTagDTO(await prisma.tag.create({ data: input }));
}

export async function updateTag(id: string, input: Partial<TagInput>): Promise<TagDTO> {
  const tag = await prisma.tag.findUnique({ where: { id } });
  if (!tag) throw Errors.notFound("Etiqueta não encontrada");
  if (input.name) await assertTagNameFree(input.name, id);
  await assertQueueUsers(input.queueUserIds);
  const updated = toTagDTO(await prisma.tag.update({ where: { id }, data: input }));
  realtimeEvents.contactTagsChanged();
  return updated;
}

export async function deleteTag(id: string): Promise<void> {
  const tag = await prisma.tag.findUnique({ where: { id } });
  if (!tag) throw Errors.notFound("Etiqueta não encontrada");
  await prisma.tag.delete({ where: { id } });
  realtimeEvents.contactTagsChanged();
}

// --- Contatos › Padronizar nomes ---

/** The contacts whose name would change with the standard (normalizeContactName) — groups and Meta ids left out. */
export async function previewNameStandardization(): Promise<NameStandardizationPreviewItemDTO[]> {
  const contacts = await prisma.contact.findMany({ where: { isGroup: false, name: { not: null } }, select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } });
  return contacts.flatMap((c) => {
    const proposed = normalizeContactName(c.name);
    return proposed && proposed !== c.name ? [{ contactId: c.id, phone: c.phone, current: c.name!, proposed }] : [];
  });
}

export async function lastNameStandardization(): Promise<NameStandardizationLastBatchDTO | null> {
  const last = await prisma.contactNameChange.findFirst({ orderBy: { createdAt: "desc" }, select: { batchId: true, createdAt: true } });
  if (!last) return null;
  const [count, undone] = await Promise.all([
    prisma.contactNameChange.count({ where: { batchId: last.batchId } }),
    prisma.contactNameChange.count({ where: { batchId: last.batchId, undoneAt: { not: null } } }),
  ]);
  return { batchId: last.batchId, count, at: last.createdAt.toISOString(), undone: undone > 0 };
}

/** Applies the standard to the chosen contacts; each old name is kept so the whole apply can be undone. */
export async function applyNameStandardization(contactIds: string[]): Promise<{ batchId: string; count: number }> {
  const batchId = randomUUID();
  const contacts = await prisma.contact.findMany({ where: { id: { in: contactIds }, isGroup: false }, select: { id: true, name: true } });
  let count = 0;
  for (const c of contacts) {
    const proposed = normalizeContactName(c.name);
    if (!proposed || proposed === c.name) continue;
    await prisma.$transaction([
      prisma.contact.update({ where: { id: c.id }, data: { name: proposed } }),
      prisma.contactNameChange.create({ data: { batchId, contactId: c.id, oldName: c.name, newName: proposed } }),
    ]);
    count++;
  }
  return { batchId, count };
}

/** "Desfazer": puts back the names of an apply — except a name someone changed again since then. */
export async function undoNameStandardization(batchId: string): Promise<{ count: number }> {
  const changes = await prisma.contactNameChange.findMany({ where: { batchId, undoneAt: null }, include: { contact: { select: { name: true } } } });
  if (changes.length === 0) throw Errors.notFound("Nada para desfazer");
  let count = 0;
  const now = new Date();
  for (const change of changes) {
    if (change.contact.name === change.newName) {
      await prisma.contact.update({ where: { id: change.contactId }, data: { name: change.oldName } });
      count++;
    }
    await prisma.contactNameChange.update({ where: { id: change.id }, data: { undoneAt: now } });
  }
  return { count };
}
