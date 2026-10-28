import type { ChatMember, ChatMessage, ChatRoom, Prisma } from "@prisma/client";
import {
  CHAT_EDIT_WINDOW_MINUTES,
  CHAT_MAX_FAVORITES,
  CHAT_MAX_PINS,
  CHAT_NUDGE_COOLDOWN_SECONDS,
  chatDurationLabel,
  type ChatFormerMemberDTO,
  type ChatMemberDTO,
  type ChatMessageDTO,
  type ChatMessageInfoDTO,
  type ChatMessageStatus,
  type ChatOversightRoomDTO,
  type ChatPinDTO,
  type ChatRoomDTO,
  type ChatSearchResultDTO,
  type ChatUserDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { realtimeEvents } from "../../realtime/realtime";

export const GENERAL_NAME = "#Geral";
const PAGE_SIZE = 50;
const MENTION_ALL = "ALL";

type RoomWithMembers = ChatRoom & { members: ChatMember[] };
type Users = Map<string, ChatUserDTO>;
type Role = "ADMIN" | "MANAGER" | "AGENT";

const messageInclude = {
  reactions: true,
  poll: { include: { options: { orderBy: { position: "asc" } }, votes: true } },
  views: true,
  edits: { orderBy: { editedAt: "asc" } },
} satisfies Prisma.ChatMessageInclude;
type FullMessage = Prisma.ChatMessageGetPayload<{ include: typeof messageInclude }>;

async function usersById(ids: string[]): Promise<Users> {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, displayName: true, photoUrl: true, presence: true } });
  return new Map(users.map((u) => [u.id, { id: u.id, name: u.displayName, photoUrl: u.photoUrl, presence: u.presence }]));
}

const nameOf = (users: Users, id: string | null | undefined) => (id ? (users.get(id)?.name ?? "Usuário removido") : null);

async function displayName(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } })).displayName;
}

export async function listChatUsers(): Promise<ChatUserDTO[]> {
  const users = await prisma.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, displayName: true, photoUrl: true, presence: true }, orderBy: { displayName: "asc" } });
  return users.map((u) => ({ id: u.id, name: u.displayName, photoUrl: u.photoUrl, presence: u.presence }));
}

/** #Geral exists once and every active person is in it. */
async function ensureGeneral(userId: string) {
  const room = (await prisma.chatRoom.findFirst({ where: { kind: "GENERAL" } })) ?? (await prisma.chatRoom.create({ data: { kind: "GENERAL", name: GENERAL_NAME } }));
  await prisma.chatMember.upsert({ where: { roomId_userId: { roomId: room.id, userId } }, create: { roomId: room.id, userId }, update: {} });
  return room;
}

const activeMembers = (room: RoomWithMembers) => room.members.filter((m) => !m.leftAt);

