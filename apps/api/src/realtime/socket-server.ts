import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { verifyAccessToken } from "../modules/auth/jwt";
import { isSessionActive } from "../lib/session";
import { env } from "../config/env";
import { setIO, ROOMS } from "./realtime";
import { registerConnection, registerDisconnection } from "./presence-tracker";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { watchCustomerTyping } from "../modules/whatsapp/whatsapp.service";

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.WEB_APP_URL, credentials: true },
  });

  // Every socket must present a valid access token — same JWT used for REST
  // auth. Sockets are placed into rooms based on role, so events are only
  // ever broadcast to clients authorized to see them (mirrors the REST RBAC
  // rules; the frontend cannot widen its own visibility by connecting raw).
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = verifyAccessToken(token);
      // Same single-active-session check as requireAuth (see lib/session.ts)
      // — otherwise a device already kicked by a second login could still
      // open a brand-new socket connection with its old, not-yet-expired
      // access token and keep receiving live events.
      if (!(await isSessionActive(payload.sid))) {
        return next(new Error("unauthorized"));
      }
      socket.data.auth = { userId: payload.sub, role: payload.role, displayName: payload.displayName };
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    const auth = socket.data.auth as { userId: string; role: string };
    socket.join(ROOMS.user(auth.userId));

    // Registered before the await below (not after): registerConnection's
    // own DB write is a real round trip, and a disconnect landing during
    // that window would otherwise fire with no listener attached yet —
    // Socket.IO only emits "disconnect" once, so a socket that connects and
    // immediately drops in that gap would never be un-registered, leaving
    // it stuck counted as an active connection forever (see
    // presence-tracker.ts: a phantom entry in activeSocketsByUser blocks
    // that user's presence from ever reaching zero sockets, so it can never
    // become eligible for the OFFLINE grace timer at all).
    socket.on("disconnect", () => registerDisconnection(auth.userId, socket.id));
    await registerConnection(auth.userId, socket.id);
    // registerConnection just persisted presence=ONLINE for this user, but
    // the login/refresh HTTP response the client already rendered from
    // still carries whatever presence was last saved (typically OFFLINE,
    // from the previous session ending) — nothing told it the flip
    // happened, so the topbar kept showing the stale value. See PROMPT:
    // "não está aparecendo Online".
    // A paused user stays paused across reconnects and new logins — tell the topbar what is actually saved.
    const saved = await prisma.user.findUnique({ where: { id: auth.userId }, select: { presence: true } }).catch(() => null);
    socket.emit("presence:self", { presence: saved?.presence === "AWAY" ? "AWAY" : "ONLINE" });

    if (auth.role === "AGENT") {
      // Looked up fresh on every connect (rather than trusted from the JWT)
      // so reassigning an agent to a different WhatsApp connection takes
      // effect on their next reconnect without requiring a new login.
      const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { whatsappConnectionId: true } });
      if (user?.whatsappConnectionId) socket.join(ROOMS.queue(user.whatsappConnectionId));
      // Instagram/Messenger conversations have no "fixed agent" concept yet
      // (see PROMPT: "prepare tudo para integrar com Instagram e
      // Facebook") — every AGENT joins every Meta connection's queue room,
      // same as MANAGER/ADMIN already see everything via ROOMS.oversight().
      const metaConnections = await prisma.metaConnection.findMany({ select: { id: true } });
      for (const conn of metaConnections) socket.join(ROOMS.queue(conn.id));
    }
    if (auth.role === "MANAGER" || auth.role === "ADMIN") socket.join(ROOMS.oversight());

    // Unlike the REST layer, a socket event has no per-route middleware to
    // enforce this, so the ownership check has to happen right here: an
    // AGENT must only be able to join the room for a conversation they
    // either own or personally transferred away (read-only "Transferidas"
    // watch — see PROMPT: "possa abrir a conversa para acompanhar em tempo
    // real sem poder interferir"; joining a room only ever lets a socket
    // receive events, never send anything, so this stays read-only by
    // construction), otherwise they could listen in on any other agent's
    // conversation just by guessing/observing its ID. MANAGER/ADMIN keep
    // the same unrestricted oversight access they already have via REST.
    socket.on("conversation:join", async (conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId) return;
      if (auth.role === "AGENT") {
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { assignedAgentId: true },
        });
        if (!conversation) return;
        const isOwner = conversation.assignedAgentId === auth.userId;
        if (!isOwner) {
          const transferredByMe = await prisma.conversationTransfer.findFirst({
            where: { conversationId, fromAgentId: auth.userId },
            select: { id: true },
          });
          if (!transferredByMe) return;
        }
      }
      socket.join(ROOMS.conversation(conversationId));
      watchCustomerTyping(conversationId).catch((err) => logger.debug({ err, conversationId }, "could not subscribe to the customer's typing"));
    });
    socket.on("conversation:leave", (conversationId: unknown) => {
      if (typeof conversationId !== "string" || !conversationId) return;
      socket.leave(ROOMS.conversation(conversationId));
    });

    logger.debug({ userId: auth.userId }, "socket connected");
  });

  setIO(io);
  return io;
}
