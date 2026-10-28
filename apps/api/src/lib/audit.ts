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

/** Every security/business-sensitive action must go through this — see PROMPT section 38. */
export async function writeAudit(params: WriteAuditParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      ipAddress: params.ipAddress ?? null,
      metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
    },
  });
}