/** What a member may see of the room: messages after they joined without history, minus the temporary ones that are gone. */
function visibleWhere(member: ChatMember, now = new Date()): Prisma.ChatMessageWhereInput {
  return {
    roomId: member.roomId,
    ...(member.historyFrom ? { createdAt: { gte: member.historyFrom } } : {}),
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export async function memberOrThrow(roomId: string, userId: string) {
  const member = await prisma.chatMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
  if (!member || member.leftAt) throw Errors.notFound("Conversa nao encontrada");
  const room = await prisma.chatRoom.findUniqueOrThrow({ where: { id: roomId }, include: { members: true } });
  if (room.deletedAt) throw Errors.notFound("Conversa nao encontrada");
  return { member, room };
}

function toMemberDTO(member: ChatMember, room: ChatRoom, users: Users): ChatMemberDTO {
  const user = users.get(member.userId);
  return {
    userId: member.userId,
    name: user?.name ?? "Usuário removido",
    photoUrl: user?.photoUrl ?? null,
    presence: user?.presence ?? "OFFLINE",
    isOwner: room.ownerId === member.userId,
    isAdmin: member.isAdmin,
  };
}

function messagePreview(message: Pick<ChatMessage, "kind" | "body" | "attachmentName" | "deletedAt" | "viewOnce">): string {
  if (message.deletedAt) return "🚫 Mensagem apagada";
  if (message.kind === "AUDIO") return "🎤 Áudio";
  if (message.kind === "POLL") return `📊 ${message.body ?? "Enquete"}`;
  if (message.kind === "NUDGE") return "⚡ Chamou a atenção";
  if (message.viewOnce) return "① Visualização única";
  return message.body ?? (message.attachmentName ? `📎 ${message.attachmentName}` : "");
}

async function activePins(roomId: string, users: Users, now = new Date()): Promise<ChatPinDTO[]> {
  const pins = await prisma.chatPin.findMany({ where: { roomId, OR: [{ until: null }, { until: { gt: now } }] }, orderBy: { pinnedAt: "desc" } });
  if (!pins.length) return [];
  const messages = await prisma.chatMessage.findMany({ where: { id: { in: pins.map((p) => p.messageId) } } });
  const byId = new Map(messages.map((m) => [m.id, m]));
  const pinners = await usersById(pins.map((p) => p.pinnedById));
  return pins.flatMap((p) => {
    const m = byId.get(p.messageId);
    if (!m || m.deletedAt || (m.expiresAt && m.expiresAt <= now)) return [];
    return [{ messageId: m.id, preview: messagePreview(m), authorName: nameOf(users, m.authorId), pinnedByName: nameOf(pinners, p.pinnedById) ?? "", until: p.until?.toISOString() ?? null }];
  });
}

function canPinIn(room: ChatRoom, me: ChatMember, role: Role) {
  if (room.kind === "DIRECT") return true;
  if (room.kind === "GENERAL") return role !== "AGENT";
  return room.ownerId === me.userId || me.isAdmin;
}

async function toRoomDTO(room: RoomWithMembers, me: ChatMember, users: Users, role: Role): Promise<ChatRoomDTO> {
  const members = activeMembers(room).map((m) => toMemberDTO(m, room, users));
  const visible = visibleWhere(me);
  const unreadWhere: Prisma.ChatMessageWhereInput = {
    AND: [
      visible,
      me.lastReadAt ? { createdAt: { gt: me.lastReadAt } } : {},
      { OR: [{ authorId: null }, { authorId: { not: me.userId } }] },
    ],
  };
  const [last, unreadCount, unreadMentions, pins] = await Promise.all([
    prisma.chatMessage.findFirst({ where: visible, orderBy: { createdAt: "desc" } }),
    prisma.chatMessage.count({ where: unreadWhere }),
    prisma.chatMessage.count({ where: { AND: [unreadWhere, { mentions: { hasSome: [me.userId, MENTION_ALL] } }] } }),
    activePins(room.id, users),
  ]);
  const peer = room.kind === "DIRECT" ? (members.find((m) => m.userId !== me.userId) ?? null) : null;
  const isOwner = room.ownerId === me.userId;
  const manager = room.kind === "GROUP" && (isOwner || me.isAdmin);
  return {
    id: room.id,
    kind: room.kind,
    name: room.kind === "DIRECT" ? (peer?.name ?? "Conversa") : (room.name ?? GENERAL_NAME),
    description: room.description,
    icon: room.icon,
    peer,
    members,
    lastMessage: last ? { body: messagePreview(last), authorName: nameOf(users, last.authorId), createdAt: last.createdAt.toISOString() } : null,
    unreadCount,
    unreadMentions,
    mutedUntil: me.mutedUntil && me.mutedUntil > new Date() ? me.mutedUntil.toISOString() : null,
    favorite: Boolean(me.pinnedAt),
    autoDeleteSeconds: room.kind === "DIRECT" ? room.autoDeleteSeconds : null,
    pins,
    canManageMembers: manager,
    canManageAdmins: room.kind === "GROUP" && isOwner,
    canLeave: room.kind === "GROUP",
    canDelete: room.kind === "GROUP" && isOwner,
    canPin: canPinIn(room, me, role),
    canNudge: room.kind === "DIRECT" || manager,
  };
}

/** The person's app just got whatever is new in their rooms: ✓✓ "entregue" for the senders. */
async function recordDelivery(userId: string, roomIds: string[]) {
  if (!roomIds.length) return;
  const last = await prisma.chatDeliveryMark.findFirst({ where: { userId }, orderBy: { deliveredAt: "desc" } });
  const fresh = await prisma.chatMessage.findMany({
    where: { roomId: { in: roomIds }, authorId: { not: null, notIn: [userId] }, ...(last ? { createdAt: { gt: last.deliveredAt } } : {}) },
    select: { roomId: true },
    distinct: ["roomId"],
  });
  if (!fresh.length) return;
  await prisma.chatDeliveryMark.create({ data: { userId } });
  const rooms = await prisma.chatRoom.findMany({ where: { id: { in: fresh.map((f) => f.roomId) } }, include: { members: true } });
  for (const room of rooms) notify(room, "internal-chat:read", { roomId: room.id }, userId);
}

export async function listRooms(userId: string, role: Role = "AGENT"): Promise<ChatRoomDTO[]> {
  await ensureGeneral(userId);
  const memberships = await prisma.chatMember.findMany({ where: { userId, leftAt: null, room: { deletedAt: null } }, include: { room: { include: { members: true } } } });
  const users = await usersById(memberships.flatMap((m) => m.room.members.map((x) => x.userId)));
  const rooms = await Promise.all(memberships.map((m) => toRoomDTO(m.room, m, users, role)));
  await recordDelivery(userId, memberships.map((m) => m.roomId));
  const pinnedAt = new Map(memberships.map((m) => [m.roomId, m.pinnedAt?.getTime() ?? 0]));
  return rooms.sort((a, b) => {
    if (a.kind === "GENERAL") return -1;
    if (b.kind === "GENERAL") return 1;
    const pin = (pinnedAt.get(b.id) ?? 0) - (pinnedAt.get(a.id) ?? 0);
    if (pin) return pin;
    return (b.lastMessage?.createdAt ?? "").localeCompare(a.lastMessage?.createdAt ?? "");
  });
}

export async function getRoom(roomId: string, userId: string, role: Role = "AGENT"): Promise<ChatRoomDTO> {
  const { member, room } = await memberOrThrow(roomId, userId);
  return toRoomDTO(room, member, await usersById(room.members.map((m) => m.userId)), role);
}

// --- Messages -----------------------------------------------------------------

/** Who, besides the sender, the message is for: current members who were already there when it was sent. */
function recipientsOf(message: Pick<ChatMessage, "authorId" | "createdAt">, room: RoomWithMembers) {
  return room.members.filter((m) => m.userId !== message.authorId && !m.leftAt && m.joinedAt <= message.createdAt && (!m.historyFrom || m.historyFrom <= message.createdAt));
}

interface MessageContext {
  users: Users;
  room: RoomWithMembers;
  contacts: Map<string, string>;
  replies: Map<string, ChatMessage>;
  latestDelivery: Map<string, Date>;
  viewerId: string | null;
  oversight: boolean;
}

function statusOf(message: ChatMessage, ctx: MessageContext): { status: ChatMessageStatus; readByAll: boolean } {
  const recipients = recipientsOf(message, ctx.room);
  if (!message.authorId || recipients.length === 0) return { status: "SENT", readByAll: false };
  const read = recipients.every((r) => r.lastReadAt && r.lastReadAt >= message.createdAt);
  if (read) return { status: "READ", readByAll: true };
  const delivered = recipients.every((r) => (r.lastReadAt && r.lastReadAt >= message.createdAt) || (ctx.latestDelivery.get(r.userId) ?? new Date(0)) >= message.createdAt);
  return { status: delivered ? "DELIVERED" : "SENT", readByAll: false };
}

function toMessageDTO(message: FullMessage, ctx: MessageContext, now = new Date()): ChatMessageDTO {
  const hidden = Boolean(message.deletedAt) && !ctx.oversight;
  const viewedByMe = Boolean(ctx.viewerId && message.views.some((v) => v.userId === ctx.viewerId));
  // A view-once file is offered once to each receiver; the sender (and Gestão) keep it.
  const offerFile = !hidden && (!message.viewOnce || ctx.oversight || message.authorId === ctx.viewerId || !viewedByMe);
  const reply = message.replyToId ? ctx.replies.get(message.replyToId) : undefined;
  const reactions = new Map<string, { names: string[]; mine: boolean }>();
  if (!hidden) {
    for (const r of message.reactions) {
      const entry = reactions.get(r.emoji) ?? { names: [], mine: false };
      entry.names.push(nameOf(ctx.users, r.userId) ?? "");
      if (r.userId === ctx.viewerId) entry.mine = true;
      reactions.set(r.emoji, entry);
    }
  }
  const poll = message.poll && !hidden
    ? {
        id: message.poll.id,
        question: message.poll.question,
        multiple: message.poll.multiple,
        voters: new Set(message.poll.votes.map((v) => v.userId)).size,
        options: message.poll.options.map((o) => {
          const votes = message.poll!.votes.filter((v) => v.optionId === o.id);
          return { id: o.id, text: o.text, votes: votes.length, voterNames: votes.map((v) => nameOf(ctx.users, v.userId) ?? ""), mine: votes.some((v) => v.userId === ctx.viewerId) };
        }),
      }
    : null;
  return {
    id: message.id,
    roomId: message.roomId,
    kind: message.kind,
    authorId: message.authorId,
    authorName: nameOf(ctx.users, message.authorId),
    body: hidden ? null : message.body,
    attachment:
      message.attachmentKey && offerFile
        ? { name: message.attachmentName!, mimeType: message.attachmentMimeType!, size: message.attachmentSize!, url: `/internal-chat/attachments/${message.id}` }
        : null,
    audio: message.kind === "AUDIO" && !hidden ? { durationMs: message.audioDurationMs ?? 0, waveform: message.audioWaveform } : null,
    conversation: message.conversationId && !hidden ? { id: message.conversationId, contactName: ctx.contacts.get(message.conversationId) ?? "Conversa" } : null,
    replyTo: reply
      ? { id: reply.id, authorName: nameOf(ctx.users, reply.authorId), preview: !ctx.oversight && reply.expiresAt && reply.expiresAt <= now ? "Mensagem temporária" : messagePreview(reply) }
      : null,
    mentions: message.mentions,
    poll,
    reactions: [...reactions.entries()].map(([emoji, r]) => ({ emoji, count: r.names.length, names: r.names, mine: r.mine })),
    nudgeTargetId: message.nudgeTargetId,
    nudgeTargetName: nameOf(ctx.users, message.nudgeTargetId),
    ttlSeconds: message.ttlSeconds,
    ttlFromRead: message.ttlFromRead,
    expiresAt: message.expiresAt?.toISOString() ?? null,
    viewOnce: message.viewOnce,
    viewedByMe,
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    ...statusOf(message, ctx),
    ...(ctx.oversight
      ? {
          oversight: {
            expired: Boolean(message.expiresAt && message.expiresAt <= now),
            edits: message.edits.map((e) => ({ body: e.body, editedAt: e.editedAt.toISOString() })),
            viewedBy: message.views.map((v) => ({ name: nameOf(ctx.users, v.userId) ?? "", at: v.viewedAt.toISOString() })),
          },
        }
      : {}),
  };
}

async function latestDeliveries(userIds: string[]) {
  const rows = await prisma.chatDeliveryMark.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _max: { deliveredAt: true } });
  return new Map(rows.map((r) => [r.userId, r._max.deliveredAt!]));
}

