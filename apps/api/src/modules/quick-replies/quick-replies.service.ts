import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { assertCaptionFits, deleteReplyMediaFile, type ReplyMediaColumns } from "../../lib/reply-media";
import { appliesToConnection, assertScopeConnectionsExist, scopeData, withScopeConnections, type ConnectionScopeInput } from "../../lib/connection-scope";

/** Normalizes a user-entered shortcut into the canonical stored form: lowercase, no leading "/", no surrounding whitespace. */
export function normalizeShortcut(raw: string): string {
  return raw.trim().replace(/^\/+/, "").toLowerCase();
}

export async function listQuickReplies() {
  return prisma.quickReply.findMany({ orderBy: { name: "asc" }, include: withScopeConnections });
}

/** Scoped to one connection — powers the "/" picker in the composer, not the management screen. */
export async function listQuickRepliesForConnection(whatsappConnectionId: string) {
  return prisma.quickReply.findMany({
    where: appliesToConnection(whatsappConnectionId),
    orderBy: { name: "asc" },
    include: withScopeConnections,
  });
}

/** Two replies that can show up in the same connection's "/" picker can't share a shortcut. */
async function assertShortcutAvailable(shortcut: string, scope: ConnectionScopeInput, excludeId?: string) {
  const clash = await prisma.quickReply.findFirst({
    where: {
      shortcut,
      ...(excludeId && { id: { not: excludeId } }),
      ...(!scope.allConnections && { OR: [{ allConnections: true }, { connections: { some: { id: { in: scope.connectionIds } } } }] }),
    },
  });
  if (clash) throw Errors.conflict(`Já existe uma resposta rápida com o atalho "/${shortcut}" em uma das conexões escolhidas`);
}

export async function createQuickReply(input: { name: string; shortcut: string; text: string; connectionScope: ConnectionScopeInput }) {
  const shortcut = normalizeShortcut(input.shortcut);
  await assertScopeConnectionsExist(input.connectionScope);
  await assertShortcutAvailable(shortcut, input.connectionScope);
  return prisma.quickReply.create({
    data: { name: input.name, shortcut, text: input.text, ...scopeData(input.connectionScope, "connect") },
    include: withScopeConnections,
  });
}

export async function getQuickReply(id: string) {
  const row = await prisma.quickReply.findUnique({ where: { id }, include: withScopeConnections });
  if (!row) throw Errors.notFound("Resposta rápida nao encontrada");
  return row;
}

export async function updateQuickReply(
  id: string,
  input: Partial<{ name: string; shortcut: string; text: string; connectionScope: ConnectionScopeInput }>
) {
  const current = await getQuickReply(id);
  const scope = input.connectionScope ?? { allConnections: current.allConnections, connectionIds: current.connections.map((c) => c.id) };
  if (input.connectionScope) await assertScopeConnectionsExist(input.connectionScope);
  const shortcut = input.shortcut !== undefined ? normalizeShortcut(input.shortcut) : current.shortcut;
  await assertShortcutAvailable(shortcut, scope, id);
  if (input.text !== undefined) assertCaptionFits(input.text, Boolean(current.mediaStorageKey));
  return prisma.quickReply.update({
    where: { id },
    data: { name: input.name, shortcut, text: input.text, ...(input.connectionScope && scopeData(input.connectionScope, "set")) },
    include: withScopeConnections,
  });
}

export async function deleteQuickReply(id: string) {
  const current = await getQuickReply(id);
  await prisma.quickReply.delete({ where: { id } });
  deleteReplyMediaFile(current.mediaStorageKey);
}

/** Attaches (or with NO_REPLY_MEDIA, removes) the reply's image, video or PDF — the file it had before is deleted. */
export async function setQuickReplyMedia(id: string, media: ReplyMediaColumns) {
  const current = await getQuickReply(id);
  if (media.mediaStorageKey) assertCaptionFits(current.text, true);
  const row = await prisma.quickReply.update({ where: { id }, data: media, include: withScopeConnections });
  if (current.mediaStorageKey !== media.mediaStorageKey) deleteReplyMediaFile(current.mediaStorageKey);
  return row;
}
