import { Prisma, type MessageType, type Role } from "@prisma/client";
import { PERMISSION, type GroupListItemDTO, type GroupReaderDTO, type GroupsSummaryDTO } from "@whatsatendende/types";
import type { GroupInfo, HistoryMessageEvent, InboundMessageEvent } from "@whatsatendende/whatsapp";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { isPermissionAllowed } from "../../lib/permissions";
import { getManagerConnectionIds } from "../../lib/connection-access";
import { realtimeEvents } from "../../realtime/realtime";
import { messageInclude } from "../messages/messages.service";
import { addHistoricalAttachments, fillPollKey } from "../conversations/conversations.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";

/**
 * WhatsApp groups in Atendimento (see PROMPT: "os atendentes vejam os grupos
 * separadamente … a notificação de mensagem não lida do grupo seja para todos
 * e que todos devem abrir o grupo para visualizar as mensagens não lidas por
 * ele"). A group is a Contact (isGroup) with one Conversation in status GROUP;
 * what each person has read lives in GroupReadState, so "não lida" is
 * individual: one person opening the group never clears it for anyone else.
 */

type Auth = { userId: string; role: Role };

const UNREAD_CAP = 999;

/** The WhatsApp connections whose groups this person sees — empty without the "Ver grupos" permission. */
export async function visibleGroupConnectionIds(auth: Auth): Promise<string[]> {
  if (!(await isPermissionAllowed(auth.role, PERMISSION.ATENDIMENTO_GRUPOS_VISUALIZAR))) return [];
  let ids: string[] | null;
  if (auth.role === "ADMIN") ids = null;
  else if (auth.role === "MANAGER") ids = await getManagerConnectionIds(auth.userId, "receive");
  else {
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { whatsappConnectionId: true } });
    ids = user?.whatsappConnectionId ? [user.whatsappConnectionId] : [];
  }
  const rows = await prisma.whatsAppConnection.findMany({
    where: { groupsEnabled: true, connectionMode: "QRCODE", ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

type TeamMember = { id: string; displayName: string; photoUrl: string | null; role: Role };

/**
 * Who of the team sees a connection's groups and gets their notices: its
 * agents, the managers who receive its conversations, and the administrators
 * who attend it themselves. `groupId` adds the administrators who already
 * opened that group (an administrator sees every group, but is only told
 * about the ones that are theirs to follow).
 */
async function groupTeam(connectionId: string, groupId?: string): Promise<TeamMember[]> {
  const [agentsAllowed, managersAllowed] = await Promise.all([
    isPermissionAllowed("AGENT", PERMISSION.ATENDIMENTO_GRUPOS_VISUALIZAR),
    isPermissionAllowed("MANAGER", PERMISSION.ATENDIMENTO_GRUPOS_VISUALIZAR),
  ]);
  const or: Prisma.UserWhereInput[] = [{ role: "ADMIN", whatsappConnectionId: connectionId }];
  if (groupId) or.push({ role: "ADMIN", groupReadStates: { some: { conversationId: groupId } } });
  if (agentsAllowed) or.push({ role: "AGENT", whatsappConnectionId: connectionId });
  if (managersAllowed) {
    or.push({
      role: "MANAGER",
      OR: [
        { createdConnections: { some: { id: connectionId } } },
        { connectionGrants: { some: { whatsappConnectionId: connectionId, canReceiveConversations: true } } },
      ],
    });
  }
  return prisma.user.findMany({
    where: { status: "ACTIVE", OR: or },
    select: { id: true, displayName: true, photoUrl: true, role: true },
    orderBy: { displayName: "asc" },
  });
}

type ReadRow = { conversationId: string; userId: string; lastReadAt: Date | null; mutedAt: Date | null; unread: number };

/**
 * Each person's unread count in each group: the messages newer than their
 * last reading — or, if they never opened it, newer than when they could
 * first see it (groups turned on, or their user created) — minus the ones
 * they sent themselves. One query for every (group, person) pair asked.
 */
async function readRows(conversationIds: string[], userIds: string[]): Promise<ReadRow[]> {
  if (conversationIds.length === 0 || userIds.length === 0) return [];
  return prisma.$queryRaw<ReadRow[]>`
    SELECT c.id AS "conversationId", u.id AS "userId", r."lastReadAt", r."mutedAt",
      (SELECT COUNT(*)::int FROM (
         SELECT 1 FROM "Message" m
         WHERE m."conversationId" = c.id
           AND m."deletedAt" IS NULL
           AND m."createdAt" > COALESCE(r."lastReadAt", GREATEST(w."groupsEnabledAt", u."createdAt"))
           AND (m."senderAgentId" IS NULL OR m."senderAgentId" <> u.id)
         LIMIT ${UNREAD_CAP}
      ) unread) AS unread
    FROM "Conversation" c
    JOIN "WhatsAppConnection" w ON w.id = c."whatsappConnectionId"
    CROSS JOIN "User" u
    LEFT JOIN "GroupReadState" r ON r."conversationId" = c.id AND r."userId" = u.id
    WHERE c.id IN (${Prisma.join(conversationIds)}) AND u.id IN (${Prisma.join(userIds)})`;
}

function key(conversationId: string, userId: string) {
  return `${conversationId}:${userId}`;
}

const MESSAGE_TYPE_LABEL: Record<string, string> = {
  IMAGE: "📷 Foto",
  VIDEO: "🎥 Vídeo",
  AUDIO: "🎤 Áudio",
  DOCUMENT: "📄 Documento",
  LOCATION: "📍 Localização",
  CONTACT: "👤 Contato",
  POLL: "📊 Enquete",
  EVENT: "📅 Evento",
};

function previewText(message: { body: string | null; type: string }): string {
  return message.body?.trim() || MESSAGE_TYPE_LABEL[message.type] || "Mensagem";
}

function senderLabel(message: { direction: string; senderParticipantName: string | null; senderParticipantPhone: string | null; senderAgent: { displayName: string } | null }): string {
  if (message.direction === "INBOUND") return message.senderParticipantName ?? message.senderParticipantPhone ?? "Participante";
  return message.senderAgent?.displayName ?? "Celular";
}

/** Atendimento's Grupos tab: every group this person sees, with their own unread count and the team's reading. */
export async function listGroupsForUser(auth: Auth, connectionIds?: string[]): Promise<GroupListItemDTO[]> {
  let allowed = await visibleGroupConnectionIds(auth);
  if (connectionIds?.length) allowed = allowed.filter((id) => connectionIds.includes(id));
  if (allowed.length === 0) return [];
  const groups = await prisma.conversation.findMany({
    where: { status: "GROUP", whatsappConnectionId: { in: allowed } },
    include: { contact: true, whatsappConnection: true },
    orderBy: { lastMessageAt: "desc" },
  });
  if (groups.length === 0) return [];

  const teams = new Map<string, TeamMember[]>();
  for (const g of groups) teams.set(g.id, await groupTeam(g.whatsappConnectionId!, g.id));
  const userIds = new Set<string>([auth.userId]);
  for (const team of teams.values()) for (const m of team) userIds.add(m.id);
  const rows = await readRows(
    groups.map((g) => g.id),
    [...userIds]
  );
  const byKey = new Map(rows.map((r) => [key(r.conversationId, r.userId), r]));

  const lastMessages = await prisma.message.findMany({
    where: { conversationId: { in: groups.map((g) => g.id) }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    distinct: ["conversationId"],
    include: { senderAgent: { select: { displayName: true } } },
  });
  const lastByGroup = new Map(lastMessages.map((m) => [m.conversationId, m]));

  return groups.map((g) => {
    const mine = byKey.get(key(g.id, auth.userId));
    const last = lastByGroup.get(g.id);
    const readers: GroupReaderDTO[] = (teams.get(g.id) ?? []).map((m) => {
      const row = byKey.get(key(g.id, m.id));
      return {
        userId: m.id,
        name: m.displayName,
        photoUrl: m.photoUrl,
        neverOpened: !row?.lastReadAt,
        lastReadAt: row?.lastReadAt?.toISOString() ?? null,
        unreadCount: row?.unread ?? 0,
        isMe: m.id === auth.userId,
      };
    });
    return {
      id: g.id,
      name: g.contact.name ?? "Grupo",
      photoUrl: g.contact.photoUrl,
      participantsCount: g.contact.groupParticipantsCount,
      whatsappConnectionId: g.whatsappConnectionId!,
      whatsappConnectionName: g.whatsappConnection!.name,
      whatsappConnectionColor: g.whatsappConnection!.color,
      whatsappConnectionStatus: g.whatsappConnection!.status,
      lastMessageAt: g.lastMessageAt.toISOString(),
      lastMessagePreview: last ? { senderName: senderLabel(last), text: previewText(last) } : null,
      unreadCount: mine?.unread ?? 0,
      myLastReadAt: mine?.lastReadAt?.toISOString() ?? null,
      muted: Boolean(mine?.mutedAt),
      readers,
    };
  });
}

/** The badge on the Atendimento menu and on the Grupos tab. */
export async function getGroupsSummary(auth: Auth): Promise<GroupsSummaryDTO> {
  const allowed = await visibleGroupConnectionIds(auth);
  if (allowed.length === 0) return { groupsWithUnread: 0, unreadMessages: 0 };
  const groups = await prisma.conversation.findMany({ where: { status: "GROUP", whatsappConnectionId: { in: allowed } }, select: { id: true } });
  const rows = await readRows(
    groups.map((g) => g.id),
    [auth.userId]
  );
  return {
    groupsWithUnread: rows.filter((r) => r.unread > 0).length,
    unreadMessages: rows.reduce((sum, r) => sum + r.unread, 0),
  };
}

/** The group, if this person may see it — 404 otherwise, so a group id from elsewhere tells nothing. */
export async function getGroupForUser(groupId: string, auth: Auth) {
  const group = await prisma.conversation.findUnique({ where: { id: groupId }, include: { contact: true, whatsappConnection: true } });
  if (!group || group.status !== "GROUP") throw Errors.notFound("Grupo nao encontrado");
  const allowed = await visibleGroupConnectionIds(auth);
  if (!allowed.includes(group.whatsappConnectionId!)) throw Errors.notFound("Grupo nao encontrado");
  return group;
}

export async function listGroupMessages(groupId: string, cursor: string | undefined, limit: number) {
  const messages = await prisma.message.findMany({
    where: { conversationId: groupId, deletedAt: null },
    include: messageInclude,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;
  return { items: page.reverse(), nextCursor: hasMore ? page[0].id : null };
}

/**
 * Opening the group marks it read for this person only. The first person of
 * the team to read new messages also sends WhatsApp's read receipt, so the
 * linked phone doesn't pile up unread groups (returns those messages for the
 * caller to send).
 */
export async function markGroupRead(groupId: string, userId: string): Promise<{ id: string; providerMessageId: string; participantJid: string | null }[]> {
  const now = new Date();
  await prisma.groupReadState.upsert({
    where: { conversationId_userId: { conversationId: groupId, userId } },
    create: { conversationId: groupId, userId, lastReadAt: now, firstOpenedAt: now, lastOpenedAt: now },
    update: { lastReadAt: now, lastOpenedAt: now },
  });
  await prisma.notification.updateMany({ where: { userId, entityType: "Group", entityId: groupId, readAt: null }, data: { readAt: now } });

  const firstReads = await prisma.message.findMany({
    where: { conversationId: groupId, direction: "INBOUND", readAt: null, providerMessageId: { not: null }, createdAt: { lte: now } },
    select: { id: true, providerMessageId: true, senderParticipantJid: true },
  });
  if (firstReads.length > 0) {
    await prisma.message.updateMany({ where: { id: { in: firstReads.map((m) => m.id) } }, data: { readAt: now } });
  }

  const group = await prisma.conversation.findUnique({ where: { id: groupId }, select: { whatsappConnectionId: true } });
  const team = await groupTeam(group!.whatsappConnectionId!, groupId);
  realtimeEvents.groupRead(
    team.map((m) => m.id),
    groupId,
    userId
  );
  return firstReads.map((m) => ({ id: m.id, providerMessageId: m.providerMessageId!, participantJid: m.senderParticipantJid }));
}

/**
 * A reply in a group, recorded before it goes to WhatsApp (like a reply to a
 * customer) with the person as its sender — the bubble shows their name. Who
 * writes is up to date with the group from that moment on.
 */
export async function createGroupOutboundMessage(input: { groupId: string; userId: string; type: MessageType; body: string | null; replyToMessageId?: string | null }) {
  const message = await prisma.message.create({
    data: {
      conversationId: input.groupId,
      direction: "OUTBOUND",
      type: input.type,
      status: "PENDING",
      body: input.body,
      senderAgentId: input.userId,
      replyToMessageId: input.replyToMessageId ?? null,
    },
    include: messageInclude,
  });
  await prisma.conversation.update({ where: { id: input.groupId }, data: { lastMessageAt: message.createdAt, lastMessageDirection: "OUTBOUND" } });
  await prisma.groupReadState.upsert({
    where: { conversationId_userId: { conversationId: input.groupId, userId: input.userId } },
    create: { conversationId: input.groupId, userId: input.userId, lastReadAt: message.createdAt, firstOpenedAt: message.createdAt, lastOpenedAt: message.createdAt },
    update: { lastReadAt: message.createdAt },
  });
  return message;
}

/** Silences this group's notices for one person — it still counts as unread for them. */
export async function setGroupMuted(groupId: string, userId: string, muted: boolean): Promise<void> {
  const existing = await prisma.groupReadState.findUnique({ where: { conversationId_userId: { conversationId: groupId, userId } } });
  if (existing) {
    await prisma.groupReadState.update({ where: { conversationId_userId: { conversationId: groupId, userId } }, data: { mutedAt: muted ? new Date() : null } });
    return;
  }
  if (!muted) return;
  // Never opened: muting must not mark anything as read, so the reading starts where theirs would.
  const [group, user] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: groupId }, include: { whatsappConnection: { select: { groupsEnabledAt: true } } } }),
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
  ]);
  const enabledAt = group?.whatsappConnection?.groupsEnabledAt ?? new Date(0);
  const start = user && user.createdAt > enabledAt ? user.createdAt : enabledAt;
  await prisma.groupReadState.create({ data: { conversationId: groupId, userId, lastReadAt: start, mutedAt: new Date() } });
}

/** The group's Contact + Conversation, created on its first message (or when groups are turned on). */
export async function findOrCreateGroup(connectionId: string, chatId: string, info?: GroupInfo | null) {
  let contact = await prisma.contact.findFirst({ where: { whatsappConnectionId: connectionId, providerChatId: chatId } });
  if (!contact) {
    try {
      contact = await prisma.contact.create({
        data: {
          whatsappConnectionId: connectionId,
          providerChatId: chatId,
          isGroup: true,
          name: info?.subject ?? "Grupo",
          groupParticipantsCount: info?.participants.length ?? null,
        },
      });
    } catch (err) {
      // Two messages of a brand-new group at the same moment: the other one created it.
      if ((err as { code?: string }).code !== "P2002") throw err;
      contact = await prisma.contact.findFirstOrThrow({ where: { whatsappConnectionId: connectionId, providerChatId: chatId } });
    }
  } else if (info && (contact.name !== info.subject || contact.groupParticipantsCount !== info.participants.length)) {
    contact = await prisma.contact.update({ where: { id: contact.id }, data: { name: info.subject, groupParticipantsCount: info.participants.length } });
  }
  let conversation = await prisma.conversation.findFirst({ where: { contactId: contact.id, status: "GROUP" } });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "GROUP", channel: "WHATSAPP", lastMessageAt: new Date(0) },
    });
  }
  return { contact, conversation };
}

