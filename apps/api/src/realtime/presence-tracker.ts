import { prisma } from "../lib/prisma";

/**
 * Presence ("Online"/"Offline" in Usuários) used to be set ONLY on an
 * explicit login/logout — so closing the browser tab, losing network, or
 * the computer sleeping/shutting down left a user stuck showing "Online"
 * forever, since nothing ever ran to say otherwise. See PROMPT: "se fechar
 * o navegador, inativo por XX horas ou desligar o computador, deverá ser
 * feito o logoff automaticamente" — the inactivity-timeout half of that is
 * useIdleLogout.ts (client-side, cooperative); this is the other half,
 * tracking whether the browser is even still there at all, from the
 * server's own view of the live socket connection — which reliably drops
 * on tab close (immediately) or network/power loss (within one missed
 * Socket.IO heartbeat, ~45s by default), independent of any client code
 * still running.
 *
 * A user can have several sockets at once (multiple tabs, or desktop +
 * mobile) — only transitioning the *last* one to close should flip
 * presence to OFFLINE, and only reconnecting from *none* should flip it
 * back. Tracked in-memory per userId rather than trusting a single
 * socket's lifecycle in isolation.
 *
 * Pulled out of socket-server.ts so this bookkeeping can be unit-tested
 * directly (fake timers, no real network/socket.io-client round trip)
 * instead of only being exercisable through a live connection.
 */

// A brand-new socket connection immediately supersedes an old one for the
// *same* reason this app refreshes its access token every ~15 minutes:
// AppLayout.tsx reconnects the socket whenever accessToken changes, which
// means a perfectly healthy, still-open tab disconnects and reconnects on
// its own every 15 minutes as routine behavior, not an outage. Marking
// someone offline on the very first disconnect would flicker their status
// on that same cadence. This grace window survives that: only a socket
// that stays fully absent (no reconnect from any tab) past this delay
// results in an actual OFFLINE write.
export const PRESENCE_OFFLINE_GRACE_MS = 20_000;

const activeSocketsByUser = new Map<string, Set<string>>();
const pendingOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingOffline(userId: string) {
  const timer = pendingOfflineTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    pendingOfflineTimers.delete(userId);
  }
}

export async function registerConnection(userId: string, socketId: string): Promise<void> {
  let sockets = activeSocketsByUser.get(userId);
  if (!sockets) {
    sockets = new Set();
    activeSocketsByUser.set(userId, sockets);
  }
  sockets.add(socketId);
  cancelPendingOffline(userId);
  await prisma.user.update({ where: { id: userId }, data: { presence: "ONLINE" } }).catch(() => undefined);
}

/**
 * graceMs defaults to PRESENCE_OFFLINE_GRACE_MS for every real call site —
 * only overridden by tests, so they can drive this with a real (tiny) delay
 * instead of fake timers. Fake timers only fake the JS clock, not real
 * network I/O (the Prisma write below is a real round trip to Postgres), so
 * advancing a fake clock past the grace period never actually waits for
 * that write to land — it just races it. A real, short wait sidesteps that
 * entirely and is what's actually being tested: does the write eventually
 * happen, correctly gated.
 */
export function registerDisconnection(userId: string, socketId: string, graceMs: number = PRESENCE_OFFLINE_GRACE_MS): void {
  const remaining = activeSocketsByUser.get(userId);
  remaining?.delete(socketId);
  if (!remaining || remaining.size > 0) return;
  activeSocketsByUser.delete(userId);

  cancelPendingOffline(userId);
  const timer = setTimeout(() => {
    pendingOfflineTimers.delete(userId);
    // Re-checked here (not just trusted from when the timer was scheduled):
    // a reconnect that raced past registerConnection's own
    // cancelPendingOffline call already re-populated this set, so bail
    // rather than clobber a now-genuinely-online user.
    if (activeSocketsByUser.get(userId)?.size) return;
    prisma.user.update({ where: { id: userId }, data: { presence: "OFFLINE" } }).catch(() => undefined);
  }, graceMs);
  pendingOfflineTimers.set(userId, timer);
}

/** Test-only: clears in-memory tracking between test cases so state doesn't leak across them. */
export function __resetPresenceTrackerForTests(): void {
  for (const timer of pendingOfflineTimers.values()) clearTimeout(timer);
  pendingOfflineTimers.clear();
  activeSocketsByUser.clear();
}
