import { prisma } from "../../lib/prisma";

function avgMs(diffs: number[]): number | null {
  if (diffs.length === 0) return null;
  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

export interface DashboardParams {
  from: Date;
  to: Date;
  agentId?: string;
  /** Empty/undefined = every WhatsApp connection — see PROMPT: filtro podendo selecionar várias ou todas. */
  connectionIds?: string[];
}

/**
 * "Conversas unicas" (spec section 23): number of distinct contacts with at
 * least one conversation created inside the window — a contact who wrote 30
 * messages in the same conversation still counts once.
 */
export async function getDashboard({ from, to, agentId, connectionIds }: DashboardParams) {
  const connectionFilter = connectionIds === undefined ? undefined : { in: connectionIds };
  const whereBase = {
    createdAt: { gte: from, lte: to },
    ...(agentId ? { assignedAgentId: agentId } : {}),
    ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
  };

  const [conversationsInPeriod, messages] = await Promise.all([
    prisma.conversation.findMany({
      where: whereBase,
      select: {
        id: true,
        contactId: true,
        status: true,
        enteredQueueAt: true,
        acceptedAt: true,
        firstResponseAt: true,
        closedAt: true,
        assignedAgentId: true,
      },
    }),
    prisma.message.groupBy({
      by: ["direction"],
      where: {
        createdAt: { gte: from, lte: to },
        conversation: {
          ...(agentId ? { assignedAgentId: agentId } : {}),
          ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
        },
      },
      _count: true,
    }),
  ]);

  const uniqueContacts = new Set(conversationsInPeriod.map((c) => c.contactId)).size;
  const statusCounts = conversationsInPeriod.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  const acceptDiffs = conversationsInPeriod
    .filter((c) => c.acceptedAt)
    .map((c) => c.acceptedAt!.getTime() - c.enteredQueueAt.getTime());
  const firstResponseDiffs = conversationsInPeriod
    .filter((c) => c.acceptedAt && c.firstResponseAt)
    .map((c) => c.firstResponseAt!.getTime() - c.acceptedAt!.getTime());
  const handlingDiffs = conversationsInPeriod
    .filter((c) => c.acceptedAt && c.closedAt)
    .map((c) => c.closedAt!.getTime() - c.acceptedAt!.getTime());
  const closingDiffs = conversationsInPeriod
    .filter((c) => c.closedAt)
    .map((c) => c.closedAt!.getTime() - c.enteredQueueAt.getTime());

  const received = messages.find((m) => m.direction === "INBOUND")?._count ?? 0;
  const sent = messages.find((m) => m.direction === "OUTBOUND")?._count ?? 0;

  const perAgent = await getPerAgentBreakdown(from, to, connectionFilter);
  const users = await getUsersSummary();

  return {
    conversations: {
      received: conversationsInPeriod.length,
      unique: uniqueContacts,
      inProgress: (statusCounts.IN_PROGRESS ?? 0) + (statusCounts.TRANSFERRED ?? 0),
      closed: statusCounts.CLOSED ?? 0,
      waiting: (statusCounts.NEW ?? 0) + (statusCounts.WAITING ?? 0),
    },
    messages: { received, sent, total: received + sent },
    timings: {
      avgAcceptMs: avgMs(acceptDiffs),
      avgFirstResponseMs: avgMs(firstResponseDiffs),
      avgHandlingMs: avgMs(handlingDiffs),
      avgClosingMs: avgMs(closingDiffs),
    },
    perAgent,
    users,
  };
}

// A snapshot of right now, not scoped to the reporting period — "how many
// users are online" is inherently a current-moment question, not a
// historical one like the rest of this dashboard.
async function getUsersSummary() {
  const [online, active, total] = await Promise.all([
    prisma.user.count({ where: { presence: "ONLINE" } }),
    prisma.user.count({ where: { status: "ACTIVE" } }),
    prisma.user.count(),
  ]);
  return { online, active, total };
}

async function getPerAgentBreakdown(from: Date, to: Date, connectionFilter?: { in: string[] }) {
  const agents = await prisma.user.findMany({ where: { role: "AGENT" }, select: { id: true, displayName: true } });

  const results = await Promise.all(
    agents.map(async (agent) => {
      const conversations = await prisma.conversation.findMany({
        where: { assignedAgentId: agent.id, createdAt: { gte: from, lte: to }, ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}) },
        select: { id: true, acceptedAt: true, closedAt: true, enteredQueueAt: true },
      });
      const sentCount = await prisma.message.count({
        where: {
          senderAgentId: agent.id,
          createdAt: { gte: from, lte: to },
          ...(connectionFilter ? { conversation: { whatsappConnectionId: connectionFilter } } : {}),
        },
      });
      const handlingDiffs = conversations
        .filter((c) => c.acceptedAt && c.closedAt)
        .map((c) => c.closedAt!.getTime() - c.acceptedAt!.getTime());

      return {
        agentId: agent.id,
        agentName: agent.displayName,
        conversations: conversations.length,
        messagesSent: sentCount,
        avgHandlingMs: avgMs(handlingDiffs),
      };
    })
  );

  return results.filter((r) => r.conversations > 0 || r.messagesSent > 0);
}
