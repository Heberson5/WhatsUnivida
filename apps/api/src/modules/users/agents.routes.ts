import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { prisma } from "../../lib/prisma";

/** Lightweight agent listings used by the transfer modal and management screens (not full user CRUD). */
export const agentsRouter = Router();
agentsRouter.use(requireAuth);

agentsRouter.get(
  "/transfer-targets",
  requireRole("AGENT", "MANAGER", "ADMIN"),
  asyncHandler(async (req, res) => {
    // Any active user who can attend conversations is a valid target,
    // regardless of their WhatsApp connection — see PROMPT: "poderá
    // transferir a conversa para qualquer atendente" and "o gestor e
    // administrador também ... poderão ... receber transferências". The
    // connection name is included so the modal can flag when a transfer
    // crosses connections.
    const agents = await prisma.user.findMany({
      where: { role: { in: ["AGENT", "MANAGER", "ADMIN"] }, status: "ACTIVE", id: { not: req.auth!.userId } },
      select: { id: true, displayName: true, presence: true, photoUrl: true, whatsappConnection: { select: { name: true } } },
      orderBy: { displayName: "asc" },
    });
    res.json(
      agents.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        presence: a.presence,
        photoUrl: a.photoUrl,
        whatsappConnectionName: a.whatsappConnection?.name ?? null,
      }))
    );
  })
);

agentsRouter.get(
  "/",
  requireRole("MANAGER", "ADMIN"),
  asyncHandler(async (_req, res) => {
    const agents = await prisma.user.findMany({
      where: { role: "AGENT" },
      select: { id: true, displayName: true, presence: true, status: true, whatsappConnection: { select: { name: true } } },
      orderBy: { displayName: "asc" },
    });
    res.json(agents.map((a) => ({ id: a.id, displayName: a.displayName, presence: a.presence, status: a.status, whatsappConnectionName: a.whatsappConnection?.name ?? null })));
  })
);
