import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";

const withConnection = { whatsappConnection: { select: { id: true, name: true } } } as const;

/** Normalizes a user-entered shortcut into the canonical stored form: lowercase, no leading "/", no surrounding whitespace. */
export function normalizeShortcut(raw: string): string {
  return raw.trim().replace(/^\/+/, "").toLowerCase();
}

export async function listQuickReplies() {
  return prisma.quickReply.findMany({ orderBy: { name: "asc" }, include: withConnection });
}

/** Scoped to one connection — powers the "/" picker in the composer, not the management screen. */
export async function listQuickRepliesForConnection(whatsappConnectionId: string) {
  return prisma.quickReply.findMany({
    where: { whatsappConnectionId },
    orderBy: { name: "asc" },
    include: withConnection,
  });
}

async function assertShortcutAvailable(whatsappConnectionId: string, shortcut: string, excludeId?: string) {
  const clash = await prisma.quickReply.findUnique({
    where: { whatsappConnectionId_shortcut: { whatsappConnectionId, shortcut } },
  });
  if (clash && clash.id !== excludeId) {
    throw Errors.conflict(`Já existe uma resposta rápida com o atalho "/${shortcut}" nesta conexão`);
  }
}

export async function createQuickReply(input: { name: string; shortcut: string; text: string; whatsappConnectionId: string }) {
  const shortcut = normalizeShortcut(input.shortcut);
  const connection = await prisma.whatsAppConnection.findUnique({ where: { id: input.whatsappConnectionId } });
  if (!connection) throw Errors.badRequest("Conexao de WhatsApp invalida");
  await assertShortcutAvailable(input.whatsappConnectionId, shortcut);
  return prisma.quickReply.create({
    data: { name: input.name, shortcut, text: input.text, whatsappConnectionId: input.whatsappConnectionId },
    include: withConnection,
  });
}

export async function getQuickReply(id: string) {
  const row = await prisma.quickReply.findUnique({ where: { id }, include: withConnection });
  if (!row) throw Errors.notFound("Resposta rápida nao encontrada");
  return row;
}

export async function updateQuickReply(
  id: string,
  input: Partial<{ name: string; shortcut: string; text: string; whatsappConnectionId: string }>
) {
  const current = await getQuickReply(id);
  const whatsappConnectionId = input.whatsappConnectionId ?? current.whatsappConnectionId;
  if (input.whatsappConnectionId && input.whatsappConnectionId !== current.whatsappConnectionId) {
    const connection = await prisma.whatsAppConnection.findUnique({ where: { id: input.whatsappConnectionId } });
    if (!connection) throw Errors.badRequest("Conexao de WhatsApp invalida");
  }
  const shortcut = input.shortcut !== undefined ? normalizeShortcut(input.shortcut) : current.shortcut;
  if (shortcut !== current.shortcut || whatsappConnectionId !== current.whatsappConnectionId) {
    await assertShortcutAvailable(whatsappConnectionId, shortcut, id);
  }
  return prisma.quickReply.update({
    where: { id },
    data: { name: input.name, shortcut, text: input.text, whatsappConnectionId },
    include: withConnection,
  });
}

export async function deleteQuickReply(id: string) {
  await getQuickReply(id);
  await prisma.quickReply.delete({ where: { id } });
}