async function messagesPage(where: Prisma.ChatMessageWhereInput, room: RoomWithMembers, viewer: { userId: string | null; oversight: boolean }, before?: string): Promise<ChatMessageDTO[]> {
  const rows = await prisma.chatMessage.findMany({
    where: before ? { AND: [where, { createdAt: { lt: new Date(before) } }] } : where,
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    include: messageInclude,
  });
  const replyIds = rows.flatMap((m) => (m.replyToId ? [m.replyToId] : []));
  const replies = replyIds.length ? await prisma.chatMessage.findMany({ where: { id: { in: replyIds } } }) : [];
  const users = await usersById([
    ...rows.flatMap((m) => [m.authorId, m.nudgeTargetId, ...m.reactions.map((r) => r.userId), ...(m.poll?.votes.map((v) => v.userId) ?? []), ...m.views.map((v) => v.userId)]),
    ...replies.map((r) => r.authorId),
    ...room.members.map((m) => m.userId),
  ].filter((id): id is string => Boolean(id)));
  const conversationIds = rows.flatMap((m) => (m.conversationId ? [m.conversationId] : []));
  const conversations = conversationIds.length
    ? await prisma.conversation.findMany({ where: { id: { in: conversationIds } }, select: { id: true, contact: { select: { name: true, phone: true } } } })
    : [];
  const ctx: MessageContext = {
    users,
    room,
    contacts: new Map(conversations.map((c) => [c.id, c.contact.name ?? c.contact.phone ?? "Cliente"])),
    replies: new Map(replies.map((r) => [r.id, r])),
    latestDelivery: await latestDeliveries(room.members.map((m) => m.userId)),
    viewerId: viewer.userId,
    oversight: viewer.oversight,
  };
  return rows.reverse().map((m) => toMessageDTO(m, ctx));
}

export async function listMessages(roomId: string, userId: string, before?: string) {
  const { member, room } = await memberOrThrow(roomId, userId);
  await recordDelivery(userId, [roomId]);
  return messagesPage(visibleWhere(member), room, { userId, oversight: false }, before);
}

async function oneMessage(messageId: string, room: RoomWithMembers, userId: string) {
  const [dto] = await messagesPage({ id: messageId }, room, { userId, oversight: false });
  return dto;
}

function notify(room: RoomWithMembers, event: string, payload: unknown, exceptUserId?: string) {
  realtimeEvents.internalChat(
    activeMembers(room)
      .map((m) => m.userId)
      .filter((id) => id !== exceptUserId),
    event,
    payload
  );
}

/** Gestão › Chat interno follows everything live too (new messages, who is typing). */
async function notifyOversight(event: string, payload: unknown) {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  realtimeEvents.internalChat(admins.map((a) => a.id), event, { ...(payload as object), oversight: true });
}

async function systemLine(room: RoomWithMembers, body: string) {
  await prisma.chatMessage.create({ data: { roomId: room.id, body } });
  notify(room, "internal-chat:message", { roomId: room.id });
  void notifyOversight("internal-chat:message", { roomId: room.id });
}

