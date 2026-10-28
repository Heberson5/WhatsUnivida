import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import { profilePhotoUpload, saveProfilePhoto } from "../../lib/profile-photo";
import { toUserDTO } from "../users/users.mapper";
import { realtimeEvents } from "../../realtime/realtime";
import * as service from "./profile.service";

export const profileRouter = Router();

profileRouter.use(requireAuth);

profileRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await service.getOwnProfile(req.auth!.userId);
    res.json(toUserDTO(user));
  })
);

// No PATCH "/": the user can't rename themselves — reports and the Dashboard show the current name, so only Usuários
// (with its "é a mesma pessoa?" check) changes it.

profileRouter.post(
  "/photo",
  profilePhotoUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhum arquivo enviado" });
    const user = await service.updateOwnPhoto(req.auth!.userId, saveProfilePhoto(req.auth!.userId, req.file));
    await writeAudit({ userId: req.auth!.userId, action: "PROFILE_PHOTO_UPLOADED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null });
    res.json(toUserDTO(user));
  })
);

profileRouter.delete(
  "/photo",
  asyncHandler(async (req, res) => {
    const user = await service.updateOwnPhoto(req.auth!.userId, null);
    await writeAudit({ userId: req.auth!.userId, action: "PROFILE_PHOTO_REMOVED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null });
    res.json(toUserDTO(user));
  })
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
  confirmPassword: z.string().min(8),
});

profileRouter.post(
  "/password",
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = passwordSchema.parse(req.body);
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "As senhas nao coincidem" });
    }
    await service.changeOwnPassword(req.auth!.userId, currentPassword, newPassword);
    await writeAudit({ userId: req.auth!.userId, action: "PROFILE_PASSWORD_CHANGED", entity: "User", entityId: req.auth!.userId, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

// Notas de versão: remembers the newest release this user has seen, so the
// sidebar's "Novo" badge and the "O que há de novo" popup stop showing it.
const releaseNotesSeenSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/, "Versão inválida") });

profileRouter.patch(
  "/release-notes-seen",
  asyncHandler(async (req, res) => {
    const { version } = releaseNotesSeenSchema.parse(req.body);
    await service.markReleaseNotesSeen(req.auth!.userId, version);
    res.json({ releaseNotesSeenVersion: version });
  })
);

const soundsSchema = z
  .object({ soundNewMessage: z.boolean().optional(), soundNewQueue: z.boolean().optional(), soundVolume: z.number().int().min(0).max(100).optional() })
  .strict();

profileRouter.patch(
  "/sounds",
  asyncHandler(async (req, res) => {
    const user = await service.updateOwnSounds(req.auth!.userId, soundsSchema.parse(req.body));
    res.json(toUserDTO(user));
  })
);

const pauseSchema = z.object({ pauseReasonId: z.string().uuid() });

profileRouter.post(
  "/pause",
  asyncHandler(async (req, res) => {
    const { pauseReasonId } = pauseSchema.parse(req.body);
    const user = await service.pauseOwnAttendance(req.auth!.userId, pauseReasonId);
    realtimeEvents.presenceChanged(req.auth!.userId, "AWAY");
    await writeAudit({ userId: req.auth!.userId, action: "PROFILE_PAUSED", entity: "User", entityId: req.auth!.userId, ipAddress: req.ip ?? null, metadata: { pauseReasonId } });
    res.json(toUserDTO(user));
  })
);

profileRouter.post(
  "/resume",
  asyncHandler(async (req, res) => {
    const user = await service.resumeOwnAttendance(req.auth!.userId);
    realtimeEvents.presenceChanged(req.auth!.userId, "ONLINE");
    await writeAudit({ userId: req.auth!.userId, action: "PROFILE_RESUMED", entity: "User", entityId: req.auth!.userId, ipAddress: req.ip ?? null });
    res.json(toUserDTO(user));
  })
);
