import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { assertCaptionFits, deleteReplyMediaFile, type ReplyMediaColumns } from "../../lib/reply-media";
import { assertScopeConnectionsExist, scopeData, withScopeConnections, type ConnectionScopeInput } from "../../lib/connection-scope";

const withAssignedUsers = {
  assignedUsers: { select: { id: true, displayName: true }, orderBy: { displayName: "asc" as const } },
  ...withScopeConnections,
} as const;

export async function listClosingMessages() {
  return prisma.closingMessage.findMany({ orderBy: { name: "asc" }, include: withAssignedUsers });
}

export async function getClosingMessage(id: string) {
  const row = await prisma.closingMessage.findUnique({ where: { id }, include: withAssignedUsers });
  if (!row) throw Errors.notFound("Encerramento nao encontrado");
  return row;
}

/**
 * The only place userIds are ever attached/detached from a ClosingMessage
 * — reassigns exactly the given set, moving anyone in it away from
 * whatever ClosingMessage they were in before (a plain overwrite of
 * User.closingMessageId, one row per user, so exclusivity is automatic —
 * see PROMPT: "se habilitar o usuário no recente, irá sair do anterior")
 * and detaching anyone previously on this one who isn't in the new set.
 */
async function syncAssignedUsers(closingMessageId: string, userIds: string[]) {
  await prisma.$transaction([
    prisma.user.updateMany({ where: { id: { in: userIds } }, data: { closingMessageId } }),
    prisma.user.updateMany({ where: { closingMessageId, id: { notIn: userIds } }, data: { closingMessageId: null } }),
  ]);
}

export interface ClosingMessageInput {
  name: string;
  text: string;
  active: boolean;
  // Left out: with the name on top (the default).
  showSenderName?: boolean;
  userIds: string[];
  connectionScope: ConnectionScopeInput;
}

async function assertUsersExist(userIds: string[]) {
  if (userIds.length === 0) return;
  const count = await prisma.user.count({ where: { id: { in: userIds } } });
  if (count !== userIds.length) throw Errors.badRequest("Um ou mais usuarios selecionados sao invalidos");
}

export async function createClosingMessage(input: ClosingMessageInput) {
  await assertUsersExist(input.userIds);
  await assertScopeConnectionsExist(input.connectionScope);
  const row = await prisma.closingMessage.create({ data: { name: input.name, text: input.text, active: input.active, showSenderName: input.showSenderName, ...scopeData(input.connectionScope, "connect") } });
  await syncAssignedUsers(row.id, input.userIds);
  return getClosingMessage(row.id);
}

export async function updateClosingMessage(id: string, input: Partial<ClosingMessageInput>) {
  const current = await getClosingMessage(id);
  if (input.text !== undefined) assertCaptionFits(input.text, Boolean(current.mediaStorageKey));
  if (input.userIds) await assertUsersExist(input.userIds);
  if (input.connectionScope) await assertScopeConnectionsExist(input.connectionScope);
  await prisma.closingMessage.update({
    where: { id },
    data: { name: input.name, text: input.text, active: input.active, showSenderName: input.showSenderName, ...(input.connectionScope && scopeData(input.connectionScope, "set")) },
  });
  if (input.userIds) await syncAssignedUsers(id, input.userIds);
  return getClosingMessage(id);
}

export async function deleteClosingMessage(id: string) {
  const current = await getClosingMessage(id);
  await prisma.closingMessage.delete({ where: { id } });
  // Closings already scheduled keep their own copy (see copyReplyMediaFile) — only this row's file goes.
  deleteReplyMediaFile(current.mediaStorageKey);
}

/** Attaches (or with NO_REPLY_MEDIA, removes) the closing message's image, video or PDF — the file it had before is deleted. */
export async function setClosingMessageMedia(id: string, media: ReplyMediaColumns) {
  const current = await getClosingMessage(id);
  if (media.mediaStorageKey) assertCaptionFits(current.text, true);
  await prisma.closingMessage.update({ where: { id }, data: media });
  if (current.mediaStorageKey !== media.mediaStorageKey) deleteReplyMediaFile(current.mediaStorageKey);
  return getClosingMessage(id);
}

/** The message to auto-send when this user closes a conversation of this connection — null if they have none assigned, theirs is inactive or doesn't cover the connection. */
export async function getActiveClosingMessageForAgent(agentId: string, whatsappConnectionId: string | null) {
  const user = await prisma.user.findUnique({ where: { id: agentId }, select: { closingMessage: { include: { connections: { select: { id: true } } } } } });
  const message = user?.closingMessage;
  if (!message || !message.active) return null;
  if (!message.allConnections && !message.connections.some((c) => c.id === whatsappConnectionId)) return null;
  return message;
}
