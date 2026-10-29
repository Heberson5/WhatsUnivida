import type { Server as SocketIOServer } from "socket.io";
import type { NotificationDTO } from "@whatsatendende/types";
import { queueAnnouncementTargets } from "../lib/queue-routing";

let ioInstance: SocketIOServer | null = null;

export function setIO(io: SocketIOServer) {
  ioInstance = io;
}

function getIO(): SocketIOServer | null {
  return ioInstance;
}

export const ROOMS = {
  // Agents only ever see the queue for their own WhatsApp connection — see
  // PROMPT: "cada usuário atenderá somente a uma determinada conexão".
  queue: (connectionId: string) => `queue:${connectionId}`,
  user: (userId: string) => `user:${userId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  oversight: () => "oversight", // managers/admins watching everything, across all connections
};

/**
 * "Nova conversa na fila" for the attendants: the whole connection, or only those a tag's "Atendida por" names
 * (lib/queue-routing.ts) — the others don't see that customer in their queue, so they aren't called for it.
 */
function announceToQueue(connectionId: string, conversationId: string, contactName: string) {
  const io = getIO();
  if (!io) return;
  const toConnection = () => io.to(ROOMS.queue(connectionId)).emit("queue:new-conversation", { conversationId, contactName });
  queueAnnouncementTargets(conversationId)
    .then((userIds) => {
      if (!userIds) return toConnection();
      for (const userId of userIds) io.to(ROOMS.user(userId)).emit("queue:new-conversation", { conversationId, contactName });
    })
    .catch(toConnection);
}

export const realtimeEvents = {
  /** Who may see a waiting customer changed (a tag's "Atendida por", a contact's tags, or a designated user's presence) — every queue refetches. */
  queueAudienceChanged: () => {
    getIO()?.emit("queue:updated");
  },
  /** A contact's tags (or a tag itself) changed — the attendance cards show them, and the queue may move. */
  contactTagsChanged: () => {
    getIO()?.emit("queue:updated");
    getIO()?.emit("contact:tags");
  },
  /**
   * Pop Up › Avisos changed (a notice published, edited, paused, deleted, or the day turned): open screens re-ask for
   * their pending pop-ups and the Comunicados board — live, without waiting for the next login. With `userIds`, only those
   * people (a "Lembrar pendentes").
   */
  announcementsChanged: (userIds?: string[]) => {
    if (!userIds) return void getIO()?.emit("announcements:changed");
    for (const userId of userIds) getIO()?.to(ROOMS.user(userId)).emit("announcements:changed");
  },
  /** Someone confirmed a notice — Pop Up › Avisos and the Dashboard card refresh their numbers. */
  announcementReceiptsChanged: () => {
    getIO()?.to(ROOMS.oversight()).emit("announcements:receipts");
  },
  /** Identidade visual or Exportações changed — every open screen re-reads its colors/logo without a reload. */
  brandingChanged: () => {
    getIO()?.emit("branding:updated");
  },
  /** A new message in a WhatsApp group, sent to each person who sees it; `notify` = pop a notice for them. */
  groupMessage: (
    userId: string,
    payload: { conversationId: string; connectionId: string; groupName: string; senderName: string; preview: string; notify: boolean }
  ) => {
    getIO()?.to(ROOMS.user(userId)).emit("group:message", payload);
  },
  /** Someone opened a group: everybody's "Visto por" / Leitura da equipe changes. */
  groupRead: (userIds: string[], conversationId: string, readerId: string) => {
    for (const userId of userIds) getIO()?.to(ROOMS.user(userId)).emit("group:read", { conversationId, userId: readerId });
    getIO()?.to(ROOMS.oversight()).emit("groups:updated");
  },
  /** A participant reacted to a group message (or took the reaction back): the open group redraws it. */
  groupReaction: (userIds: string[], conversationId: string) => {
    for (const userId of userIds) getIO()?.to(ROOMS.user(userId)).emit("group:reaction", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("group:reaction", { conversationId });
  },
  /** Older messages of a group arrived from WhatsApp (the "Carregar mensagens anteriores" button). */
  groupHistory: (userIds: string[], conversationId: string, count: number) => {
    for (const userId of userIds) getIO()?.to(ROOMS.user(userId)).emit("group:history", { conversationId, count });
    getIO()?.to(ROOMS.oversight()).emit("group:history", { conversationId, count });
  },
  /** Groups list changed (a message, groups turned on/off) — administrators see every group. */
  groupsChanged: () => {
    getIO()?.to(ROOMS.oversight()).emit("groups:updated");
  },
  conversationAccepted: (conversationId: string, connectionId: string, agentId: string) => {
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:updated");
    // MANAGER/ADMIN have no fixed connection room — their combined queue view
    // (oversight room) needs the same refresh so an accepted card disappears there too.
    getIO()?.to(ROOMS.oversight()).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
    getIO()?.to(ROOMS.user(agentId)).emit("conversation:assigned", { conversationId });
  },
  /**
   * Pausing/resuming from the profile menu — broadcast to every open tab/
   * device this user has (same room presence-tracker.ts's own ONLINE/
   * OFFLINE writes don't need to touch, since those happen on the socket
   * connection itself). Same event name/shape socket-server.ts already
   * emits on connect, so useSocketEvents' existing listener just picks it
   * up. See PROMPT: "poderão pausar no mesmo local onde está a foto do
   * perfil".
   */
  presenceChanged: (userId: string, presence: "ONLINE" | "AWAY" | "OFFLINE") => {
    getIO()?.to(ROOMS.user(userId)).emit("presence:self", { presence });
  },
  conversationTransferred: (conversationId: string, fromAgentId: string, toAgentId: string) => {
    getIO()?.to(ROOMS.user(fromAgentId)).emit("conversation:removed", { conversationId });
    getIO()?.to(ROOMS.user(toAgentId)).emit("conversation:transferred-in", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** Gestão › Intervir started or ended — the agent's chat locks/unlocks, the manager's opens/closes. */
  interventionChanged: (conversationId: string, userIds: (string | null)[]) => {
    for (const userId of userIds) if (userId) getIO()?.to(ROOMS.user(userId)).emit("conversation:intervention", { conversationId });
    getIO()?.to(ROOMS.conversation(conversationId)).emit("conversation:intervention", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** A note was added while another person also has this conversation open (an intervention) — their note list refreshes. */
  notesChanged: (conversationId: string, userIds: string[]) => {
    for (const userId of userIds) getIO()?.to(ROOMS.user(userId)).emit("conversation:notes", { conversationId });
  },
  conversationClosed: (conversationId: string, agentId: string) => {
    getIO()?.to(ROOMS.user(agentId)).emit("conversation:removed", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** The attendant's pins, reminders or scheduled messages changed (from another tab, or a message went out). */
  /** Chat interno: something changed for these people ("internal-chat:message" | "internal-chat:read" | "internal-chat:typing" | "internal-chat:rooms"). */
  internalChat: (userIds: string[], event: string, payload: unknown) => {
    for (const userId of userIds) getIO()?.to(ROOMS.user(userId)).emit(event, payload);
  },
  /** A data source became usable or stopped being usable — tags, quick replies and Dados do cliente refetch. */
  dataSourceStatusChanged: () => {
    getIO()?.emit("data-source:status");
  },
  /** Metas changed — every "Meu dia" refetches its progress. */
  goalsChanged: () => {
    getIO()?.emit("goals:changed");
  },
  agentExtrasChanged: (userId: string) => {
    getIO()?.to(ROOMS.user(userId)).emit("agent:extras");
  },
  /** A "lembrar de retornar" went off — a pop-up with "Abrir conversa" / "Adiar". */
  reminderDue: (userId: string, payload: unknown) => {
    getIO()?.to(ROOMS.user(userId)).emit("reminder:due", payload);
    getIO()?.to(ROOMS.user(userId)).emit("agent:extras");
  },
  /** The customer is typing (or stopped) — the open conversation and the agent's list show "digitando…". */
  customerTyping: (conversationId: string, agentId: string | null, typing: boolean, kind: "typing" | "recording" = "typing") => {
    getIO()?.to(ROOMS.conversation(conversationId)).emit("conversation:typing", { conversationId, typing, kind });
    if (agentId) getIO()?.to(ROOMS.user(agentId)).emit("conversation:typing", { conversationId, typing, kind });
  },
  /** A participant of a WhatsApp group is typing or recording (or stopped) — "Marta está digitando…". */
  groupTyping: (userIds: string[], conversationId: string, who: { typing: boolean; kind: "typing" | "recording"; participant: string; name: string }) => {
    for (const userId of userIds) getIO()?.to(ROOMS.user(userId)).emit("conversation:typing", { conversationId, ...who });
  },
  newMessage: (conversationId: string, agentId: string | null) => {
    getIO()?.to(ROOMS.conversation(conversationId)).emit("message:new", { conversationId });
    if (agentId) getIO()?.to(ROOMS.user(agentId)).emit("message:new", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** A brand-new conversation entered a connection's queue — notifies the agents watching that connection, plus MANAGER/ADMIN's combined queue view. */
  /** Abandonados changed (a conversation came in or was accepted) — its people span connections, so everyone refreshes it. */
  abandonedChanged: () => {
    getIO()?.emit("abandoned:updated");
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  newQueueConversation: (connectionId: string, conversationId: string, contactName: string) => {
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:updated");
    announceToQueue(connectionId, conversationId, contactName);
    getIO()?.to(ROOMS.oversight()).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("queue:new-conversation", { conversationId, contactName });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** Gestão (MANAGER/ADMIN) sent a conversation back to the queue — from an agent's list, or out of HANDLED_EXTERNALLY/unclaimed. Same broadcast as newQueueConversation, plus removing it from whoever had it, if anyone did. */
  conversationReturnedToQueue: (conversationId: string, connectionId: string, contactName: string, previousAgentId: string | null) => {
    if (previousAgentId) getIO()?.to(ROOMS.user(previousAgentId)).emit("conversation:removed", { conversationId });
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:updated");
    announceToQueue(connectionId, conversationId, contactName);
    getIO()?.to(ROOMS.oversight()).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("queue:new-conversation", { conversationId, contactName });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** A new inbound message landed in a conversation the agent already owns — used for the toast, separate from the generic refresh-only newMessage. */
  inboundMessageNotification: (conversationId: string, agentId: string, contactName: string, preview: string) => {
    getIO()?.to(ROOMS.user(agentId)).emit("message:inbound-notification", { conversationId, contactName, preview });
  },
  /** A Notification row was persisted for this user — lets the bell prepend it live instead of waiting for the next open/poll. See PROMPT: "marcando as notificações perdidas". */
  notificationCreated: (userId: string, notification: NotificationDTO) => {
    getIO()?.to(ROOMS.user(userId)).emit("notification:new", notification);
  },
  // Also broadcast to the owning agent's own room — unlike the queue/user/
  // oversight rooms (rejoined automatically server-side on every socket
  // "connection" event), the conversation room is only ever joined via an
  // explicit client emit and can be missed after a reconnect; this keeps
  // delivery/read ticks (and reaction updates) live even then, same as newMessage.
  messageStatusChanged: (conversationId: string, agentId?: string | null) => {
    getIO()?.to(ROOMS.conversation(conversationId)).emit("message:status", { conversationId });
    if (agentId) getIO()?.to(ROOMS.user(agentId)).emit("message:status", { conversationId });
  },
  /** An admin deleted a message from a conversation (local to this app only — see messages.routes.ts). Carries the messageId so any open chat view can prune it from its already-loaded list, not just refetch page 1 (which would silently leave a stale copy behind). */
  messageDeleted: (conversationId: string, messageId: string, agentId?: string | null) => {
    getIO()?.to(ROOMS.conversation(conversationId)).emit("message:deleted", { conversationId, messageId });
    if (agentId) getIO()?.to(ROOMS.user(agentId)).emit("message:deleted", { conversationId, messageId });
  },
  /** The linked phone marked a chat as read (WhatsApp's own multi-device sync) — refreshes the unread badge for whoever owns it. */
  conversationReadFromDevice: (conversationId: string, agentId: string | null) => {
    if (agentId) getIO()?.to(ROOMS.user(agentId)).emit("conversation:read", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /**
   * The agent read a conversation directly in this app (opening it clears
   * its badge — see conversations.routes.ts's POST /:id/read). Unlike
   * conversationReadFromDevice above, this used to be a silent DB write
   * with no broadcast at all: a manager watching Gestão, or the same agent
   * with a second tab/device open on the same account, never saw the
   * unread badge clear until their next unrelated refetch (or the 20s
   * safety poll) — see PROMPT: "não está sincronizando em tempo real as
   * conversas não lidas e lidas, isso independente de qual dispositivo foi
   * aberto". Same event/rooms as the from-device path, since both mean the
   * same thing to every other open screen: this conversation's unread
   * state changed, refresh it.
   */
  conversationRead: (conversationId: string, agentId: string) => {
    getIO()?.to(ROOMS.user(agentId)).emit("conversation:read", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** A still-queued conversation was read directly on the linked phone and left the queue (HANDLED_EXTERNALLY) — see markConversationReadFromDevice. Same queue-refresh broadcast as conversationAccepted, just with no owning agent to notify. */
  conversationHandledExternally: (connectionId: string) => {
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /**
   * Kills every live session this user currently has open. Two callers:
   * an ADMIN force-disconnecting them from Usuários ("ADMIN"), or the user
   * themselves logging in again somewhere else while an old session is
   * still around ("NEW_LOGIN" — see PROMPT: only one active login at a
   * time), or the access-hours/holiday window they're allowed to be logged
   * in under just closed ("SCHEDULE" — emitted by
   * useAccessWindow-triggered logout on the frontend itself once its own
   * countdown hits zero, not by the backend directly; included here so
   * every other open tab/device for the same account gets the same
   * explanation instead of the generic ADMIN one). Revoking refresh tokens
   * alone leaves an already-issued access token working for up to its own
   * remaining TTL — genuinely instant means also killing the live
   * socket(s) right now, which is what disconnectSockets does; the
   * frontend's own force-logout listener (on the emitted event) clears its
   * session and redirects before that disconnect even lands, and uses
   * `reason` to show the right message.
   */
  userForceLoggedOut: (userId: string, reason: "ADMIN" | "NEW_LOGIN" | "SCHEDULE" | "INACTIVITY" = "ADMIN") => {
    getIO()?.to(ROOMS.user(userId)).emit("user:force-logout", { reason });
    getIO()?.in(ROOMS.user(userId)).disconnectSockets(true);
  },
  whatsappStatusChanged: (connectionId: string, status: unknown) => {
    getIO()?.emit("whatsapp:status", { connectionId, status });
  },
  /**
   * A QR/pairing-code scan was undone right after reaching CONNECTED,
   * before ever being persisted — two distinct reasons:
   *  - MISMATCH: linked a different phone number than this connection was
   *    originally paired with. See PROMPT: reconnect only with the same
   *    number as before.
   *  - ALREADY_LINKED: the scanned number is already the linked number of a
   *    *different* connection row — otherConnectionName names it.
   */
  whatsappPairingRejected: (
    connectionId: string,
    scannedNumber: string,
    reason: "MISMATCH" | "ALREADY_LINKED",
    detail: { expectedNumber?: string; otherConnectionName?: string }
  ) => {
    getIO()?.emit("whatsapp:pairing-rejected", { connectionId, scannedNumber, reason, ...detail });
  },
  /** An admin merged a duplicate conversation into another — refreshes the Fila/Gestão views that could have shown either one. The surviving conversation's owner is notified separately via newMessage, below, since it just gained the duplicate's messages. */
  conversationsMerged: (connectionId: string) => {
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** A pending transfer expired without the receiving agent logging in — it bounced back to whoever transferred it. */
  transferReverted: (conversationId: string, revertedToAgentId: string, expiredAgentId: string) => {
    getIO()?.to(ROOMS.user(expiredAgentId)).emit("conversation:removed", { conversationId });
    getIO()?.to(ROOMS.user(revertedToAgentId)).emit("conversation:transferred-in", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /**
   * Periodic nudge (see lib/queue-reminder.ts) for one ONLINE agent whose own
   * connection still has a conversation waiting — unlike newQueueConversation
   * above, this is targeted at this one user's room, not the whole
   * connection's queue room, since eligibility is presence-filtered per
   * agent, not shared by everyone watching that connection. See PROMPT:
   * "notificações a cada um minuto quando tem conversas na fila".
   */
  /** A customer of this attendant is waiting for a reply (see sendNoReplyRemindersIfDue). */
  noReplyReminder: (userId: string, payload: { conversationId: string; contactName: string; minutes: number }) => {
    getIO()?.to(ROOMS.user(userId)).emit("conversation:no-reply-reminder", payload);
  },
  queueReminder: (userId: string, connectionId: string, connectionName: string, waitingCount: number) => {
    getIO()?.to(ROOMS.user(userId)).emit("queue:reminder", { connectionId, connectionName, waitingCount });
  },
};
