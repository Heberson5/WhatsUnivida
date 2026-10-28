import type { BirthdayKind, BirthdayMessage, Role } from "@prisma/client";
import {
  DEFAULT_BIRTHDAY_MESSAGES,
  birthdayPersonKey,
  businessDay,
  contractStatusOf,
  fillBirthdayTags,
  type BirthdayMessageDTO,
  type BirthdayPersonDTO,
  type BirthdayTodayDTO,
  type ConversationBirthdayDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { Errors } from "../../lib/http-error";
import { toReplyMediaDTO, type ReplyMediaColumns } from "../../lib/reply-media";
import { renderAutoMessageTemplate, ROLE_LABEL } from "../auto-message-templates/auto-message-templates.service";
import { buildContracts, clientRows, usableSource, type ConversationForData } from "../data-sources/data-sources.service";

const KINDS: BirthdayKind[] = ["HOLDER", "BENEFICIARY"];

/** Both messages, created with the defaults if someone's database lost them. */
export async function birthdayMessages(): Promise<BirthdayMessage[]> {
  const rows = await prisma.birthdayMessage.findMany();
  for (const kind of KINDS) {
    if (!rows.some((r) => r.kind === kind)) rows.push(await prisma.birthdayMessage.create({ data: { kind, text: DEFAULT_BIRTHDAY_MESSAGES[kind] } }));
  }
  return KINDS.map((kind) => rows.find((r) => r.kind === kind)!);
}

export async function toBirthdayMessageDTO(row: BirthdayMessage): Promise<BirthdayMessageDTO> {
  const by = row.updatedById ? await prisma.user.findUnique({ where: { id: row.updatedById }, select: { displayName: true } }) : null;
  return { kind: row.kind, text: row.text, active: row.active, media: toReplyMediaDTO(row), updatedAt: row.updatedAt.toISOString(), updatedByName: by?.displayName ?? null };
}

export async function updateBirthdayMessage(kind: BirthdayKind, input: { text?: string; active?: boolean }, userId: string) {
  await birthdayMessages();
  return prisma.birthdayMessage.update({ where: { kind }, data: { ...input, updatedById: userId } });
}

export async function setBirthdayMedia(kind: BirthdayKind, media: ReplyMediaColumns, userId: string) {
  await birthdayMessages();
  const before = await prisma.birthdayMessage.findUniqueOrThrow({ where: { kind } });
  const row = await prisma.birthdayMessage.update({ where: { kind }, data: { ...media, updatedById: userId } });
  return { row, previousKey: before.mediaStorageKey };
}

/**
 * Who of the conversation's client has a birthday today, from the live Fonte de dados (the titular and the
 * beneficiaries of contracts that aren't canceled). Several clients on the phone and none picked yet: nobody.
 */
export async function birthdaysOfConversation(conversation: ConversationForData): Promise<BirthdayTodayDTO[]> {
  const source = await usableSource(conversation);
  if (!source) return [];
  const { map, byClient, selectedKey } = await clientRows(source, conversation);
  if (!selectedKey) return [];
  const contracts = buildContracts(byClient.get(selectedKey)!, map).filter((c) => contractStatusOf(c.status) !== "CANCELED");
  const seen = new Set<string>();
  const people: BirthdayTodayDTO[] = [];
  for (const contract of contracts) {
    for (const b of contract.beneficiaries) {
      const key = birthdayPersonKey(b.name);
      if (b.daysUntilBirthday !== 0 || b.age === null || seen.has(key)) continue;
      seen.add(key);
      people.push({ key, name: b.name, firstName: b.name.trim().split(/\s+/)[0], relation: b.holder ? "Titular" : b.relation, holder: b.holder, age: b.age, contract: contract.number });
    }
  }
  return people.sort((a, b) => Number(b.holder) - Number(a.holder));
}

type BirthdayConversation = ConversationForData & {
  contactId: string;
  assignedAgentId: string | null;
  birthdayAckAt: Date | null;
  contact: { phone: string | null; name: string | null; firstName: string | null };
};

export async function conversationBirthday(conversation: BirthdayConversation, viewer: { userId: string; role: Role; displayName: string }): Promise<ConversationBirthdayDTO> {
  const people = await birthdaysOfConversation(conversation);
  if (!people.length) return { pending: false, people: [] };
  const year = businessDay(new Date(), env.BUSINESS_TZ_OFFSET_MINUTES).year;
  const [messages, greetings, agent] = await Promise.all([
    birthdayMessages(),
    prisma.birthdayGreeting.findMany({ where: { contactId: conversation.contactId, year, personKey: { in: people.map((p) => p.key) } } }),
    prisma.user.findUnique({ where: { id: viewer.userId }, select: { displayName: true, fullName: true, role: true } }),
  ]);
  const senders = await prisma.user.findMany({ where: { id: { in: greetings.map((g) => g.sentById) } }, select: { id: true, displayName: true } });
  const customerName = conversation.contact.name ?? conversation.contact.phone ?? "";
  const result: BirthdayPersonDTO[] = people.map((person) => {
    const kind: BirthdayKind = person.holder ? "HOLDER" : "BENEFICIARY";
    const message = messages.find((m) => m.kind === kind)!;
    const greeting = greetings.find((g) => g.personKey === person.key);
    const media = toReplyMediaDTO(message);
    return {
      ...person,
      kind,
      greeted: greeting ? { byName: senders.find((s) => s.id === greeting.sentById)?.displayName ?? "outro atendente", at: greeting.sentAt.toISOString() } : null,
      text: message.active
        ? renderAutoMessageTemplate(fillBirthdayTags(message.text, person), {
            atendente: agent?.displayName ?? viewer.displayName,
            atendenteNome: agent?.fullName ?? viewer.displayName,
            atendenteCargo: ROLE_LABEL[agent?.role ?? viewer.role],
            cliente: customerName,
            primeiroNome: conversation.contact.firstName,
          })
        : null,
      media: message.active && media ? { fileName: media.fileName, mimeType: media.mimeType, url: `/birthday-messages/${kind}/media` } : null,
    };
  });
  return { pending: !conversation.birthdayAckAt && conversation.assignedAgentId === viewer.userId, people: result };
}

/** The congratulations went out (through the normal send): remembered for the year, and the pop-up is done. */
export async function markGreeted(conversation: BirthdayConversation, personKey: string, userId: string) {
  const person = (await birthdaysOfConversation(conversation)).find((p) => p.key === personKey);
  if (!person) throw Errors.badRequest("Esta pessoa nao faz aniversario hoje");
  const year = businessDay(new Date(), env.BUSINESS_TZ_OFFSET_MINUTES).year;
  await prisma.birthdayGreeting.upsert({
    where: { contactId_personKey_year: { contactId: conversation.contactId, personKey, year } },
    create: { contactId: conversation.contactId, personKey, personName: person.name, kind: person.holder ? "HOLDER" : "BENEFICIARY", year, conversationId: conversation.id, sentById: userId },
    update: { conversationId: conversation.id, sentById: userId, sentAt: new Date() },
  });
  // The pop-up stays while someone else of the client still has a birthday to be congratulated for.
  const people = await birthdaysOfConversation(conversation);
  const done = await prisma.birthdayGreeting.count({ where: { contactId: conversation.contactId, year, personKey: { in: people.map((p) => p.key) } } });
  if (done >= people.length) await prisma.conversation.update({ where: { id: conversation.id }, data: { birthdayAckAt: new Date() } });
}

export async function acknowledge(conversationId: string) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { birthdayAckAt: new Date() } });
}
