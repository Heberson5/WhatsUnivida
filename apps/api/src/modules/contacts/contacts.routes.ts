import { Router, type Request } from "express";
import { z } from "zod";
import { AUTO_MESSAGE_KINDS, COLUMN_SCREENS, CONTACT_SORT_FIELDS, PERMISSION, mergeColumnView } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { isPermissionAllowed, requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { parseListParam } from "../../lib/parse-list-param";
import { resolveAllowedConnectionIds } from "../../lib/connection-access";
import * as service from "./contacts.service";

export const contactsRouter = Router();
contactsRouter.use(requireAuth, requirePermission(PERMISSION.CONTATOS_ACESSAR));

const IMPORT_MAX_CSV_CHARS = 1_500_000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** An AGENT (if ever granted Contatos) sees only their own connection; a MANAGER the ones they manage; an ADMIN everything. */
async function visibleConnectionIds(req: Request, requested?: string[]): Promise<string[] | undefined> {
  if (req.auth!.role === "AGENT") {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { whatsappConnectionId: true } });
    return user?.whatsappConnectionId ? [user.whatsappConnectionId] : [];
  }
  return resolveAllowedConnectionIds(req.auth!, requested);
}

const filtersSchema = z.object({
  search: z.string().trim().max(120).optional(),
  tagId: z.string().uuid().optional(),
  connectionId: z.union([z.string(), z.array(z.string())]).optional(),
});

async function parseFilters(req: Request): Promise<service.ContactFilters> {
  const query = filtersSchema.parse(req.query);
  return { search: query.search, tagId: query.tagId, connectionIds: await visibleConnectionIds(req, parseListParam(query.connectionId)) };
}

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(CONTACT_SORT_FIELDS).default("lastInteractionAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

contactsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, sort, dir } = pageSchema.parse(req.query);
    res.json(await service.listContacts(await parseFilters(req), page, pageSize, { field: sort, dir }));
  })
);

const CONTACT_COLUMN_KEYS = COLUMN_SCREENS.contatos.columns.map((c) => c.key);
// What the screen shows with no saved view: every column except those that start hidden (Primeiro nome).
const DEFAULT_EXPORT_KEYS = mergeColumnView("contatos", null)
  .filter((c) => c.visible)
  .map((c) => c.key);

// The keys visible in the user's column view, comma-separated, in their order; the default columns when absent.
const exportColumnsSchema = z.object({
  columns: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : DEFAULT_EXPORT_KEYS))
    .pipe(z.array(z.enum(CONTACT_COLUMN_KEYS as [string, ...string[]])).min(1)),
});

contactsRouter.get(
  "/export",
  requirePermission(PERMISSION.CONTATOS_IMPORTAR_EXPORTAR),
  asyncHandler(async (req, res) => {
    const { columns } = exportColumnsSchema.parse(req.query);
    const csv = await service.exportContactsCsv(await parseFilters(req), columns);
    await writeAudit({ userId: req.auth!.userId, action: "CONTACTS_EXPORTED", entity: "Contact", entityId: null, ipAddress: req.ip ?? null });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="contatos.csv"');
    res.send(csv);
  })
);

const importSchema = z.object({ whatsappConnectionId: z.string().uuid(), csv: z.string().min(1).max(IMPORT_MAX_CSV_CHARS) });

contactsRouter.post(
  "/import",
  requirePermission(PERMISSION.CONTATOS_IMPORTAR_EXPORTAR),
  asyncHandler(async (req, res) => {
    const input = importSchema.parse(req.body);
    const allowed = await visibleConnectionIds(req, [input.whatsappConnectionId]);
    if (allowed && !allowed.includes(input.whatsappConnectionId)) throw Errors.forbidden();
    const connection = await prisma.whatsAppConnection.findUnique({ where: { id: input.whatsappConnectionId } });
    if (!connection) throw Errors.badRequest("Conexão inválida");
    const result = await service.importContactsCsv(input.csv, input.whatsappConnectionId, req.auth!.userId);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONTACTS_IMPORTED",
      entity: "Contact",
      entityId: null,
      ipAddress: req.ip ?? null,
      metadata: { whatsappConnectionId: input.whatsappConnectionId, created: result.created, existing: result.existing, errors: result.errors.length },
    });
    res.json(result);
  })
);

// --- Padronizar nomes (declared before /:id) ---

contactsRouter.get(
  "/name-standardization",
  requirePermission(PERMISSION.CONTATOS_EDITAR),
  asyncHandler(async (_req, res) => {
    const [items, lastBatch] = await Promise.all([service.previewNameStandardization(), service.lastNameStandardization()]);
    res.json({ items, lastBatch });
  })
);