export interface NewChatMessage {
  body?: string | null;
  conversationId?: string | null;
  replyToId?: string | null;
  mentions?: string[];
  /** "Enviar como temporária": gone this many seconds after sending. */
  ttlSeconds?: number | null;
  viewOnce?: boolean;
  attachment?: { key: string; name: string; mimeType: string; size: number };
  audio?: { durationMs: number; waveform: number[] };
}

async function assertReplyTarget(roomId: string, replyToId: string | null | undefined) {
  if (!replyToId) return;
  const target = await prisma.chatMessage.findUnique({ where: { id: replyToId } });
  if (!target || target.roomId !== roomId || target.deletedAt) throw Errors.badRequest("A mensagem respondida nao existe mais");
}

function validMentions(room: RoomWithMembers, mentions: string[] | undefined, authorId: string) {
  const ids = new Set(activeMembers(room).map((m) => m.userId));
  return [...new Set(mentions ?? [])].filter((id) => id === MENTION_ALL ? room.kind !== "DIRECT" : ids.has(id) && id !== authorId);
}

async function afterSend(room: RoomWithMembers, userId: string, message: ChatMessage) {
  await prisma.chatMember.update({ where: { roomId_userId: { roomId: room.id, userId } }, data: { lastReadAt: message.createdAt } });
  const authorName = await displayName(userId);
  const payload = {
    roomId: room.id,
    authorId: userId,
    authorName,
    preview: messagePreview(message),
    roomName: room.kind === "DIRECT" ? authorName : room.name,
    mentions: message.mentions,
  };
  notify(room, "internal-chat:message", payload, userId);
  void notifyOversight("internal-chat:message", { roomId: room.id });
}

export async function sendMessage(roomId: string, userId: string, input: NewChatMessage): Promise<ChatMessageDTO> {
  const { room } = await memberOrThrow(roomId, userId);
  if (!input.body?.trim() && !input.attachment && !input.conversationId) throw Errors.badRequest("Mensagem vazia");
  if (input.conversationId && !(await prisma.conversation.findUnique({ where: { id: input.conversationId }, select: { id: true } }))) {
    throw Errors.badRequest("Conversa do cliente nao encontrada");
  }
  if (input.viewOnce && !input.attachment) throw Errors.badRequest("Visualizacao unica e so para arquivos");
  await assertReplyTarget(roomId, input.replyToId);
  const now = new Date();
  // A message sent as temporary keeps its own clock; otherwise the direct conversation's autoexplosivas apply.
  const ttl = input.ttlSeconds
    ? { ttlSeconds: input.ttlSeconds, ttlFromRead: false, expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000) }
    : room.kind === "DIRECT" && room.autoDeleteSeconds
      ? { ttlSeconds: room.autoDeleteSeconds, ttlFromRead: true, expiresAt: null }
      : {};
  const message = await prisma.chatMessage.create({
    data: {
      roomId,
      authorId: userId,
      kind: input.audio ? "AUDIO" : "TEXT",
      body: input.body?.trim() || null,
      conversationId: input.conversationId ?? null,
      replyToId: input.replyToId ?? null,
      mentions: validMentions(room, input.mentions, userId),
      viewOnce: Boolean(input.viewOnce),
      attachmentKey: input.attachment?.key,
      attachmentName: input.attachment?.name,
      attachmentMimeType: input.attachment?.mimeType,
      attachmentSize: input.attachment?.size,
      audioDurationMs: input.audio?.durationMs,
      audioWaveform: input.audio?.waveform ?? [],
      createdAt: now,
      ...ttl,
    },
  });
  await afterSend(room, userId, message);
  return oneMessage(message.id, room, userId);
}

async function ownMessageOrThrow(messageId: string, userId: string) {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message) throw Errors.notFound("Mensagem nao encontrada");
  const { room } = await memberOrThrow(message.roomId, userId);
  if (message.authorId !== userId) throw Errors.forbidden("So quem enviou pode mudar a mensagem");
  if (message.deletedAt) throw Errors.badRequest("A mensagem foi apagada");
  if (Date.now() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MINUTES * 60_000) {
    throw Errors.badRequest(`So e possivel mudar a mensagem ate ${CHAT_EDIT_WINDOW_MINUTES} minutos depois de enviar`);
  }
  return { message, room };
}

/** "Editar": the text before each edit is kept for Gestão. */
export async function editMessage(messageId: string, userId: string, body: string): Promise<ChatMessageDTO> {
  const { message, room } = await ownMessageOrThrow(messageId, userId);
  if (message.kind !== "TEXT") throw Errors.badRequest("So mensagens de texto podem ser editadas");
  const text = body.trim();
  if (!text && !message.attachmentKey && !message.conversationId) throw Errors.badRequest("Mensagem vazia");
  if ((text || null) === message.body) return oneMessage(message.id, room, userId);
  await prisma.$transaction([
    prisma.chatMessageEdit.create({ data: { messageId, body: message.body } }),
    prisma.chatMessage.update({ where: { id: messageId }, data: { body: text || null, editedAt: new Date() } }),
  ]);
  notify(room, "internal-chat:message", { roomId: room.id }, userId);
  void notifyOversight("internal-chat:message", { roomId: room.id });
  return oneMessage(message.id, room, userId);
}

/** "Apagar para todos": the others see "Mensagem apagada"; Gestão still sees what it was. */
export async function deleteMessage(messageId: string, userId: string) {
  const { room } = await ownMessageOrThrow(messageId, userId);
  await prisma.chatMessage.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
  await prisma.chatPin.deleteMany({ where: { messageId } });
  notify(room, "internal-chat:message", { roomId: room.id });
  void notifyOversight("internal-chat:message", { roomId: room.id });
}

async function visibleMessageOrThrow(messageId: string, userId: string) {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message) throw Errors.notFound("Mensagem nao encontrada");
  const { member, room } = await memberOrThrow(message.roomId, userId);
  if ((member.historyFrom && message.createdAt < member.historyFrom) || (message.expiresAt && message.expiresAt <= new Date())) {
    throw Errors.notFound("Mensagem nao encontrada");
  }
  return { message, room, member };
}

