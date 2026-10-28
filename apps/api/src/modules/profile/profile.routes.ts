import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import { env } from "../../config/env";
import { Errors } from "../../lib/http-error";
import { toUserDTO } from "../users/users.mapper";
import * as service from "./profile.service";

export const profileRouter = Router();

profileRouter.use(requireAuth);

const profilePhotoDir = path.join(env.UPLOAD_DIR, "profile");
fs.mkdirSync(profilePhotoDir, { recursive: true });

// Same reasoning as the branding-logo upload: raster formats only, SVG
// excluded (an uploaded SVG can embed <script>).
const ALLOWED_PHOTO_MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

const upload = multer({
  storage: multer.memoryStorage(),
  // A raw, un-resized phone camera photo is routinely 3-8MB — 2MB used to
  // reject exactly that (the most common source for a profile photo) with
  // an error the UI only ever showed as a generic "erro interno do
  // servidor", making the upload look silently broken. See error-handler.ts
  // for the other half of this fix (a real message for whichever limit is
  // still hit).
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(file.mimetype in ALLOWED_PHOTO_MIME_TO_EXT)) {
      return cb(Errors.badRequest("Formato de imagem nao suportado"));
    }
    cb(null, true);
  },
});

profileRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await service.getOwnProfile(req.auth!.userId);
    res.json(toUserDTO(user));
  })
);

const updateSchema = z.object({
  fullName: z.string().min(2).optional(),
  displayName: z.string().min(1).optional(),
});

profileRouter.patch(
  "/",
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const user = await service.updateOwnProfile(req.auth!.userId, input);
    await writeAudit({ userId: req.auth!.userId, action: "PROFILE_UPDATED", entity: "User", entityId: user.id, ipAddress: req.ip ?? null, metadata: input });
    res.json(toUserDTO(user));
  })
);

profileRouter.post(
  "/photo",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhum arquivo enviado" });
    const fileName = `photo-${req.auth!.userId}-${randomUUID()}${ALLOWED_PHOTO_MIME_TO_EXT[req.file.mimetype]}`;
    fs.writeFileSync(path.join(profilePhotoDir, fileName), req.file.buffer);
    const user = await service.updateOwnPhoto(req.auth!.userId, `/uploads/profile/${fileName}`);
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