contactsRouter.post(
  "/name-standardization",
  requirePermission(PERMISSION.CONTATOS_EDITAR),
  asyncHandler(async (req, res) => {
    const { contactIds } = z.object({ contactIds: z.array(z.string().uuid()).min(1).max(50_000) }).parse(req.body);
    const result = await service.applyNameStandardization(contactIds);
    await writeAudit({ userId: req.auth!.userId, action: "CONTACT_NAMES_STANDARDIZED", entity: "Contact", entityId: result.batchId, ipAddress: req.ip ?? null, metadata: { count: result.count } });
    res.json(result);
  })
);

contactsRouter.post(
  "/name-standardization/:batchId/undo",
  requirePermission(PERMISSION.CONTATOS_EDITAR),
  asyncHandler(async (req, res) => {
    const result = await service.undoNameStandardization(req.params.batchId);
    await writeAudit({ userId: req.auth!.userId, action: "CONTACT_NAMES_STANDARDIZATION_UNDONE", entity: "Contact", entityId: req.params.batchId, ipAddress: req.ip ?? null, metadata: result });
    res.json(result);
  })
);

// --- Etiquetas (declared before /:id so "tags" is never read as a contact id) ---

contactsRouter.get(
  "/tags",
  requirePermission(PERMISSION.ETIQUETAS_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json(await service.listManagedTags());
  })
);

const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(HEX_COLOR),
  blockedAutoMessages: z.array(z.enum(AUTO_MESSAGE_KINDS)).max(AUTO_MESSAGE_KINDS.length).optional(),
  queueUserIds: z.array(z.string().uuid()).max(200).optional(),
});

// "Não enviar estas mensagens automáticas" and "Atendida por" are Gestor/Administrador only (ETIQUETAS_BLOQUEIOS) — on top of adding/editing.
async function assertCanSetBlocks(req: Request, blocked: unknown, queueUserIds?: unknown) {
  if (blocked === undefined && queueUserIds === undefined) return;
  if (!(await isPermissionAllowed(req.auth!.role, PERMISSION.ETIQUETAS_BLOQUEIOS))) {
    throw Errors.forbidden(
      blocked === undefined
        ? "Você não tem permissão para escolher quem atende os clientes da etiqueta"
        : "Você não tem permissão para escolher as mensagens automáticas bloqueadas da etiqueta"
    );
  }
}

contactsRouter.post(
  "/tags",
  requirePermission(PERMISSION.ETIQUETAS_ADICIONAR),
  asyncHandler(async (req, res) => {
    const input = tagSchema.parse(req.body);
    await assertCanSetBlocks(req, input.blockedAutoMessages, input.queueUserIds);
    const tag = await service.createTag({
      ...input,
      blockedAutoMessages: [...new Set(input.blockedAutoMessages ?? [])],
      queueUserIds: [...new Set(input.queueUserIds ?? [])],
    });
    await writeAudit({ userId: req.auth!.userId, action: "TAG_CREATED", entity: "Tag", entityId: tag.id, ipAddress: req.ip ?? null, metadata: input });
    res.status(201).json(tag);
  })
);

contactsRouter.patch(
  "/tags/:tagId",
  requirePermission(PERMISSION.ETIQUETAS_EDITAR),
  asyncHandler(async (req, res) => {
    const input = tagSchema.partial().parse(req.body);
    await assertCanSetBlocks(req, input.blockedAutoMessages, input.queueUserIds);
    const tag = await service.updateTag(req.params.tagId, {
      ...input,
      ...(input.blockedAutoMessages && { blockedAutoMessages: [...new Set(input.blockedAutoMessages)] }),
      ...(input.queueUserIds && { queueUserIds: [...new Set(input.queueUserIds)] }),
    });
    await writeAudit({ userId: req.auth!.userId, action: "TAG_UPDATED", entity: "Tag", entityId: tag.id, ipAddress: req.ip ?? null, metadata: input });
    res.json(tag);
  })
);

contactsRouter.delete(
  "/tags/:tagId",
  requirePermission(PERMISSION.ETIQUETAS_EXCLUIR),
  asyncHandler(async (req, res) => {
    await service.deleteTag(req.params.tagId);
    await writeAudit({ userId: req.auth!.userId, action: "TAG_DELETED", entity: "Tag", entityId: req.params.tagId, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

// --- Um contato ---

contactsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await service.getContactDetail(req.params.id, await visibleConnectionIds(req)));
  })
);

const updateSchema = z.object({
  name: z.string().trim().max(120).optional(),
  firstName: z.string().trim().max(60).nullable().optional(),
  tagIds: z.array(z.string().uuid()).max(50).optional(),
});

contactsRouter.patch(
  "/:id",
  requirePermission(PERMISSION.CONTATOS_EDITAR),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const connectionIds = await visibleConnectionIds(req);
    await service.getContactOrThrow(req.params.id, connectionIds);
    await service.updateContact(req.params.id, input, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "CONTACT_UPDATED", entity: "Contact", entityId: req.params.id, ipAddress: req.ip ?? null, metadata: input });
    res.json(await service.getContactDetail(req.params.id, connectionIds));
  })
);