/** One reaction per person; the same emoji again (or null) takes it back. */
export async function react(messageId: string, userId: string, emoji: string | null) {
  const { message, room } = await visibleMessageOrThrow(messageId, userId);
  if (message.deletedAt || !message.authorId) throw Errors.badRequest("Nao e possivel reagir a esta mensagem");
  const current = await prisma.chatReaction.findUnique({ where: { messageId_userId: { messageId, userId } } });
  if (!emoji || current?.emoji === emoji) {
    if (current) await prisma.chatReaction.delete({ where: { id: current.id } });
  } else {
    await prisma.chatReaction.upsert({ where: { messageId_userId: { messageId, userId } }, create: { messageId, userId, emoji }, update: { emoji, createdAt: new Date() } });
  }
  notify(room, "internal-chat:message", { roomId: room.id }, userId);
  return oneMessage(messageId, room, userId);
}

export async function createPoll(roomId: string, userId: string, input: { question: string; options: string[]; multiple: boolean }) {
  const { room } = await memberOrThrow(roomId, userId);
  const options = [...new Set(input.options.map((o) => o.trim()).filter(Boolean))];
  if (options.length < 2) throw Errors.badRequest("A enquete precisa de pelo menos 2 opcoes diferentes");
  const message = await prisma.chatMessage.create({
    data: {
      roomId,
      authorId: userId,
      kind: "POLL",
      body: input.question.trim(),
      poll: { create: { question: input.question.trim(), multiple: input.multiple, options: { create: options.map((text, position) => ({ text, position })) } } },
    },
  });
  await afterSend(room, userId, message);
  return oneMessage(message.id, room, userId);
}

/** Replaces the person's vote(s); an empty list takes the vote back. */
export async function vote(pollId: string, userId: string, optionIds: string[]) {
  const poll = await prisma.chatPoll.findUnique({ where: { id: pollId }, include: { options: true, message: true } });
  if (!poll) throw Errors.notFound("Enquete nao encontrada");
  const { room } = await visibleMessageOrThrow(poll.messageId, userId);
  if (poll.message.deletedAt) throw Errors.badRequest("A enquete foi apagada");
  const chosen = [...new Set(optionIds)];
  if (chosen.some((id) => !poll.options.some((o) => o.id === id))) throw Errors.badRequest("Opcao invalida");
  if (!poll.multiple && chosen.length > 1) throw Errors.badRequest("Esta enquete aceita so uma resposta");
  await prisma.$transaction([
    prisma.chatPollVote.deleteMany({ where: { pollId, userId } }),
    ...chosen.map((optionId) => prisma.chatPollVote.create({ data: { pollId, optionId, userId } })),
  ]);
  notify(room, "internal-chat:message", { roomId: room.id }, userId);
  return oneMessage(poll.messageId, room, userId);
}

export async function pinMessage(roomId: string, userId: string, role: Role, messageId: string, days: number | null) {
  const { member, room } = await memberOrThrow(roomId, userId);
  if (!canPinIn(room, member, role)) throw Errors.forbidden("So quem criou o grupo e os administradores fixam mensagens");
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message || message.roomId !== roomId || message.deletedAt || !message.authorId) throw Errors.badRequest("Mensagem nao encontrada");
  const now = new Date();
  const active = await prisma.chatPin.count({ where: { roomId, messageId: { not: messageId }, OR: [{ until: null }, { until: { gt: now } }] } });
  if (active >= CHAT_MAX_PINS) throw Errors.badRequest(`Ja ha ${CHAT_MAX_PINS} mensagens fixadas. Desafixe uma antes.`);
  const until = days ? new Date(now.getTime() + days * 86_400_000) : null;
  await prisma.chatPin.upsert({ where: { roomId_messageId: { roomId, messageId } }, create: { roomId, messageId, pinnedById: userId, until }, update: { pinnedById: userId, until, pinnedAt: now } });
  await systemLine(room, `${await displayName(userId)} fixou uma mensagem`);
  return getRoom(roomId, userId, role);
}

export async function unpinMessage(roomId: string, userId: string, role: Role, messageId: string) {
  const { member, room } = await memberOrThrow(roomId, userId);
  if (!canPinIn(room, member, role)) throw Errors.forbidden("So quem criou o grupo e os administradores desafixam mensagens");
  await prisma.chatPin.deleteMany({ where: { roomId, messageId } });
  notify(room, "internal-chat:rooms", {});
  return getRoom(roomId, userId, role);
}

export async function markRead(roomId: string, userId: string) {
  const { room, member } = await memberOrThrow(roomId, userId);
  const now = new Date();
  const unread = await prisma.chatMessage.count({
    where: { roomId, authorId: { not: userId }, ...(member.lastReadAt ? { createdAt: { gt: member.lastReadAt } } : {}) },
  });
  await prisma.chatMember.update({ where: { roomId_userId: { roomId, userId } }, data: { lastReadAt: now } });
  if (unread > 0) await prisma.chatReadMark.create({ data: { roomId, userId, readAt: now } });
  // Mensagens autoexplosivas: the clock of each one starts when the other person reads it.
  const started = await prisma.chatMessage.findMany({ where: { roomId, ttlFromRead: true, expiresAt: null, authorId: { not: userId }, createdAt: { lte: now } } });
  for (const m of started) {
    await prisma.chatMessage.update({ where: { id: m.id }, data: { expiresAt: new Date(now.getTime() + (m.ttlSeconds ?? 0) * 1000) } });
  }
  notify(room, "internal-chat:read", { roomId, userId });
  if (started.length) notify(room, "internal-chat:message", { roomId });
}

export async function typing(roomId: string, userId: string, kind: "typing" | "recording" = "typing") {
  const { room } = await memberOrThrow(roomId, userId);
  const name = await displayName(userId);
  notify(room, "internal-chat:typing", { roomId, userId, name, kind }, userId);
  void notifyOversight("internal-chat:typing", { roomId, userId, name, kind });
}

