import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { assertCaptionFits, deleteReplyMediaFile, type ReplyMediaColumns } from "../../lib/reply-media";
import { assertScopeConnectionsExist, scopeData, withScopeConnections, type ConnectionScopeInput } from "../../lib/connection-scope";

export async function listQueueWaitMessages() {
  return prisma.queueWaitMessage.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }], include: withScopeConnections });
}

export async function getQueueWaitMessage(id: string) {
  const row = await prisma.queueWaitMessage.findUnique({ where: { id }, include: withScopeConnections });
  if (!row) throw Errors.notFound("Mensagem de espera nao encontrada");
  return row;
}

export interface QueueWaitMessageInput {
  delayMinutes: number;
  text: string;
  active: boolean;
  connectionScope: ConnectionScopeInput;
}

export async function createQueueWaitMessage(input: QueueWaitMessageInput) {
  await assertScopeConnectionsExist(input.connectionScope);
  const last = await prisma.queueWaitMessage.aggregate({ _max: { position: true } });
  const row = await prisma.queueWaitMessage.create({
    data: { position: (last._max.position ?? 0) + 1, delayMinutes: input.delayMinutes, text: input.text, active: input.active, ...scopeData(input.connectionScope, "connect") },
  });
  return getQueueWaitMessage(row.id);
}

export async function updateQueueWaitMessage(id: string, input: Partial<QueueWaitMessageInput>) {
  const current = await getQueueWaitMessage(id);
  if (input.text !== undefined) assertCaptionFits(input.text, Boolean(current.mediaStorageKey));
  if (input.connectionScope) await assertScopeConnectionsExist(input.connectionScope);
  await prisma.queueWaitMessage.update({
    where: { id },
    data: { delayMinutes: input.delayMinutes, text: input.text, active: input.active, ...(input.connectionScope && scopeData(input.connectionScope, "set")) },
  });
  return getQueueWaitMessage(id);
}

/** Numbers the list 1, 2, 3… again in the given order (after a removal or a move). */
async function renumber(orderedIds: string[]) {
  await prisma.$transaction(orderedIds.map((id, i) => prisma.queueWaitMessage.update({ where: { id }, data: { position: i + 1 } })));
}

/** "Subir" / "Descer": swaps the message with its neighbor. */
export async function moveQueueWaitMessage(id: string, direction: "up" | "down") {
  const ids = (await listQueueWaitMessages()).map((m) => m.id);
  const from = ids.indexOf(id);
  if (from < 0) throw Errors.notFound("Mensagem de espera nao encontrada");
  const to = direction === "up" ? from - 1 : from + 1;
  if (to >= 0 && to < ids.length) [ids[from], ids[to]] = [ids[to], ids[from]];
  await renumber(ids);
  return listQueueWaitMessages();
}

export async function deleteQueueWaitMessage(id: string) {
  const current = await getQueueWaitMessage(id);
  await prisma.queueWaitMessage.delete({ where: { id } });
  deleteReplyMediaFile(current.mediaStorageKey);
  await renumber((await listQueueWaitMessages()).map((m) => m.id));
}

/** Attaches (or with NO_REPLY_MEDIA, removes) the image, video or PDF — the file it had before is deleted. */
export async function setQueueWaitMessageMedia(id: string, media: ReplyMediaColumns) {
  const current = await getQueueWaitMessage(id);
  if (media.mediaStorageKey) assertCaptionFits(current.text, true);
  await prisma.queueWaitMessage.update({ where: { id }, data: media });
  if (current.mediaStorageKey !== media.mediaStorageKey) deleteReplyMediaFile(current.mediaStorageKey);
  return getQueueWaitMessage(id);
}
