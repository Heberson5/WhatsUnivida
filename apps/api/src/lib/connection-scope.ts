import { z } from "zod";
import type { ConnectionScopeDTO } from "@whatsatendende/types";
import { prisma } from "./prisma";
import { Errors } from "./http-error";

/**
 * "Todas as conexões" or an explicit list of WhatsApp connections — the
 * shared scope of respostas rápidas, Transferência/Aceite and Encerramento.
 */
export const connectionScopeSchema = z
  .object({ allConnections: z.boolean(), connectionIds: z.array(z.string().uuid()).max(200) })
  .refine((s) => s.allConnections || s.connectionIds.length > 0, { message: "Escolha pelo menos uma conexão ou marque todas as conexões" });

export type ConnectionScopeInput = z.infer<typeof connectionScopeSchema>;

export const withScopeConnections = { connections: { select: { id: true, name: true }, orderBy: { name: "asc" as const } } } as const;

export async function assertScopeConnectionsExist(scope: ConnectionScopeInput): Promise<void> {
  if (scope.allConnections) return;
  const count = await prisma.whatsAppConnection.count({ where: { id: { in: scope.connectionIds } } });
  if (count !== new Set(scope.connectionIds).size) throw Errors.badRequest("Uma ou mais conexões escolhidas são inválidas");
}

/** Prisma write data for the scope — "connect" when creating the row, "set" (replaces the previous list) when updating it. */
export function scopeData<Op extends "connect" | "set">(scope: ConnectionScopeInput, op: Op) {
  const ids = scope.allConnections ? [] : scope.connectionIds;
  return { allConnections: scope.allConnections, connections: { [op]: ids.map((id) => ({ id })) } as Record<Op, { id: string }[]> };
}

/** Rows that apply to conversations of this connection — only "all connections" ones for Instagram/Messenger (no WhatsApp connection). */
export function appliesToConnection(connectionId: string | null) {
  if (!connectionId) return { allConnections: true };
  return { OR: [{ allConnections: true }, { connections: { some: { id: connectionId } } }] };
}

export function toConnectionScopeDTO(row: { allConnections: boolean; connections: { id: string; name: string }[] }): ConnectionScopeDTO {
  return { allConnections: row.allConnections, connections: row.allConnections ? [] : row.connections };
}
