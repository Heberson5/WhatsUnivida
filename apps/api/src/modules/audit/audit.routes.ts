import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsunivida/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { prisma } from "../../lib/prisma";

export const auditRouter = Router();
auditRouter.use(requireAuth, requirePermission(PERMISSION.AUDITORIA_ACESSAR));

const querySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  entity: z.string().optional(),
  userId: z.string().uuid().optional(),
});

auditRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { cursor, limit, entity, userId } = querySchema.parse(req.query);
    const logs = await prisma.auditLog.findMany({
      where: { entity, userId },
      include: { user: { select: { displayName: true } } },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = logs.length > limit;
    const page = hasMore ? logs.slice(0, limit) : logs;
    res.json({
      items: page.map((l) => ({
        id: l.id,
        userDisplayName: l.user?.displayName ?? "Sistema",
        action: l.action,
        entity: l.entity,
        entityId: l.entityId,
        ipAddress: l.ipAddress,
        metadata: l.metadata,
        createdAt: l.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  })
);