/** When groups are turned on: brings every group of the number in, with its name and size, so the tab isn't empty until somebody writes. */
export async function syncGroups(connectionId: string, groups: GroupInfo[]): Promise<void> {
  for (const info of groups) await findOrCreateGroup(connectionId, info.chatId, info);
}

export interface InboundGroupMessageDeps {
  getGroupInfo: (chatId: string) => Promise<GroupInfo | null>;
  addAttachments: (messageId: string, event: InboundMessageEvent) => Promise<void>;
}

/**
 * A message in a group, from a participant or typed on the linked phone.
 * Never touches the queue, Fluxo, @menção, the satisfaction survey or any
 * automatic message — it is stored and everybody who sees the group is told.
 */
export function handleInboundGroupMessage(connectionId: string, event: InboundMessageEvent, deps: InboundGroupMessageDeps): Promise<void> {
  // One group's messages are stored and announced one at a time, in the order they came: the bell
  // entry always ends with the latest one, and a brand-new group is created once.
  const queueKey = `${connectionId}:${event.chatId}`;
  const next = (groupQueues.get(queueKey) ?? Promise.resolve()).then(() => storeInboundGroupMessage(connectionId, event, deps));
  const settled = next.catch((err) => logger.error({ err, connectionId }, "failed to process a WhatsApp group message"));
  groupQueues.set(queueKey, settled);
  void settled.finally(() => {
    if (groupQueues.get(queueKey) === settled) groupQueues.delete(queueKey);
  });
  return next;
}

