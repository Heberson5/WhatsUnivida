import { Router, type Request } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import { realtimeEvents } from "../../realtime/realtime";
import { toUserDTO } from "./users.mapper";
import * as usersService from "./users.service";
import { profilePhotoUpload, saveProfilePhoto } from "../../lib/profile-photo";
import { updateOwnPhoto as setUserPhoto } from "../profile/profile.service";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// USUARIOS_ADICIONAR/EDITAR can be granted to a MANAGER, unlike every other
// permission gate in this file, which is a real capability change: a
// delegated (non-ADMIN) user manager must never be able to create a new
// ADMIN, promote anyone to ADMIN, or touch an existing ADMIN account —
// otherwise granting this one permission would be an unbounded privilege
// escalation. A true ADMIN caller is exempt from all of this.
async function assertNoAdminEscalation(req: Request, targetUserId?: string, requestedRole?: string) {
  if (req.auth!.role === "ADMIN") return;
  if (requestedRole === "ADMIN") throw Errors.forbidden("Somente um administrador pode conceder o perfil Administrador");
  if (targetUserId) {
    const target = await usersService.getUser(targetUserId);
    if (target.role === "ADMIN") throw Errors.forbidden("Somente um administrador pode gerenciar outra conta de Administrador");
  }
}

usersRouter.get(
  "/",
  requirePermission(PERMISSION.USUARIOS_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    const users = await usersService.listUsers();
    res.json(users.map(toUserDTO));
  })
);

const emailUseSchema = z.object({ email: z.string().trim().email(), exceptUserId: z.string().uuid().optional() });

// For the e-mail field of the user form: who already has it (an active user blocks saving).
usersRouter.get(
  "/email-use",
  requirePermission(PERMISSION.USUARIOS_VISUALIZAR),
  asyncHandler(async (req, res) => {
    const { email, exceptUserId } = emailUseSchema.parse(req.query);
    res.json(await usersService.describeEmailUse(email, exceptUserId));
  })
);

const accessScheduleWindowSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
const accessScheduleSchema = z
  .object({
    MON: accessScheduleWindowSchema.optional(),
    TUE: accessScheduleWindowSchema.optional(),
    WED: accessScheduleWindowSchema.optional(),
    THU: accessScheduleWindowSchema.optional(),
    FRI: accessScheduleWindowSchema.optional(),
    SAT: accessScheduleWindowSchema.optional(),
    SUN: accessScheduleWindowSchema.optional(),
  })
  .strict()
  .nullable();

const createSchema = z.object({
  fullName: z.string().min(2),
  displayName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  confirmPassword: z.string().min(8),
  role: z.enum(["ADMIN", "MANAGER", "AGENT"]),
  // Required for role=AGENT (validated in the service, since it depends on
  // the role also present in this same payload); ignored for ADMIN/MANAGER.
  whatsappConnectionId: z.string().uuid().nullable().optional(),
  workState: z.string().length(2).nullable().optional(),
  workCity: z.string().min(1).nullable().optional(),
  accessSchedule: accessScheduleSchema.optional(),
});

usersRouter.post(
  "/",
  requirePermission(PERMISSION.USUARIOS_ADICIONAR),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    if (input.password !== input.confirmPassword) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "As senhas nao coincidem" });
    }
    await assertNoAdminEscalation(req, undefined, input.role);
    const user = await usersService.createUser(input);
    await writeAudit({ userId: req.auth!.userId, action: "USER_CREATED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null, metadata: { email: user.email, role: user.role } });
    res.status(201).json(toUserDTO(user));
  })
);

const updateSchema = z.object({
  fullName: z.string().min(2).optional(),
  displayName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(["ADMIN", "MANAGER", "AGENT"]).optional(),
  whatsappConnectionId: z.string().uuid().nullable().optional(),
  password: z.string().min(8).optional(),
  confirmPassword: z.string().min(8).optional(),
  workState: z.string().length(2).nullable().optional(),
  workCity: z.string().min(1).nullable().optional(),
  accessSchedule: accessScheduleSchema.optional(),
});

