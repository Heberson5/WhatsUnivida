import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  COLUMN_SCREEN_KEYS,
  COLUMN_SCREENS,
  mergeColumnView,
  type ColumnScreen,
  type ColumnViewColumn,
  type ColumnViewDTO,
  type EffectiveColumnViewDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";

const DEFAULT_VIEW_NAME = "Minha visão";

const include = {
  owner: { select: { id: true, displayName: true, role: true } },
  sharedWith: { select: { id: true, displayName: true }, orderBy: { displayName: "asc" } },
} satisfies Prisma.ColumnViewInclude;

type ColumnViewRow = Prisma.ColumnViewGetPayload<{ include: typeof include }>;

function toDTO(row: ColumnViewRow): ColumnViewDTO {
  const screen = row.screen as ColumnScreen;
  return {
    id: row.id,
    screen,
    name: row.name,
    columns: mergeColumnView(screen, row.columns as unknown as ColumnViewColumn[]),
    ownerId: row.owner.id,
    ownerName: row.owner.displayName,
    ownerRole: row.owner.role,
    shareAll: row.shareAll,
    sharedWith: row.sharedWith.map((u) => ({ id: u.id, name: u.displayName })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const screenSchema = z.enum(COLUMN_SCREEN_KEYS as [ColumnScreen, ...ColumnScreen[]]);

const columnsSchema = z.array(z.object({ key: z.string().min(1).max(60), visible: z.boolean() })).min(1).max(60);

/** Only the screen's own keys, each once, essential ones visible — anything else is a client bug. */
function validateColumns(screen: ColumnScreen, columns: ColumnViewColumn[]): ColumnViewColumn[] {
  const known = new Map(COLUMN_SCREENS[screen].columns.map((c) => [c.key, c]));
  const keys = new Set<string>();
  for (const column of columns) {
    const def = known.get(column.key);
    if (!def || keys.has(column.key)) throw Errors.badRequest(`Coluna inválida: ${column.key}`);
    if ("fixed" in def && def.fixed && !column.visible) throw Errors.badRequest(`A coluna ${def.label} não pode ser escondida.`);
    keys.add(column.key);
  }
  return mergeColumnView(screen, columns);
}

export const saveOwnSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), columns: columnsSchema });

/**
 * The view each screen opens with for this user: their own, else the most
 * recently updated one shared with them. Screens with neither are left out
 * (the system's default order applies).
 */
export async function getEffectiveViews(userId: string): Promise<Partial<Record<ColumnScreen, EffectiveColumnViewDTO>>> {
  const rows = await prisma.columnView.findMany({
    where: {
      screen: { in: COLUMN_SCREEN_KEYS },
      OR: [{ ownerId: userId }, { shareAll: true }, { sharedWith: { some: { id: userId } } }],
    },
    include,
    orderBy: { updatedAt: "desc" },
  });
  const result: Partial<Record<ColumnScreen, EffectiveColumnViewDTO>> = {};
  for (const row of rows) {
    const screen = row.screen as ColumnScreen;
    const own = row.ownerId === userId;
    const current = result[screen];
    if (current && (current.source === "own" || !own)) continue;
    result[screen] = { ...toDTO(row), source: own ? "own" : "shared" };
  }
  return result;
}

export async function saveOwnView(userId: string, screen: ColumnScreen, input: z.infer<typeof saveOwnSchema>): Promise<ColumnViewDTO> {
  const columns = validateColumns(screen, input.columns) as unknown as Prisma.InputJsonValue;
  const row = await prisma.columnView.upsert({
    where: { ownerId_screen: { ownerId: userId, screen } },
    create: { ownerId: userId, screen, name: input.name ?? DEFAULT_VIEW_NAME, columns },
    update: { columns, ...(input.name ? { name: input.name } : {}) },
    include,
  });
  return toDTO(row);
}

export async function deleteOwnView(userId: string, screen: ColumnScreen): Promise<void> {
  await prisma.columnView.deleteMany({ where: { ownerId: userId, screen } });
}

export async function listViews(): Promise<ColumnViewDTO[]> {
  const rows = await prisma.columnView.findMany({ include, orderBy: [{ screen: "asc" }, { updatedAt: "desc" }] });
  return rows.filter((r) => (COLUMN_SCREEN_KEYS as string[]).includes(r.screen)).map(toDTO);
}

export const updateViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  columns: columnsSchema,
  shareAll: z.boolean(),
  sharedWithIds: z.array(z.string().uuid()).max(500),
});

export async function updateView(id: string, input: z.infer<typeof updateViewSchema>): Promise<ColumnViewDTO> {
  const existing = await prisma.columnView.findUnique({ where: { id }, include });
  if (!existing) throw Errors.notFound("Visão não encontrada.");
  const shares = input.shareAll || input.sharedWithIds.some((uid) => uid !== existing.ownerId);
  // An attendant's view stays theirs alone.
  if (existing.owner.role === "AGENT" && shares) throw Errors.badRequest("A visão de um atendente é só dele e não pode ser compartilhada.");
  const columns = validateColumns(existing.screen as ColumnScreen, input.columns) as unknown as Prisma.InputJsonValue;
  const row = await prisma.columnView.update({
    where: { id },
    data: {
      name: input.name,
      columns,
      shareAll: input.shareAll,
      sharedWith: { set: input.shareAll ? [] : input.sharedWithIds.filter((uid) => uid !== existing.ownerId).map((uid) => ({ id: uid })) },
    },
    include,
  });
  return toDTO(row);
}

export async function deleteView(id: string): Promise<ColumnViewDTO> {
  const existing = await prisma.columnView.findUnique({ where: { id }, include });
  if (!existing) throw Errors.notFound("Visão não encontrada.");
  await prisma.columnView.delete({ where: { id } });
  return toDTO(existing);
}
