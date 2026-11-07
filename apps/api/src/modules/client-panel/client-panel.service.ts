import { contactContractsOf } from "../../lib/contact-contracts";
import { AUTO_MESSAGE_KINDS, type AutoMessageKind, type ClientDataCorrectionDTO, type ContactPanelDTO, type ConversationNoteDTO, type PreviousConversationDetailDTO, type TagDTO } from "@whatsatendende/types";
import { toMessageDTO } from "../messages/messages.mapper";
import { messageInclude } from "../messages/messages.service";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { realtimeEvents } from "../../realtime/realtime";

// The panel opens with the last few; "Mostrar mais" brings the next page (see listPreviousConversations).
const PREVIOUS_CONVERSATIONS_FIRST = 3;

export function toTagDTO(tag: { id: string; name: string; color: string; blockedAutoMessages: string[]; queueUserIds?: string[] }): TagDTO {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    blockedAutoMessages: tag.blockedAutoMessages.filter((k): k is AutoMessageKind => (AUTO_MESSAGE_KINDS as readonly string[]).includes(k)),
    queueUserIds: tag.queueUserIds ?? [],
  };
}

// A note with no author was written by the system (e.g. why a conversation came from Abandonados).
export const SYSTEM_NOTE_AUTHOR = "Sistema";

export function toNoteDTO(note: { id: string; conversationId: string; authorId: string | null; body: string; createdAt: Date; author: { displayName: string } | null }): ConversationNoteDTO {
  return {
    id: note.id,
    conversationId: note.conversationId,
    authorId: note.authorId,
    authorName: note.author?.displayName ?? SYSTEM_NOTE_AUTHOR,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
  };
}

export async function listTags(): Promise<TagDTO[]> {
  const tags = await prisma.tag.findMany({ orderBy: { name: "asc" } });
  return tags.map(toTagDTO);
}

export async function getContactPanel(conversationId: string, contactId: string, firstConversationAt: Date): Promise<ContactPanelDTO> {
  const [contact, tags, previous, previousCount] = await Promise.all([
    prisma.contact.findUniqueOrThrow({ where: { id: contactId }, select: { pinnedNote: true, pinnedNoteUpdatedAt: true, pinnedNoteUpdatedBy: true, contractNumber: true, contracts: true, firstName: true } }),
    prisma.contactTag.findMany({ where: { contactId }, include: { tag: true }, orderBy: { createdAt: "asc" } }),
    listPreviousConversations(conversationId, contactId, 0, PREVIOUS_CONVERSATIONS_FIRST),
    prisma.conversation.count({ where: { contactId, id: { not: conversationId } } }),
  ]);
  return {
    contactId,
    firstConversationAt: firstConversationAt.toISOString(),
    tags: tags.map((t) => toTagDTO(t.tag)),
    previousConversations: previous,
    previousConversationCount: previousCount,
    pinnedNote: contact.pinnedNote
      ? { text: contact.pinnedNote, updatedAt: contact.pinnedNoteUpdatedAt!.toISOString(), updatedByName: contact.pinnedNoteUpdatedBy }
      : null,
    contractNumber: contact.contractNumber,
    contracts: contactContractsOf(contact.contracts),
    firstName: contact.firstName,
  };
}

/** The customer's other conversations, newest first — `skip`/`take` page "Mostrar mais". The attendant by full name. */
export async function listPreviousConversations(conversationId: string, contactId: string, skip: number, take: number): Promise<ContactPanelDTO["previousConversations"]> {
  const rows = await prisma.conversation.findMany({
    where: { contactId, id: { not: conversationId } },
    orderBy: { enteredQueueAt: "desc" },
    skip,
    take,
    include: {
      assignedAgent: { select: { fullName: true } },
      whatsappConnection: { select: { name: true } },
      metaConnection: { select: { name: true } },
      _count: { select: { messages: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    status: c.status,
    agentName: c.assignedAgent?.fullName ?? null,
    connectionName: c.whatsappConnection?.name ?? c.metaConnection?.name ?? "",
    startedAt: c.enteredQueueAt.toISOString(),
    closedAt: c.closedAt ? c.closedAt.toISOString() : null,
    messageCount: c._count.messages,
  }));
}

/** Contatos › Primeiro nome, as the attendant typed it (empty clears it: the first word of the name again). */
export async function setFirstName(contactId: string, firstName: string | null) {
  await prisma.contact.update({ where: { id: contactId }, data: { firstName } });
}

/** Contatos › Contrato, as the attendant typed it in the client panel (empty clears it). */
export async function setContractNumber(contactId: string, contractNumber: string | null) {
  await prisma.contact.update({ where: { id: contactId }, data: { contractNumber } });
}

export async function setPinnedNote(contactId: string, text: string | null, userName: string) {
  await prisma.contact.update({
    where: { id: contactId },
    data: text ? { pinnedNote: text, pinnedNoteUpdatedAt: new Date(), pinnedNoteUpdatedBy: userName } : { pinnedNote: null, pinnedNoteUpdatedAt: null, pinnedNoteUpdatedBy: null },
  });
}

/** One earlier conversation of the same contact, read-only: its messages, notes and survey score. */
export async function getPreviousConversation(contactId: string, previousId: string): Promise<PreviousConversationDetailDTO> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: previousId, contactId },
    include: { assignedAgent: { select: { displayName: true } }, satisfactionSurvey: { select: { score: true, answerText: true } } },
  });
  if (!conversation) throw Errors.notFound("Conversa nao encontrada");
  const [messages, notes] = await Promise.all([
    prisma.message.findMany({ where: { conversationId: previousId, deletedAt: null }, orderBy: { createdAt: "asc" }, include: messageInclude }),
    listNotes(previousId),
  ]);
  return {
    id: conversation.id,
    status: conversation.status,
    agentName: conversation.assignedAgent?.displayName ?? null,
    startedAt: conversation.enteredQueueAt.toISOString(),
    closedAt: conversation.closedAt ? conversation.closedAt.toISOString() : null,
    messages: messages.map(toMessageDTO),
    notes,
    survey: conversation.satisfactionSurvey ? { score: conversation.satisfactionSurvey.score, answerText: conversation.satisfactionSurvey.answerText } : null,
  };
}