const groupQueues = new Map<string, Promise<void>>();

async function storeInboundGroupMessage(connectionId: string, event: InboundMessageEvent, deps: InboundGroupMessageDeps): Promise<void> {
  const connection = await prisma.whatsAppConnection.findUnique({ where: { id: connectionId }, select: { groupsEnabled: true } });
  if (!connection?.groupsEnabled) return;
  if (event.providerMessageId && (await prisma.message.findUnique({ where: { providerMessageId: event.providerMessageId } }))) return; // our own send echoing back

  const known = await prisma.contact.findFirst({ where: { whatsappConnectionId: connectionId, providerChatId: event.chatId }, select: { id: true } });
  const info = known ? null : await deps.getGroupInfo(event.chatId).catch(() => null);
  const { conversation, contact } = await findOrCreateGroup(connectionId, event.chatId, info);

  const replyTo = event.replyToProviderMessageId ? await prisma.message.findUnique({ where: { providerMessageId: event.replyToProviderMessageId } }) : null;
  const participantName = event.group?.participantName ?? (event.group?.participantPhone ? await savedContactName(connectionId, event.group.participantPhone) : null);
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: event.fromMe ? "OUTBOUND" : "INBOUND",
      type: event.type,
      status: event.fromMe ? "SENT" : "DELIVERED",
      body: event.body,
      providerMessageId: event.providerMessageId || null,
      replyToMessageId: replyTo?.id ?? null,
      createdAt: event.fromMe ? event.timestamp : undefined,
      linkPreviewTitle: event.linkPreviewTitle ?? null,
      linkPreviewDescription: event.linkPreviewDescription ?? null,
      linkPreviewUrl: event.linkPreviewUrl ?? null,
      linkPreviewThumbnail: event.linkPreviewThumbnailBase64 ?? null,
      ...(event.fromMe
        ? {}
        : {
            senderParticipantJid: event.group?.participantJid || null,
            senderParticipantName: participantName,
            senderParticipantPhone: event.group?.participantPhone ?? null,
          }),
    },
  });
  await deps.addAttachments(message.id, event);
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt, lastMessageDirection: message.direction } });

  const senderName = event.fromMe ? "Celular" : (participantName ?? event.group?.participantPhone ?? "Participante");
  await announceGroupMessage(conversation.id, connectionId, contact.name ?? "Grupo", senderName, previewText({ body: event.body, type: event.type }), null);
}