/** "Dados da mensagem": for the sender, who read it and who only received it, with the time of each. */
export async function messageInfo(messageId: string, userId: string | null): Promise<ChatMessageInfoDTO> {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message || !message.authorId) throw Errors.notFound("Mensagem nao encontrada");
  let room: RoomWithMembers;
  if (userId) {
    ({ room } = await memberOrThrow(message.roomId, userId));
    if (message.authorId !== userId) throw Errors.forbidden("So quem enviou ve os dados da mensagem");
  } else {
    room = await prisma.chatRoom.findUniqueOrThrow({ where: { id: message.roomId }, include: { members: true } });
  }
  const recipients = recipientsOf(message, room);
  const ids = recipients.map((r) => r.userId);
  const [users, reads, deliveries] = await Promise.all([
    usersById(ids),
    prisma.chatReadMark.findMany({ where: { roomId: room.id, userId: { in: ids }, readAt: { gte: message.createdAt } }, orderBy: { readAt: "asc" } }),
    prisma.chatDeliveryMark.findMany({ where: { userId: { in: ids }, deliveredAt: { gte: message.createdAt } }, orderBy: { deliveredAt: "asc" } }),
  ]);
  const firstRead = new Map<string, Date>();
  for (const r of reads) if (!firstRead.has(r.userId)) firstRead.set(r.userId, r.readAt);
  const firstDelivery = new Map<string, Date>();
  for (const d of deliveries) if (!firstDelivery.has(d.userId)) firstDelivery.set(d.userId, d.deliveredAt);
  const person = (id: string) => ({ userId: id, name: users.get(id)?.name ?? "Usuário removido", photoUrl: users.get(id)?.photoUrl ?? null });
  const info: ChatMessageInfoDTO = { readBy: [], deliveredTo: [], pending: [] };
  for (const r of recipients) {
    const readAt = firstRead.get(r.userId) ?? (r.lastReadAt && r.lastReadAt >= message.createdAt ? r.lastReadAt : null);
    const deliveredAt = firstDelivery.get(r.userId) ?? readAt;
    if (readAt) info.readBy.push({ ...person(r.userId), at: readAt.toISOString() });
    else if (deliveredAt) info.deliveredTo.push({ ...person(r.userId), at: deliveredAt.toISOString() });
    else info.pending.push(person(r.userId));
  }
  info.readBy.sort((a, b) => a.at.localeCompare(b.at));
  info.deliveredTo.sort((a, b) => a.at.localeCompare(b.at));
  return info;
}

/** "Chamar a atenção": the receiver's screen shakes. Direct conversations, or a group's owner/admins calling one member. */
export async function nudge(roomId: string, userId: string, targetId?: string) {
  const { member, room } = await memberOrThrow(roomId, userId);
  const others = activeMembers(room).filter((m) => m.userId !== userId);
  let target: string | undefined;
  if (room.kind === "DIRECT") target = others[0]?.userId;
  else if (room.kind === "GROUP") {
    if (room.ownerId !== userId && !member.isAdmin) throw Errors.forbidden("Nos grupos, so quem criou e os administradores chamam a atencao");
    target = others.find((m) => m.userId === targetId)?.userId;
  } else throw Errors.badRequest("Nao e possivel chamar a atencao no #Geral");
  if (!target) throw Errors.badRequest("Escolha quem chamar");
  const since = new Date(Date.now() - CHAT_NUDGE_COOLDOWN_SECONDS * 1000);
  if (await prisma.chatMessage.count({ where: { roomId, authorId: userId, kind: "NUDGE", nudgeTargetId: target, createdAt: { gt: since } } })) {
    throw Errors.badRequest(`Espere ${CHAT_NUDGE_COOLDOWN_SECONDS} segundos para chamar a atencao de novo`);
  }
  const message = await prisma.chatMessage.create({ data: { roomId, authorId: userId, kind: "NUDGE", nudgeTargetId: target } });
  await afterSend(room, userId, message);
  realtimeEvents.internalChat([target], "internal-chat:nudge", { roomId, fromName: await displayName(userId) });
  return oneMessage(message.id, room, userId);
}

/** "Visualização única": the receiver opens the file once; the sender and Gestão keep it. */
export async function attachmentFor(messageId: string, userId: string, oversight: boolean) {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  if (!message?.attachmentKey) throw Errors.notFound("Arquivo nao encontrado");
  if (!oversight) {
    const { member } = await memberOrThrow(message.roomId, userId);
    if (member.historyFrom && message.createdAt < member.historyFrom) throw Errors.notFound("Arquivo nao encontrado");
    if (message.deletedAt || (message.expiresAt && message.expiresAt <= new Date())) throw Errors.notFound("Arquivo nao encontrado");
    if (message.viewOnce && message.authorId !== userId) {
      const seen = await prisma.chatMessageView.findUnique({ where: { messageId_userId: { messageId, userId } } });
      if (seen) throw Errors.notFound("Arquivo de visualizacao unica ja aberto");
      await prisma.chatMessageView.create({ data: { messageId, userId } });
      const room = await prisma.chatRoom.findUniqueOrThrow({ where: { id: message.roomId }, include: { members: true } });
      notify(room, "internal-chat:message", { roomId: room.id });
    }
  }
  return message;
}

