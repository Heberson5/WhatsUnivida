import fs from "node:fs";
import os from "node:os";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireAuthFromHeaderOrQuery, requireRole } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import * as service from "./backup.service";

/** Configurações › Backup — administrador only: everything (database and files) in one file, and restoring it. */
export const backupRouter = Router();

// A backup carries every customer's data: written to disk while it arrives (it can be gigabytes), never to memory.
const upload = multer({ storage: multer.diskStorage({ destination: os.tmpdir() }), limits: { fileSize: 100 * 1024 ** 3 } });

backupRouter.get(
  "/info",
  requireAuth,
  requireRole("ADMIN"),
  asyncHandler(async (_req, res) => {
    res.json(await service.backupInfo());
  })
);

// The browser downloads it from a plain link, so the token may come in the query (like an attachment preview).
backupRouter.get(
  "/download",
  requireAuthFromHeaderOrQuery,
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const { files, sessions } = z.object({ files: z.enum(["0", "1"]).default("1"), sessions: z.enum(["0", "1"]).default("0") }).parse(req.query);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
    await writeAudit({ userId: req.auth!.userId, action: "BACKUP_DOWNLOADED", entity: "SystemSetting", entityId: "backup", ipAddress: req.ip ?? null, metadata: { files, sessions } });
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="whatsatendende-backup-${stamp}.tar.gz"`);
    // Straight to the browser as it's produced — nginx must not hold it back.
    res.setHeader("X-Accel-Buffering", "no");
    req.setTimeout(0);
    try {
      await service.writeBackup(res, { files: files === "1", whatsappSessions: sessions === "1" }, { userId: req.auth!.userId, name: req.auth!.displayName });
    } catch (err) {
      logger.error({ err }, "backup failed while streaming");
      res.destroy(err as Error);
    }
  })
);

backupRouter.post(
  "/restore",
  requireAuth,
  requireRole("ADMIN"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    try {
      if (!file) throw Errors.badRequest("Escolha o arquivo do backup");
      const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
      if (confirm.trim().toUpperCase() !== "RESTAURAR") throw Errors.badRequest("Digite RESTAURAR para confirmar");
      req.setTimeout(0);
      const result = await service.restoreBackup(fs.createReadStream(file.path), { userId: req.auth!.userId, name: req.auth!.displayName });
      res.json({ version: result.manifest.version, createdAt: result.manifest.createdAt, rows: result.rows, files: result.files, restarting: env.NODE_ENV === "production" });
      // The restored WhatsApp sessions and everything held in memory load again: in production the container
      // restarts the API by itself (docker compose: restart unless-stopped).
      if (env.NODE_ENV === "production") setTimeout(() => process.exit(0), 1500);
    } finally {
      if (file) fs.rm(file.path, { force: true }, () => undefined);
    }
  })
);
