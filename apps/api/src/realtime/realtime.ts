import type { Server as SocketIOServer } from "socket.io";

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

export const realtimeEvents = {
  conversationAccepted: (conversationId: string, connectionId: string, agentId: string) => {
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:updated");
    // MANAGER/ADMIN have no fixed connection room — their combined queue view
    // (oversight room) needs the same refresh so an accepted card disappears there too.
    getIO()?.to(ROOMS.oversight()).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
    getIO()?.to(ROOMS.user(agentId)).emit("conversation:assigned", { conversationId });
  },
  conversationTransferred: (conversationId: string, fromAgentId: string, toAgentId: string) => {
    getIO()?.to(ROOMS.user(fromAgentId)).emit("conversation:removed", { conversationId });
    getIO()?.to(ROOMS.user(toAgentId)).emit("conversation:transferred-in", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  conversationClosed: (conversationId: string, agentId: string) => {
    getIO()?.to(ROOMS.user(agentId)).emit("conversation:removed", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  newMessage: (conversationId: string, agentId: string | null) => {
    getIO()?.to(ROOMS.conversation(conversationId)).emit("message:new", { conversationId });
    if (agentId) getIO()?.to(ROOMS.user(agentId)).emit("message:new", { conversationId });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** A brand-new conversation entered a connection's queue — notifies the agents watching that connection, plus MANAGER/ADMIN's combined queue view. */
  newQueueConversation: (connectionId: string, conversationId: string, contactName: string) => {
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:updated");
    getIO()?.to(ROOMS.queue(connectionId)).emit("queue:new-conversation", { conversationId, contactName });
    getIO()?.to(ROOMS.oversight()).emit("queue:updated");
    getIO()?.to(ROOMS.oversight()).emit("queue:new-conversation", { conversationId, contactName });
    getIO()?.to(ROOMS.oversight()).emit("oversight:updated");
  },
  /** A new inbound message landed in a conversation the agent already owns — used for the toast, separate from the generic refresh-only newMessage. */
  inboundMessageNotification: (conversationId: string, agentId: string, contactName: string, preview: string) => {
    getIO()?.to(ROOMS.user(agentId)).emit("message:inbound-notification", { conversationId, contactName, preview });
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
  userForceLoggedOut: (userId: string, reason: "ADMIN" | "NEW_LOGIN" | "SCHEDULE" = "ADMIN") => {
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
};