export async function searchMessages(userId: string, q: string): Promise<ChatSearchResultDTO[]> {
  const memberships = await prisma.chatMember.findMany({ where: { userId, leftAt: null, room: { deletedAt: null } } });
  const now = new Date();
  const rows = await prisma.chatMessage.findMany({
    where: {
      OR: memberships.map((m) => visibleWhere(m, now)),
      deletedAt: null,
      authorId: { not: null },
      body: { contains: q, mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    include: { room: { include: { members: true } } },
  });
  const users = await usersById(rows.flatMap((r) => [r.authorId!, ...r.room.members.map((m) => m.userId)]));
  return rows.map((r) => ({
    roomId: r.roomId,
    roomName:
      r.room.kind === "DIRECT"
        ? (r.room.members.filter((m) => m.userId !== userId).map((m) => nameOf(users, m.userId))[0] ?? "Conversa")
        : (r.room.name ?? GENERAL_NAME),
    messageId: r.id,
    authorName: nameOf(users, r.authorId),
    body: r.body ?? "",
    createdAt: r.createdAt.toISOString(),
  }));
}

// --- Rooms ----------------------------------------------------------------------

export async function openDirect(userId: string, peerId: string, role: Role = "AGENT"): Promise<ChatRoomDTO> {
  if (userId === peerId) throw Errors.badRequest("Escolha outra pessoa");
  const peer = await prisma.user.findUnique({ where: { id: peerId } });
  if (!peer || peer.status !== "ACTIVE") throw Errors.badRequest("Pessoa nao encontrada");
  const existing = await prisma.chatRoom.findFirst({
    where: { kind: "DIRECT", AND: [{ members: { some: { userId } } }, { members: { some: { userId: peerId } } }] },
  });
  const room = existing ?? (await prisma.chatRoom.create({ data: { kind: "DIRECT", members: { create: [{ userId }, { userId: peerId }] } } }));
  return getRoom(room.id, userId, role);
}

export async function createGroup(userId: string, name: string, memberIds: string[], extra: { description?: string | null; icon?: string | null } = {}): Promise<ChatRoomDTO> {
  const ids = [...new Set(memberIds.filter((id) => id !== userId))];
  const valid = await prisma.user.count({ where: { id: { in: ids }, status: "ACTIVE" } });
  if (valid !== ids.length) throw Errors.badRequest("Alguma pessoa escolhida nao existe ou esta inativa");
  const room = await prisma.chatRoom.create({
    data: {
      kind: "GROUP",
      name,
      ownerId: userId,
      description: extra.description?.trim() || null,
      icon: extra.icon || null,
      members: { create: [{ userId }, ...ids.map((id) => ({ userId: id }))] },
    },
    include: { members: true },
  });
  await systemLine(room, `${await displayName(userId)} criou o grupo`);
  notify(room, "internal-chat:rooms", {});
  return getRoom(room.id, userId);
}

async function groupForManager(roomId: string, userId: string, ownerOnly: boolean) {
  const { member, room } = await memberOrThrow(roomId, userId);
  if (room.kind !== "GROUP") throw Errors.badRequest("So grupos tem membros e administradores");
  const isOwner = room.ownerId === userId;
  if (ownerOnly ? !isOwner : !isOwner && !member.isAdmin) {
    throw Errors.forbidden(ownerOnly ? "So quem criou o grupo pode fazer isso" : "So o dono e os administradores do grupo podem fazer isso");
  }
  return { room, member };
}

export async function updateGroup(roomId: string, userId: string, input: { name?: string; description?: string | null; icon?: string | null }) {
  const { room } = await groupForManager(roomId, userId, false);
  await prisma.chatRoom.update({
    where: { id: roomId },
    data: {
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.icon !== undefined ? { icon: input.icon || null } : {}),
    },
  });
  if (input.name && input.name.trim() !== room.name) await systemLine(room, `${await displayName(userId)} mudou o nome do grupo para "${input.name.trim()}"`);
  notify(room, "internal-chat:rooms", {});
  return getRoom(roomId, userId);
}

export async function addMembers(roomId: string, userId: string, userIds: string[], canSeeHistory: boolean): Promise<ChatRoomDTO> {
  const { room } = await groupForManager(roomId, userId, false);
  const users = await prisma.user.findMany({ where: { id: { in: userIds }, status: "ACTIVE" }, select: { id: true, displayName: true } });
  const now = new Date();
  const added: string[] = [];
  for (const user of users) {
    const current = room.members.find((m) => m.userId === user.id);
    if (current && !current.leftAt) continue;
    await prisma.chatMember.upsert({
      where: { roomId_userId: { roomId, userId: user.id } },
      create: { roomId, userId: user.id, historyFrom: canSeeHistory ? null : now },
      update: { leftAt: null, removedById: null, isAdmin: false, joinedAt: now, lastReadAt: null, historyFrom: canSeeHistory ? null : now },
    });
    added.push(user.displayName);
  }
  if (added.length) {
    const fresh = await prisma.chatRoom.findUniqueOrThrow({ where: { id: roomId }, include: { members: true } });
    await systemLine(fresh, `${await displayName(userId)} adicionou ${added.join(", ")}`);
    notify(fresh, "internal-chat:rooms", {});
  }
  return getRoom(roomId, userId);
}

export async function setAdmin(roomId: string, userId: string, targetId: string, admin: boolean): Promise<ChatRoomDTO> {
  const { room } = await groupForManager(roomId, userId, true);
  const target = room.members.find((m) => m.userId === targetId && !m.leftAt);
  if (!target || targetId === room.ownerId) throw Errors.badRequest("Escolha um membro do grupo");
  await prisma.chatMember.update({ where: { id: target.id }, data: { isAdmin: admin } });
  notify(room, "internal-chat:rooms", {});
  return getRoom(roomId, userId);
}

/** The owner removes anyone; an admin removes members who aren't admins. */
export async function removeMember(roomId: string, userId: string, targetId: string): Promise<ChatRoomDTO> {
  const { room } = await groupForManager(roomId, userId, false);
  const target = room.members.find((m) => m.userId === targetId && !m.leftAt);
  if (!target || targetId === userId) throw Errors.badRequest("Escolha um membro do grupo");
  if (targetId === room.ownerId) throw Errors.forbidden("Quem criou o grupo nao pode ser removido");
  if (room.ownerId !== userId && target.isAdmin) throw Errors.forbidden("So quem criou o grupo remove administradores");
  await prisma.chatMember.update({ where: { id: target.id }, data: { leftAt: new Date(), isAdmin: false, removedById: userId, mutedUntil: null, pinnedAt: null } });
  const fresh = await prisma.chatRoom.findUniqueOrThrow({ where: { id: roomId }, include: { members: true } });
  await systemLine(fresh, `${await displayName(userId)} removeu ${await displayName(targetId)}`);
  notify(fresh, "internal-chat:rooms", {});
  realtimeEvents.internalChat([targetId], "internal-chat:rooms", {});
  return getRoom(roomId, userId);
}

/** Only the owner. Everyone leaves at once and the group is gone for them; Gestão keeps it as "finalizado". */
export async function deleteGroup(roomId: string, userId: string) {
  const { room } = await groupForManager(roomId, userId, true);
  const now = new Date();
  const name = await displayName(userId);
  const memberIds = activeMembers(room).map((m) => m.userId);
  await prisma.chatMessage.create({ data: { roomId, body: `${name} excluiu o grupo`, createdAt: now } });
  await prisma.$transaction([
    prisma.chatMember.updateMany({ where: { roomId, leftAt: null }, data: { leftAt: now, isAdmin: false, removedById: userId, pinnedAt: null, mutedUntil: null } }),
    prisma.chatRoom.update({ where: { id: roomId }, data: { deletedAt: now, deletedById: userId } }),
  ]);
  realtimeEvents.internalChat(memberIds, "internal-chat:rooms", { deletedRoomId: roomId });
  void notifyOversight("internal-chat:rooms", {});
}

/** Leaving makes the group disappear for that person; the owner's role passes to the oldest admin, else the oldest member. */
export async function leaveGroup(roomId: string, userId: string) {
  const { room } = await memberOrThrow(roomId, userId);
  if (room.kind !== "GROUP") throw Errors.badRequest("So e possivel sair de grupos");
  await prisma.chatMember.update({ where: { roomId_userId: { roomId, userId } }, data: { leftAt: new Date(), isAdmin: false, pinnedAt: null, mutedUntil: null } });
  if (room.ownerId === userId) {
    const remaining = activeMembers(room)
      .filter((m) => m.userId !== userId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    const next = remaining.find((m) => m.isAdmin) ?? remaining[0] ?? null;
    await prisma.chatRoom.update({ where: { id: roomId }, data: { ownerId: next?.userId ?? null } });
  }
  const fresh = await prisma.chatRoom.findUniqueOrThrow({ where: { id: roomId }, include: { members: true } });
  await systemLine(fresh, `${await displayName(userId)} saiu do grupo`);
  notify(fresh, "internal-chat:rooms", {});
  realtimeEvents.internalChat([userId], "internal-chat:rooms", {});
}

/** Direct conversation: "mensagens autoexplosivas" for the messages sent from now on. */
export async function setAutoDelete(roomId: string, userId: string, seconds: number | null) {
  const { room } = await memberOrThrow(roomId, userId);
  if (room.kind !== "DIRECT") throw Errors.badRequest("Mensagens autoexplosivas sao so para conversas individuais");
  if ((room.autoDeleteSeconds ?? null) === seconds) return getRoom(roomId, userId);
  await prisma.chatRoom.update({ where: { id: roomId }, data: { autoDeleteSeconds: seconds } });
  const name = await displayName(userId);
  await systemLine(room, seconds ? `${name} ativou as mensagens autoexplosivas: somem ${chatDurationLabel(seconds)} depois de lidas` : `${name} desativou as mensagens autoexplosivas`);
  notify(room, "internal-chat:rooms", {});
  return getRoom(roomId, userId);
}

export async function setMuted(roomId: string, userId: string, until: Date | null) {
  await memberOrThrow(roomId, userId);
  await prisma.chatMember.update({ where: { roomId_userId: { roomId, userId } }, data: { mutedUntil: until } });
  return getRoom(roomId, userId);
}

export async function setFavorite(roomId: string, userId: string, favorite: boolean) {
  const { room } = await memberOrThrow(roomId, userId);
  if (room.kind === "GENERAL") throw Errors.badRequest("O #Geral ja fica sempre no topo");
  if (favorite) {
    const count = await prisma.chatMember.count({ where: { userId, leftAt: null, pinnedAt: { not: null }, roomId: { not: roomId } } });
    if (count >= CHAT_MAX_FAVORITES) throw Errors.badRequest(`Voce ja fixou ${CHAT_MAX_FAVORITES} conversas`);
  }
  await prisma.chatMember.update({ where: { roomId_userId: { roomId, userId } }, data: { pinnedAt: favorite ? new Date() : null } });
  return getRoom(roomId, userId);
}

// --- Gestão › Chat interno (administrador; no signal to who is talking) --------------

export async function oversightRooms(): Promise<ChatOversightRoomDTO[]> {
  const rooms = await prisma.chatRoom.findMany({ include: { members: true }, orderBy: { createdAt: "asc" } });
  const users = await usersById(rooms.flatMap((r) => [...r.members.flatMap((m) => [m.userId, m.removedById ?? ""]), r.deletedById ?? ""]).filter(Boolean));
  const result: ChatOversightRoomDTO[] = [];
  for (const room of rooms) {
    const last = await prisma.chatMessage.findFirst({ where: { roomId: room.id }, orderBy: { createdAt: "desc" } });
    const members = activeMembers(room).map((m) => toMemberDTO(m, room, users));
    // A deleted group: show who was in it at the end, not an empty list.
    const shown = room.deletedAt ? room.members.filter((m) => m.leftAt?.getTime() === room.deletedAt!.getTime()).map((m) => toMemberDTO(m, room, users)) : members;
    const formerMembers: ChatFormerMemberDTO[] = room.members
      .filter((m) => m.leftAt && !(room.deletedAt && m.leftAt.getTime() === room.deletedAt.getTime()))
      .map((m) => ({ userId: m.userId, name: nameOf(users, m.userId) ?? "", leftAt: m.leftAt!.toISOString(), removedByName: nameOf(users, m.removedById) }));
    result.push({
      id: room.id,
      kind: room.kind,
      name: room.kind === "DIRECT" ? room.members.map((m) => nameOf(users, m.userId)).join(" ↔ ") : (room.name ?? GENERAL_NAME),
      icon: room.icon,
      members: shown,
      formerMembers,
      lastMessageAt: last?.createdAt.toISOString() ?? null,
      autoDeleteSeconds: room.kind === "DIRECT" ? room.autoDeleteSeconds : null,
      pins: await activePins(room.id, users),
      deletedAt: room.deletedAt?.toISOString() ?? null,
      deletedByName: nameOf(users, room.deletedById),
      createdAt: room.createdAt.toISOString(),
    });
  }
  return result.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
}

export async function oversightMessages(roomId: string, before?: string) {
  const room = await prisma.chatRoom.findUnique({ where: { id: roomId }, include: { members: true } });
  if (!room) throw Errors.notFound("Conversa nao encontrada");
  return messagesPage({ roomId }, room, { userId: null, oversight: true }, before);
}
