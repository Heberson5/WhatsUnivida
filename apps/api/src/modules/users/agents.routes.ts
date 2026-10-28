import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import type { Role } from "@prisma/client";
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
    //
    // excludeSelf=false reuses this same "who can attend conversations"
    // pool for the closing-message user picker (Respostas > Encerramento),
    // where a MANAGER/ADMIN configuring the screen may well want to assign
    // a message to themselves too — unlike a transfer target, which can
    // never legitimately be the transferring agent themselves.
    const excludeSelf = req.query.excludeSelf !== "false";
    const agents = await prisma.user.findMany({
      where: {
        role: { in: ["AGENT", "MANAGER", "ADMIN"] },
        status: "ACTIVE",
        ...(excludeSelf ? { id: { not: req.auth!.userId } } : {}),
      },
      select: {
        id: true,
        displayName: true,
        presence: true,
        photoUrl: true,
        whatsappConnection: { select: { name: true } },
        pauseReason: { select: { name: true } },
      },
      orderBy: { displayName: "asc" },
    });
    res.json(
      agents.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        presence: a.presence,
        photoUrl: a.photoUrl,
        whatsappConnectionName: a.whatsappConnection?.name ?? null,
        pauseReasonName: a.pauseReason?.name ?? null,
      }))
    );
  })
);

// Gestão's "Atendente" filter: everyone whose conversations Gestão can list, since a manager or an administrator
// may attend a customer too. A manager never sees the administrators there. See PROMPT: "o administrador poderá
// ver na lista de atendentes o próprio nome e de algum gestor ... mas o gestor não poderá ver o administrador".
agentsRouter.get(
  "/attendants",
  requireRole("MANAGER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const roles: Role[] = req.auth!.role === "ADMIN" ? ["AGENT", "MANAGER", "ADMIN"] : ["AGENT", "MANAGER"];
    const users = await prisma.user.findMany({
      where: { role: { in: roles } },
      select: { id: true, displayName: true, role: true, status: true },
      orderBy: { displayName: "asc" },
    });
    res.json(users.map((u) => ({ ...u, isSelf: u.id === req.auth!.userId })));
  })
);

agentsRouter.get(
  "/",
  requireRole("MANAGER", "ADMIN"),
  asyncHandler(async (_req, res) => {
    const agents = await prisma.user.findMany({
      where: { role: "AGENT" },
      select: {
        id: true,
        displayName: true,
        presence: true,
        status: true,
        whatsappConnection: { select: { name: true } },
        pauseReason: { select: { name: true } },
      },
      orderBy: { displayName: "asc" },
    });
    res.json(
      agents.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        presence: a.presence,
        status: a.status,
        whatsappConnectionName: a.whatsappConnection?.name ?? null,
        pauseReasonName: a.pauseReason?.name ?? null,
      }))
    );
  })
);