/** A participant's reaction changed: everybody who sees the group gets it redrawn. */
export async function announceGroupReaction(groupId: string, connectionId: string): Promise<void> {
  const team = await groupTeam(connectionId, groupId);
  realtimeEvents.groupReaction(
    team.map((m) => m.id),
    groupId
  );
}

/** A participant's name as known to this connection (they may also be a customer with a conversation). */
async function savedContactName(connectionId: string, phone: string): Promise<string | null> {
  const contact = await prisma.contact.findFirst({ where: { whatsappConnectionId: connectionId, phone, isGroup: false }, select: { name: true } });
  return contact?.name ?? null;
}

/**
 * Tells everybody who sees the group: the list refreshes, a notice pops up
 * (unless they silenced it or wrote it themselves), and the bell gets ONE
 * entry per person and group — updated with the count, not one per message.
 */
export async function announceGroupMessage(groupId: string, connectionId: string, groupName: string, senderName: string, preview: string, senderUserId: string | null): Promise<void> {
  const team = await groupTeam(connectionId, groupId);
  const rows = await readRows(
    [groupId],
    team.map((m) => m.id)
  );
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  for (const member of team) {
    const row = byUser.get(member.id);
    const notify = member.id !== senderUserId && !row?.mutedAt && (row?.unread ?? 0) > 0;
    realtimeEvents.groupMessage(member.id, { conversationId: groupId, connectionId, groupName, senderName, preview, notify });
    if (!notify) continue;
    const unread = row!.unread;
    const body = `${unread >= UNREAD_CAP ? `${UNREAD_CAP}+` : unread} ${unread === 1 ? "mensagem não lida" : "mensagens não lidas"} · ${senderName}: ${preview}`;
    try {
      const existing = await prisma.notification.findFirst({ where: { userId: member.id, entityType: "Group", entityId: groupId, readAt: null } });
      const notification = existing
        ? await prisma.notification.update({ where: { id: existing.id }, data: { title: groupName, body, createdAt: new Date() } })
        : await prisma.notification.create({ data: { userId: member.id, type: "GROUP_MESSAGE", title: groupName, body, entityType: "Group", entityId: groupId } });
      realtimeEvents.notificationCreated(member.id, toNotificationDTO(notification));
    } catch (err) {
      logger.error({ err, groupId, userId: member.id }, "failed to update a group notification");
    }
  }
  realtimeEvents.groupsChanged();
}

