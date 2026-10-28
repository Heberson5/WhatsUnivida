import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

interface WriteAuditParams {
  userId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

/** "::ffff:187.10.2.3" (an IPv4 address seen through an IPv6 socket) → "187.10.2.3". */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** Every security/business-sensitive action must go through this — see PROMPT section 38. */
export async function writeAudit(params: WriteAuditParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      ipAddress: normalizeIp(params.ipAddress),
      metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
    },
  });
}