export async function addContactTag(contactId: string, tagId: string, userId: string) {
  const tag = await prisma.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw Errors.notFound("Etiqueta nao encontrada");
  await prisma.contactTag.upsert({
    where: { contactId_tagId: { contactId, tagId } },
    create: { contactId, tagId, addedById: userId },
    update: {},
  });
  realtimeEvents.contactTagsChanged();
}

export async function removeContactTag(contactId: string, tagId: string) {
  await prisma.contactTag.deleteMany({ where: { contactId, tagId } });
  realtimeEvents.contactTagsChanged();
}

export async function listNotes(conversationId: string): Promise<ConversationNoteDTO[]> {
  const notes = await prisma.conversationNote.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { displayName: true } } },
  });
  return notes.map(toNoteDTO);
}

export async function createNote(conversationId: string, authorId: string, body: string): Promise<ConversationNoteDTO> {
  const note = await prisma.conversationNote.create({
    data: { conversationId, authorId, body },
    include: { author: { select: { displayName: true } } },
  });
  return toNoteDTO(note);
}

// --- Cadastro desatualizado (Assistente Virtual) -----------------------------------------------------------------

function toCorrectionDTO(row: {
  id: string;
  createdAt: Date;
  cpfKey: string;
  clientName: string | null;
  registeredAddress: string | null;
  informedName: string | null;
  informedAddress: string | null;
  resolvedAt: Date | null;
  resolvedByName: string | null;
}): ClientDataCorrectionDTO {
  const digits = row.cpfKey;
  const cpf = digits.length === 11 ? `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**` : digits.length === 14 ? `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/****-**` : "***";
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    cpf,
    clientName: row.clientName,
    registeredAddress: row.registeredAddress,
    informedName: row.informedName,
    informedAddress: row.informedAddress,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByName: row.resolvedByName,
  };
}

/** What still waits for someone to update the client's record — this phone's, or the CPF confirmed in this conversation. */
export async function pendingCorrections(conversation: { contactId: string; dataCpfKey?: string | null }): Promise<ClientDataCorrectionDTO[]> {
  const rows = await prisma.clientDataCorrection.findMany({
    where: { resolvedAt: null, OR: [{ contactId: conversation.contactId }, ...(conversation.dataCpfKey ? [{ cpfKey: conversation.dataCpfKey }] : [])] },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toCorrectionDTO);
}

/** "Cadastro já atualizado": stops the pop-up, keeping who did it and when. */
export async function resolveCorrection(conversation: { id: string; contactId: string; dataCpfKey?: string | null }, correctionId: string, user: { id: string; name: string }) {
  const pending = await pendingCorrections(conversation);
  if (!pending.some((c) => c.id === correctionId)) throw Errors.notFound("Aviso de cadastro não encontrado para este cliente");
  const now = new Date();
  const row = await prisma.clientDataCorrection.update({ where: { id: correctionId }, data: { resolvedAt: now, resolvedById: user.id, resolvedByName: user.name } });
  const when = now.toLocaleString("pt-BR", { timeZone: "America/Cuiaba" });
  await prisma.conversationNote.create({ data: { conversationId: conversation.id, authorId: user.id, body: `Cadastro atualizado por ${user.name} em ${when} (endereço informado ao Assistente Virtual: ${row.informedAddress ?? "—"}).` } });
  return toCorrectionDTO(row);
}