/** Someone of the group is typing or recording (or stopped): everybody who sees the group shows it. */
export async function announceGroupTyping(groupId: string, connectionId: string, who: { typing: boolean; kind: "typing" | "recording"; participant: string; name: string }) {
  const team = await groupTeam(connectionId, groupId);
  realtimeEvents.groupTyping(
    team.map((m) => m.id),
    groupId,
    who
  );
}

/** The oldest message stored for a group — older history is asked for from before it (null: nothing to start from yet). */
export async function getOldestGroupAnchor(groupId: string) {
  const message = await prisma.message.findFirst({
    where: { conversationId: groupId, providerMessageId: { not: null }, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { providerMessageId: true, direction: true, createdAt: true, senderParticipantJid: true },
  });
  if (!message?.providerMessageId) return null;
  return {
    providerMessageId: message.providerMessageId,
    fromMe: message.direction === "OUTBOUND",
    timestamp: message.createdAt,
    participant: message.direction === "INBOUND" ? message.senderParticipantJid : null,
  };
}

/**
 * Older messages of groups the app already shows, from a WhatsApp history
 * batch (see the "Carregar mensagens anteriores" button). They come in as
 * already read — by everybody, and for WhatsApp's read receipt too — so an
 * old conversation never turns into a pile of "não lidas". Messages of groups
 * the app doesn't show (groups off, or a group it never saw) are left out.
 * Returns how many were added per group.
 */
export async function importGroupHistory(connectionId: string, messages: HistoryMessageEvent[]): Promise<Map<string, number>> {
  const added = new Map<string, number>();
  if (messages.length === 0) return added;
  const connection = await prisma.whatsAppConnection.findUnique({ where: { id: connectionId }, select: { groupsEnabled: true } });
  if (!connection?.groupsEnabled) return added;

  const chatIds = [...new Set(messages.map((m) => m.chatId))];
  const groups = await prisma.conversation.findMany({
    where: { status: "GROUP", whatsappConnectionId: connectionId, contact: { providerChatId: { in: chatIds } } },
    select: { id: true, lastMessageAt: true, contact: { select: { providerChatId: true } } },
  });
  const groupByChat = new Map(groups.map((g) => [g.contact.providerChatId!, g]));
  const known = new Set(
    (await prisma.message.findMany({ where: { providerMessageId: { in: messages.map((m) => m.providerMessageId) } }, select: { providerMessageId: true } })).map((m) => m.providerMessageId)
  );
  const now = new Date();

  for (const m of messages) {
    const group = groupByChat.get(m.chatId);
    if (!group) continue;
    if (known.has(m.providerMessageId)) {
      // A poll saved without its key gets it from this copy.
      if (m.type === "POLL" && m.pollSecret) {
        const saved = await prisma.message.findUnique({ where: { providerMessageId: m.providerMessageId }, select: { id: true } });
        if (saved) await fillPollKey(saved.id, m);
      }
      continue;
    }
    known.add(m.providerMessageId);
    const participantName = m.group?.participantName ?? (m.group?.participantPhone ? await savedContactName(connectionId, m.group.participantPhone) : null);
    const created = await prisma.message.create({
      data: {
        conversationId: group.id,
        direction: m.fromMe ? "OUTBOUND" : "INBOUND",
        type: m.type,
        status: m.fromMe ? "SENT" : "DELIVERED",
        body: m.body,
        providerMessageId: m.providerMessageId,
        createdAt: m.timestamp,
        readAt: m.fromMe ? null : now,
        ...(m.fromMe
          ? {}
          : {
              senderParticipantJid: m.group?.participantJid || null,
              senderParticipantName: participantName,
              senderParticipantPhone: m.group?.participantPhone ?? null,
            }),
      },
    });
    await addHistoricalAttachments(created.id, m);
    added.set(group.id, (added.get(group.id) ?? 0) + 1);
  }

  // An imported message newer than the group's last activity (one missed while the server was down) moves it up.
  for (const group of groups) {
    if (!added.has(group.id)) continue;
    const latest = await prisma.message.findFirst({ where: { conversationId: group.id, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { createdAt: true, direction: true } });
    if (latest && latest.createdAt > group.lastMessageAt) {
      await prisma.conversation.update({ where: { id: group.id }, data: { lastMessageAt: latest.createdAt, lastMessageDirection: latest.direction } });
    }
  }
  for (const [groupId, count] of added) {
    const group = await prisma.conversation.findUnique({ where: { id: groupId }, select: { whatsappConnectionId: true } });
    const team = await groupTeam(group!.whatsappConnectionId!, groupId);
    realtimeEvents.groupHistory(
      team.map((t) => t.id),
      groupId,
      count
    );
  }
  return added;
}
