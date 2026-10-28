import type { Prisma } from "@prisma/client";
import { AUTO_MESSAGE_KIND_LABEL, type AutoMessageBlocksReportDTO, type AutoMessageKind } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";

export interface AutoMessageBlocksParams {
  from: Date;
  to: Date;
  agentId?: string;
  connectionIds?: string[];
}

/** Relatórios › Mensagens automáticas bloqueadas: each automatic message a tag stopped in the period, newest first. */
export async function getAutoMessageBlocks({ from, to, agentId, connectionIds }: AutoMessageBlocksParams): Promise<AutoMessageBlocksReportDTO> {
  const where: Prisma.AutoMessageBlockLogWhereInput = {
    createdAt: { gte: from, lte: to },
    conversation: {
      ...(agentId ? { assignedAgentId: agentId } : {}),
      // Same shape as Gestão: the WhatsApp connection filter, Instagram/Messenger whatever it is.
      OR: [{ channel: "WHATSAPP", whatsappConnectionId: connectionIds === undefined ? undefined : { in: connectionIds } }, { channel: { not: "WHATSAPP" } }],
    },
  };
  const rows = await prisma.autoMessageBlockLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      kind: true,
      tagName: true,
      conversation: {
        select: {
          id: true,
          contact: { select: { name: true, phone: true } },
          whatsappConnection: { select: { name: true } },
          metaConnection: { select: { name: true } },
          assignedAgent: { select: { displayName: true } },
        },
      },
    },
  });
  const count = <K extends string>(keys: K[]) => [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<K, number>())].sort((a, b) => b[1] - a[1]);
  return {
    total: rows.length,
    byKind: count(rows.map((r) => r.kind as AutoMessageKind)).map(([kind, n]) => ({ kind, count: n })),
    byTag: count(rows.map((r) => r.tagName)).map(([tagName, n]) => ({ tagName, count: n })),
    items: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      kind: r.kind as AutoMessageKind,
      tagName: r.tagName,
      conversationId: r.conversation.id,
      contactName: r.conversation.contact.name ?? r.conversation.contact.phone ?? "Cliente",
      connectionName: r.conversation.whatsappConnection?.name ?? r.conversation.metaConnection?.name ?? null,
      agentName: r.conversation.assignedAgent?.displayName ?? null,
    })),
  };
}

/** One row per blocked message for the exports (CSV/PDF/Excel). */
export function autoMessageBlocksToRows(report: AutoMessageBlocksReportDTO, tzOffsetMinutes: number): Record<string, unknown>[] {
  const local = (iso: string) => {
    const d = new Date(new Date(iso).getTime() - tzOffsetMinutes * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  return report.items.map((i) => ({
    "Data e hora": local(i.at),
    Mensagem: AUTO_MESSAGE_KIND_LABEL[i.kind] ?? i.kind,
    Etiqueta: i.tagName,
    Cliente: i.contactName,
    Conexão: i.connectionName ?? "",
    Atendente: i.agentName ?? "",
  }));
}
