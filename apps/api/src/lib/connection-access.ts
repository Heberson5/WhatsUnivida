import { prisma } from "./prisma";
import type { Role } from "@prisma/client";

export type ConnectionAccessKind = "manage" | "receive";

/**
 * Every connection a MANAGER can see/manage (kind="manage": Configurações,
 * and the connection filters in Gestão/Dashboard/Relatórios) or receive
 * conversations from (kind="receive": Atendimento's queue/accept) —
 * connections they created themselves (always full access, no grant row
 * needed — see WhatsAppConnection.createdByUserId) union whatever an
 * ADMIN has explicitly granted them for that kind via
 * ManagerConnectionAccess. ADMIN/AGENT never call this: ADMIN sees
 * everything unconditionally, AGENT is scoped to their own single
 * whatsappConnectionId by its callers instead.
 */
export async function getManagerConnectionIds(managerId: string, kind: ConnectionAccessKind): Promise<string[]> {
  const [owned, granted] = await Promise.all([
    prisma.whatsAppConnection.findMany({ where: { createdByUserId: managerId }, select: { id: true } }),
    prisma.managerConnectionAccess.findMany({
      where: { managerId, ...(kind === "manage" ? { canManage: true } : { canReceiveConversations: true }) },
      select: { whatsappConnectionId: true },
    }),
  ]);
  return Array.from(new Set([...owned.map((c) => c.id), ...granted.map((g) => g.whatsappConnectionId)]));
}

/**
 * Narrows a connectionIds filter (from a query param, or undefined when
 * none was requested) down to what `auth` is actually allowed to see, for
 * the given access kind. ADMIN is never restricted — the requested filter
 * (or lack of one) passes through unchanged. AGENT is handled separately
 * by its own callers (forced to their single home connection) and should
 * never reach this function. Returns undefined only when truly
 * unrestricted (ADMIN); every other outcome is a concrete array, possibly
 * empty — an empty array means "this user is allowed to see nothing",
 * which callers must treat as a real filter, not as "no filter".
 */
export async function resolveAllowedConnectionIds(
  auth: { userId: string; role: Role },
  requestedIds: string[] | undefined,
  kind: ConnectionAccessKind = "manage"
): Promise<string[] | undefined> {
  if (auth.role !== "MANAGER") return requestedIds;
  const allowed = await getManagerConnectionIds(auth.userId, kind);
  if (!requestedIds || requestedIds.length === 0) return allowed;
  const allowedSet = new Set(allowed);
  return requestedIds.filter((id) => allowedSet.has(id));
}

/** Whether a MANAGER may view/edit one specific connection (ADMIN always may; AGENT never calls this). */
export async function canManagerAccessConnection(managerId: string, connectionId: string, kind: ConnectionAccessKind): Promise<boolean> {
  const allowed = await getManagerConnectionIds(managerId, kind);
  return allowed.includes(connectionId);
}
