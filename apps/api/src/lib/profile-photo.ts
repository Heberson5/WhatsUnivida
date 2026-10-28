import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { Errors } from "./http-error";

// Shared by Meu Perfil (own photo) and Usuários (a manager/admin setting
// someone else's photo) so both follow exactly the same rules.
const profilePhotoDir = path.join(env.UPLOAD_DIR, "profile");
fs.mkdirSync(profilePhotoDir, { recursive: true });

// Same reasoning as the branding-logo upload: raster formats only, SVG
// excluded (an uploaded SVG can embed <script>).
const ALLOWED_PHOTO_MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export const profilePhotoUpload = multer({
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

/** Writes the uploaded photo to disk and returns its public URL. */
export function saveProfilePhoto(userId: string, file: Express.Multer.File): string {
  const fileName = `photo-${userId}-${randomUUID()}${ALLOWED_PHOTO_MIME_TO_EXT[file.mimetype]}`;
  fs.writeFileSync(path.join(profilePhotoDir, fileName), file.buffer);
  return `/uploads/profile/${fileName}`;
}