usersRouter.patch(
  "/:id",
  requirePermission(PERMISSION.USUARIOS_EDITAR),
  asyncHandler(async (req, res) => {
    const { confirmPassword, ...input } = updateSchema.parse(req.body);
    if (input.password && input.password !== confirmPassword) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "As senhas nao coincidem" });
    }
    await assertNoAdminEscalation(req, req.params.id, input.role);
    const user = await usersService.updateUser(req.params.id, input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "USER_UPDATED",
      entity: "User",
      entityId: user.id,
      ipAddress: req.ip ?? null,
      metadata: { ...input, password: input.password ? "[alterada]" : undefined },
    });
    res.json(toUserDTO(user));
  })
);

// A manager/admin setting or clearing someone else's photo from Usuários —
// the user can still change their own in Meu Perfil. Same upload rules.
usersRouter.post(
  "/:id/photo",
  requirePermission(PERMISSION.USUARIOS_EDITAR),
  profilePhotoUpload.single("file"),
  asyncHandler(async (req, res) => {
    await assertNoAdminEscalation(req, req.params.id);
    if (!req.file) throw Errors.badRequest("Nenhum arquivo enviado");
    await usersService.getUser(req.params.id);
    const user = await setUserPhoto(req.params.id, saveProfilePhoto(req.params.id, req.file));
    await writeAudit({ userId: req.auth!.userId, action: "USER_PHOTO_UPDATED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null });
    res.json(toUserDTO(user));
  })
);

usersRouter.delete(
  "/:id/photo",
  requirePermission(PERMISSION.USUARIOS_EDITAR),
  asyncHandler(async (req, res) => {
    await assertNoAdminEscalation(req, req.params.id);
    await usersService.getUser(req.params.id);
    const user = await setUserPhoto(req.params.id, null);
    await writeAudit({ userId: req.auth!.userId, action: "USER_PHOTO_REMOVED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null });
    res.json(toUserDTO(user));
  })
);

usersRouter.post(
  "/:id/activate",
  requirePermission(PERMISSION.USUARIOS_INATIVAR),
  asyncHandler(async (req, res) => {
    await assertNoAdminEscalation(req, req.params.id);
    const user = await usersService.setUserStatus(req.params.id, "ACTIVE", req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "USER_ACTIVATED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null, metadata: { name: user.fullName, email: user.email } });
    res.json(toUserDTO(user));
  })
);

usersRouter.post(
  "/:id/deactivate",
  requirePermission(PERMISSION.USUARIOS_INATIVAR),
  asyncHandler(async (req, res) => {
    await assertNoAdminEscalation(req, req.params.id);
    const user = await usersService.setUserStatus(req.params.id, "INACTIVE", req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "USER_DEACTIVATED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null, metadata: { name: user.fullName, email: user.email } });
    res.json(toUserDTO(user));
  })
);

usersRouter.post(
  "/:id/force-logout",
  requirePermission(PERMISSION.USUARIOS_EDITAR),
  asyncHandler(async (req, res) => {
    await assertNoAdminEscalation(req, req.params.id);
    await usersService.forceLogoutUser(req.params.id);
    realtimeEvents.userForceLoggedOut(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "USER_FORCE_LOGGED_OUT", entity: "User", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

// ADMIN-only, checked directly via requireRole rather than the configurable
// USUARIOS_INATIVAR permission — that one's grantable to a MANAGER, but
// deleting an account is irreversible (unlike deactivate, which already
// exists and stays available to a delegated user manager), so it stays out
// of that matrix entirely. See PROMPT: "somente para o acesso Administrador".
usersRouter.delete(
  "/:id",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    await usersService.deleteUser(req.params.id, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "USER_DELETED", entity: "User", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

usersRouter.post(
  "/:id/reset-password",
  requirePermission(PERMISSION.USUARIOS_EDITAR),
  asyncHandler(async (req, res) => {
    await assertNoAdminEscalation(req, req.params.id);
    const result = await usersService.resetUserPassword(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "USER_PASSWORD_RESET_BY_ADMIN", entity: "User", entityId: req.params.id, ipAddress: req.ip ?? null });
    // Returned once, out-of-band delivery (e-mail) is a documented follow-up — see README roadmap.
    res.json(result);
  })
);
