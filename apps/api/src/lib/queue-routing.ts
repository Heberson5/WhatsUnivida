import type { Role } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Etiquetas › "Atendida por": a customer whose tags name users waits in the queue for those users only — while at
 * least one of them is ONLINE (a pause counts as away) and can take it (an attendant only takes their own
 * connection's customers). With nobody of them available the customer goes to everyone, and goes back to them as
 * soon as one comes online. Several tags add their users up. Gestor and administrador keep seeing the whole queue.
 */

export interface QueueRoutingConversation {
  id: string;
  contactId: string;
  channel: string;
  whatsappConnectionId: string | null;
}

/** Per conversation: the users it waits for, or null when everyone may take it. */
export async function queueAudiences(conversations: QueueRoutingConversation[]): Promise<Map<string, Set<string> | null>> {
  const result = new Map<string, Set<string> | null>(conversations.map((c) => [c.id, null]));
  if (conversations.length === 0) return result;
  const links = await prisma.contactTag.findMany({
    where: { contactId: { in: [...new Set(conversations.map((c) => c.contactId))] }, tag: { queueUserIds: { isEmpty: false } } },
    select: { contactId: true, tag: { select: { queueUserIds: true } } },
  });
  if (links.length === 0) return result;
  const designatedByContact = new Map<string, Set<string>>();
  for (const link of links) {
    const set = designatedByContact.get(link.contactId) ?? new Set<string>();
    for (const userId of link.tag.queueUserIds) set.add(userId);
    designatedByContact.set(link.contactId, set);
  }
  const online = await prisma.user.findMany({
    where: { id: { in: [...new Set(links.flatMap((l) => l.tag.queueUserIds))] }, status: "ACTIVE", presence: "ONLINE" },
    select: { id: true, role: true, whatsappConnectionId: true },
  });
  for (const c of conversations) {
    const designated = designatedByContact.get(c.contactId);
    if (!designated) continue;
    const available = online.filter((u) => designated.has(u.id) && canTakeFromQueue(u, c));
    result.set(c.id, available.length ? new Set(available.map((u) => u.id)) : null);
  }
  return result;
}

/**
 * A customer opening a new conversation goes straight to one of the users their tags name — the least busy of those
 * who could take them from the queue right now (queueAudiences). Null: nobody of them is available, the queue as usual.
 */
export async function designatedAgentFor(
  conversation: Omit<QueueRoutingConversation, "id">
): Promise<{ id: string; displayName: string; tagName: string } | null> {
  const audience = (await queueAudiences([{ id: "", ...conversation }])).get("");
  if (!audience) return null;
  const candidates = await prisma.user.findMany({
    where: { id: { in: [...audience] } },
    select: { id: true, displayName: true, _count: { select: { assignedConversations: { where: { status: { in: ["IN_PROGRESS", "TRANSFERRED"] } } } } } },
  });
  const agent = candidates.sort((a, b) => a._count.assignedConversations - b._count.assignedConversations)[0];
  if (!agent) return null;
  const link = await prisma.contactTag.findFirst({
    where: { contactId: conversation.contactId, tag: { queueUserIds: { has: agent.id } } },
    select: { tag: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return { id: agent.id, displayName: agent.displayName, tagName: link?.tag.name ?? "" };
}

/** An attendant only takes WhatsApp customers of their own connection; gestor/administrador and Meta channels: any. */
function canTakeFromQueue(user: { role: Role; whatsappConnectionId: string | null }, conversation: QueueRoutingConversation): boolean {
  if (user.role !== "AGENT" || conversation.channel !== "WHATSAPP") return true;
  return user.whatsappConnectionId === conversation.whatsappConnectionId;
}

/** The queue as this person sees it: an attendant doesn't see customers waiting for someone else. */
export async function filterQueueForViewer<T extends QueueRoutingConversation>(conversations: T[], viewer: { userId: string; role: Role }): Promise<T[]> {
  if (viewer.role !== "AGENT") return conversations;
  const audiences = await queueAudiences(conversations);
  return conversations.filter((c) => {
    const audience = audiences.get(c.id);
    return !audience || audience.has(viewer.userId);
  });
}

/**
 * The attendants a new queue customer is announced to, or null for the whole connection. Gestor/administrador hear of
 * it through their own combined queue view, as before.
 */
export async function queueAnnouncementTargets(conversationId: string): Promise<string[] | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, contactId: true, channel: true, whatsappConnectionId: true },
  });
  if (!conversation) return null;
  const audience = (await queueAudiences([conversation])).get(conversation.id);
  if (!audience) return null;
  const agents = await prisma.user.findMany({ where: { id: { in: [...audience] }, role: "AGENT" }, select: { id: true } });
  return agents.map((a) => a.id);
}

/** Whether someone's presence changing can move customers in the queue (they are named in a tag's "Atendida por"). */
export async function isQueueDesignated(userId: string): Promise<boolean> {
  return (await prisma.tag.count({ where: { queueUserIds: { has: userId } } })) > 0;
}
