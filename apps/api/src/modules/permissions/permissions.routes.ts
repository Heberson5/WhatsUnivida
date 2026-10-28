import { Router } from "express";
import { z } from "zod";
import { ROLE, PERMISSION_DEFINITIONS } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import { getPermissionMatrix, getPermissionsForRole, savePermissionPatch } from "../../lib/permissions";

export const permissionsRouter = Router();
permissionsRouter.use(requireAuth);

// Every authenticated user needs their own resolved permissions to decide
// what to show (nav items, buttons) — this is deliberately open to any
// role, unlike the full matrix below.
permissionsRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json(await getPermissionsForRole(req.auth!.role));
  })
);

// The full matrix and its editor are ADMIN-only, checked directly via
// requireRole rather than through the permission table itself — otherwise a
// MANAGER granted "configuracoes.gerenciar" could grant themselves anything
// else, and a mis-edited matrix could lock every admin out of fixing it.
permissionsRouter.get(
  "/",
  requireRole("ADMIN"),
  asyncHandler(async (_req, res) => {
    res.json({ definitions: PERMISSION_DEFINITIONS, matrix: await getPermissionMatrix() });
  })
);

const patchSchema = z.object({
  entries: z
    .array(
      z.object({
        role: z.enum([ROLE.MANAGER, ROLE.AGENT]),
        permission: z.string().min(1),
        allowed: z.boolean(),
      })
    )
    .max(200),
});

permissionsRouter.put(
  "/",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const { entries } = patchSchema.parse(req.body);
    const validKeys = new Set(PERMISSION_DEFINITIONS.map((d) => d.key));
    for (const entry of entries) {
      if (!validKeys.has(entry.permission as (typeof PERMISSION_DEFINITIONS)[number]["key"])) {
        return res.status(400).json({ error: "BAD_REQUEST", message: `Permissao desconhecida: ${entry.permission}` });
      }
    }
    await savePermissionPatch(entries as { role: "MANAGER" | "AGENT"; permission: (typeof PERMISSION_DEFINITIONS)[number]["key"]; allowed: boolean }[]);
    await writeAudit({
      userId: req.auth!.userId,
      action: "PERMISSIONS_UPDATED",
      entity: "RolePermission",
      entityId: null,
      ipAddress: req.ip ?? null,
      metadata: { entries },
    });
    res.json({ definitions: PERMISSION_DEFINITIONS, matrix: await getPermissionMatrix() });
  })
);
