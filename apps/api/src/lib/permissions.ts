import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { PERMISSION_DEFINITIONS, type Permission, type PermissionMap } from "@whatsatendende/types";
import { prisma } from "./prisma";
import { Errors } from "./http-error";

const DEFINITION_BY_KEY = new Map(PERMISSION_DEFINITIONS.map((d) => [d.key, d]));

function defaultAllowed(role: Role, permission: Permission): boolean {
  if (role === "ADMIN") return true;
  return DEFINITION_BY_KEY.get(permission)?.defaultAllowed[role] ?? false;
}

/** A permission is only ever offered to the roles in its editableRoles (e.g. media in Respostas: Gestor, never Atendente). */
function isOffered(role: Role, permission: Permission): boolean {
  return role === "ADMIN" || (DEFINITION_BY_KEY.get(permission)?.editableRoles.includes(role) ?? false);
}

/**
 * ADMIN is checked first and short-circuits without touching the DB — it
 * always has every permission, hardcoded, so an admin can never lock
 * themselves (or every other admin) out of the one screen that controls
 * this table. Any other role falls back to its hardcoded default only when
 * nothing has been explicitly saved for that (role, permission) pair yet.
 */
export async function isPermissionAllowed(role: Role, permission: Permission): Promise<boolean> {
  if (role === "ADMIN") return true;
  if (!isOffered(role, permission)) return false;
  const row = await prisma.rolePermission.findUnique({ where: { role_permission: { role, permission } } });
  return row ? row.allowed : defaultAllowed(role, permission);
}

/** Same shape as requireRole, but backed by the configurable permission table instead of a fixed role list. */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(Errors.unauthorized());
    isPermissionAllowed(req.auth.role, permission)
      .then((allowed) => next(allowed ? undefined : Errors.forbidden()))
      .catch(next);
  };
}

/** Full ROLE x PERMISSION matrix, defaults merged with whatever's been explicitly saved — used by the admin-facing permissions screen. */
export async function getPermissionMatrix(): Promise<Record<Role, PermissionMap>> {
  const rows = await prisma.rolePermission.findMany();
  const overrides = new Map(rows.map((r) => [`${r.role}:${r.permission}`, r.allowed]));
  const roles: Role[] = ["ADMIN", "MANAGER", "AGENT"];
  const matrix = {} as Record<Role, PermissionMap>;
  for (const role of roles) {
    const map = {} as PermissionMap;
    for (const def of PERMISSION_DEFINITIONS) {
      map[def.key] = role === "ADMIN" ? true : isOffered(role, def.key) && (overrides.get(`${role}:${def.key}`) ?? defaultAllowed(role, def.key));
    }
    matrix[role] = map;
  }
  return matrix;
}

/** Just the requesting user's own resolved permissions — what the frontend uses to decide what to show. */
export async function getPermissionsForRole(role: Role): Promise<PermissionMap> {
  const matrix = await getPermissionMatrix();
  return matrix[role];
}

export interface PermissionPatchEntry {
  role: Role;
  permission: Permission;
  allowed: boolean;
}

/** Persists a batch of edits. ADMIN entries are silently ignored — its permissions are never stored, only ever hardcoded true. */
export async function savePermissionPatch(entries: PermissionPatchEntry[]): Promise<void> {
  const editable = entries.filter((e) => e.role !== "ADMIN" && DEFINITION_BY_KEY.has(e.permission) && isOffered(e.role, e.permission));
  await prisma.$transaction(
    editable.map((e) =>
      prisma.rolePermission.upsert({
        where: { role_permission: { role: e.role, permission: e.permission } },
        create: { role: e.role, permission: e.permission, allowed: e.allowed },
        update: { allowed: e.allowed },
      })
    )
  );
}
