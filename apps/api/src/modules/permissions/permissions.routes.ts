import { Router } from "express";
import { z } from "zod";
import { ROLE, PERMISSION, PERMISSION_DEFINITIONS } from "@whatsatendende/types";
import type { Role } from "@prisma/client";
import { Errors } from "../../lib/http-error";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import { getAgentPermissionsForManager, getPermissionMatrix, getPermissionsForRole, isPermissionAllowed, savePermissionPatch } from "../../lib/permissions";

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
//
// A MANAGER with "Editar as permissões do Atendente" reaches a narrower version of both routes: only the Atendente's
// column, only the permissions the Gestor's own profile has (getAgentPermissionsForManager) — never their own column
// nor anything exclusive to the Administrador.
async function assertManagerMayEditAgent(role: Role) {
  if (role !== "MANAGER" || !(await isPermissionAllowed(role, PERMISSION.CONFIGURACOES_PERMISSOES_ATENDENTE_EDITAR))) throw Errors.forbidden();
}

permissionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (req.auth!.role === "ADMIN") return res.json({ definitions: PERMISSION_DEFINITIONS, matrix: await getPermissionMatrix() });
    await assertManagerMayEditAgent(req.auth!.role);
    res.json(await getAgentPermissionsForManager());
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
  asyncHandler(async (req, res) => {
    const { entries } = patchSchema.parse(req.body);
    const isAdmin = req.auth!.role === "ADMIN";
    if (!isAdmin) {
      await assertManagerMayEditAgent(req.auth!.role);
      // Everything asked for has to be inside what the Gestor sees — one entry outside it refuses the whole save.
      const editable = new Set((await getAgentPermissionsForManager()).definitions.map((d) => d.key as string));
      if (entries.some((e) => e.role !== ROLE.AGENT || !editable.has(e.permission))) throw Errors.forbidden("Você só pode alterar permissões do Atendente que o seu próprio perfil tem");
    }
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
    res.json(isAdmin ? { definitions: PERMISSION_DEFINITIONS, matrix: await getPermissionMatrix() } : await getAgentPermissionsForManager());
  })
);
