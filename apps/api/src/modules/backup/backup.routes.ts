import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { BACKUP_PASSWORD_MIN } from "../../lib/backup-crypto";
import * as drive from "../../lib/google-drive";
import * as service from "./backup.service";
import * as driveBackups from "./drive-backup.service";
import { createUpload } from "../../lib/upload";

/**
 * Configurações › Backup — administrador only: everything (database and files) in one password-protected file,
 * downloaded or sent to Google Drive (by hand or every night), and restoring it.
 */
export const backupRouter = Router();

// A backup carries every customer's data: written to disk while it arrives (it can be gigabytes), never to memory.
const upload = createUpload({ storage: multer.diskStorage({ destination: os.tmpdir() }), limits: { fileSize: 100 * 1024 ** 3 } });

const password = z.string().min(BACKUP_PASSWORD_MIN, `A senha precisa ter pelo menos ${BACKUP_PASSWORD_MIN} caracteres`).max(200);
const options = z.object({ files: z.boolean().default(true), sessions: z.boolean().default(false) });
const admin = [requireAuth, requireRole("ADMIN")];
const who = (req: Request) => ({ userId: req.auth!.userId, name: req.auth!.displayName });

/** After a restore the WhatsApp sessions and everything held in memory load again: in production the container
 *  restarts the API by itself (docker compose: restart unless-stopped). */
function restartAfterRestore() {
  if (env.NODE_ENV === "production") setTimeout(() => process.exit(0), 1500);
}

// ---------------------------------------------------------------------------
// Google's redirect after an administrator authorized the Drive (public: a browser redirect carries no login — the
// signed "state" proves who started it).
// ---------------------------------------------------------------------------

backupRouter.get(
  "/google-drive/callback",
  asyncHandler(async (req, res) => {
    // Back to the same address the administrator used (the one registered with Google), not WEB_APP_URL.
    const base = await drive.publicBaseUrl();
    const back = (outcome: string) => res.redirect(`${base}/configuracoes?secao=backup&drive=${outcome}`);
    const { code, state, error } = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    if (error || !code || !state) return back("cancelado");
    try {
      const { userId } = await drive.completeAuthorization(code, state);
      await writeAudit({ userId, action: "GOOGLE_DRIVE_CONNECTED", entity: "SystemSetting", entityId: "googleDrive", ipAddress: req.ip ?? null });
      back("conectado");
    } catch (err) {
      logger.warn({ err }, "Google Drive authorization failed");
      back("erro");
    }
  })
);

// ---------------------------------------------------------------------------
// Download: a plain link (a backup can be too big for the browser's memory). A one-time ticket, valid for two
// minutes, stands in for the login — so the password never goes in an address.
// ---------------------------------------------------------------------------

interface Ticket {
  options: service.BackupOptions;
  password: string;
  userId: string;
  name: string;
  expiresAt: number;
}
const tickets = new Map<string, Ticket>();

backupRouter.get(
  "/download/:ticket",
  asyncHandler(async (req: Request, res: Response) => {
    const ticket = tickets.get(req.params.ticket);
    tickets.delete(req.params.ticket);
    if (!ticket || ticket.expiresAt < Date.now()) throw Errors.notFound("Link de download expirado. Peça o backup de novo.");
    await writeAudit({
      userId: ticket.userId,
      action: "BACKUP_DOWNLOADED",
      entity: "SystemSetting",
      entityId: "backup",
      ipAddress: req.ip ?? null,
      metadata: { files: ticket.options.files, sessions: ticket.options.whatsappSessions },
    });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${service.backupFileName(true)}"`);
    // Straight to the browser as it's produced — nginx must not hold it back.
    res.setHeader("X-Accel-Buffering", "no");
    req.setTimeout(0);
    try {
      await service.writeBackup(res, ticket.options, { userId: ticket.userId, name: ticket.name }, ticket.password);
    } catch (err) {
      logger.error({ err }, "backup failed while streaming");
      res.destroy(err as Error);
    }
  })
);

backupRouter.post(
  "/download-ticket",
  ...admin,
  asyncHandler(async (req, res) => {
    const input = options.extend({ password }).parse(req.body);
    const id = randomUUID();
    for (const [key, t] of tickets) if (t.expiresAt < Date.now()) tickets.delete(key);
    tickets.set(id, { options: { files: input.files, whatsappSessions: input.sessions }, password: input.password, userId: req.auth!.userId, name: req.auth!.displayName, expiresAt: Date.now() + 2 * 60_000 });
    res.json({ url: `/api/settings/backup/download/${id}` });
  })
);

backupRouter.get(
  "/info",
  ...admin,
  asyncHandler(async (_req, res) => {
    res.json(await service.backupInfo());
  })
);

// ---------------------------------------------------------------------------
// Google Drive: the backup password, the connection, the automatic backup and the backups kept there
// ---------------------------------------------------------------------------

backupRouter.get(
  "/settings",
  ...admin,
  asyncHandler(async (_req, res) => {
    const settings = await driveBackups.getSettings();
    res.json({
      drive: await drive.driveStatus(),
      hasBackupPassword: await driveBackups.hasBackupPassword(),
      auto: {
        enabled: settings.autoEnabled,
        keep: settings.keep,
        includeFiles: settings.includeFiles,
        includeSessions: settings.includeSessions,
      },
      lastBackupAt: settings.lastBackupAt,
      lastBackupSize: settings.lastBackupSize,
      lastError: settings.lastError,
      running: Boolean(settings.runningSince),
      backupHour: env.BACKUP_HOUR,
      freeSpaceMb: driveBackups.freeSpaceMb(),
      minFreeSpaceMb: env.BACKUP_MIN_FREE_MB,
      keepRange: { min: driveBackups.KEEP_MIN, max: driveBackups.KEEP_MAX },
    });
  })
);

backupRouter.put(
  "/password",
  ...admin,
  asyncHandler(async (req, res) => {
    const input = z.object({ password, confirm: z.string() }).parse(req.body);
    if (input.password !== input.confirm) throw Errors.badRequest("As senhas não conferem");
    await driveBackups.setBackupPassword(input.password);
    await writeAudit({ userId: req.auth!.userId, action: "BACKUP_PASSWORD_CHANGED", entity: "SystemSetting", entityId: "backupPassword", ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

backupRouter.patch(
  "/drive",
  ...admin,
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        clientId: z.string().trim().min(10).max(300),
        clientSecret: z.string().trim().min(6).max(300).optional(),
        // The site's public address (https://domínio) — what the redirect URI is built from. "" or null = WEB_APP_URL.
        publicUrl: z.string().trim().max(300).nullable().optional(),
      })
      .parse(req.body);
    const status = await drive.setDriveCredentials(input.clientId, input.clientSecret, input.publicUrl);
    await writeAudit({ userId: req.auth!.userId, action: "GOOGLE_DRIVE_CREDENTIALS_UPDATED", entity: "SystemSetting", entityId: "googleDrive", ipAddress: req.ip ?? null });
    res.json(status);
  })
);

backupRouter.post(
  "/drive/connect",
  ...admin,
  asyncHandler(async (req, res) => {
    res.json({ url: await drive.authorizationUrl(req.auth!.userId) });
  })
);

backupRouter.post(
  "/drive/disconnect",
  ...admin,
  asyncHandler(async (req, res) => {
    await drive.disconnectDrive();
    await writeAudit({ userId: req.auth!.userId, action: "GOOGLE_DRIVE_DISCONNECTED", entity: "SystemSetting", entityId: "googleDrive", ipAddress: req.ip ?? null });
    res.json(await drive.driveStatus());
  })
);

backupRouter.patch(
  "/auto",
  ...admin,
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        enabled: z.boolean().optional(),
        keep: z.number().int().min(driveBackups.KEEP_MIN).max(driveBackups.KEEP_MAX).optional(),
        includeFiles: z.boolean().optional(),
        includeSessions: z.boolean().optional(),
      })
      .parse(req.body);
    if (input.enabled && !(await driveBackups.hasBackupPassword())) throw Errors.badRequest("Cadastre a senha de backup antes de ligar o backup automático");
    const saved = await driveBackups.saveSettings({
      ...(input.enabled !== undefined ? { autoEnabled: input.enabled } : {}),
      ...(input.keep !== undefined ? { keep: input.keep } : {}),
      ...(input.includeFiles !== undefined ? { includeFiles: input.includeFiles } : {}),
      ...(input.includeSessions !== undefined ? { includeSessions: input.includeSessions } : {}),
    });
    await writeAudit({ userId: req.auth!.userId, action: "AUTO_BACKUP_CHANGED", entity: "SystemSetting", entityId: "driveBackup", ipAddress: req.ip ?? null, metadata: input });
    res.json({ enabled: saved.autoEnabled, keep: saved.keep, includeFiles: saved.includeFiles, includeSessions: saved.includeSessions });
  })
);

backupRouter.get(
  "/drive/files",
  ...admin,
  asyncHandler(async (_req, res) => {
    res.json(await driveBackups.listDriveBackups());
  })
);

// Sending to the Drive can take a while: answered at once, the screen follows it on the settings (running / done / error).
backupRouter.post(
  "/drive/backup",
  ...admin,
  asyncHandler(async (req, res) => {
    const input = options.parse(req.body ?? {});
    if (!(await driveBackups.hasBackupPassword())) throw Errors.badRequest("Cadastre a senha de backup antes de enviar ao Google Drive");
    if (!(await drive.driveStatus()).connected) throw Errors.badRequest("Conecte o Google Drive antes de enviar");
    // Marked as running before answering: a second click (or a second administrator) gets "already running".
    if (!(await driveBackups.claimBackupRun())) throw Errors.conflict("Já há um backup em andamento");
    await writeAudit({ userId: req.auth!.userId, action: "BACKUP_TO_DRIVE", entity: "SystemSetting", entityId: "driveBackup", ipAddress: req.ip ?? null, metadata: input });
    driveBackups.backupToDrive({ files: input.files, whatsappSessions: input.sessions }, "MANUAL", who(req), true).catch(() => undefined);
    res.status(202).json({ started: true });
  })
);

backupRouter.post(
  "/drive/files/:fileId/restore",
  ...admin,
  asyncHandler(async (req, res) => {
    const input = z.object({ confirm: z.string(), password: z.string().max(200).optional() }).parse(req.body ?? {});
    if (input.confirm.trim().toUpperCase() !== "RESTAURAR") throw Errors.badRequest("Digite RESTAURAR para confirmar");
    req.setTimeout(0);
    const result = await driveBackups.restoreFromDrive(req.params.fileId, input.password || undefined, who(req));
    await writeAudit({ userId: req.auth!.userId, action: "BACKUP_RESTORED", entity: "SystemSetting", entityId: "backup", ipAddress: req.ip ?? null, metadata: { from: "GOOGLE_DRIVE", createdAt: result.manifest.createdAt, rows: result.rows } }).catch(() => undefined);
    res.json({ version: result.manifest.version, createdAt: result.manifest.createdAt, rows: result.rows, files: result.files, restarting: env.NODE_ENV === "production" });
    restartAfterRestore();
  })
);

// ---------------------------------------------------------------------------
// Restore from a file sent by the browser
// ---------------------------------------------------------------------------

backupRouter.post(
  "/restore",
  ...admin,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    try {
      if (!file) throw Errors.badRequest("Escolha o arquivo do backup");
      const { confirm, password: typed } = z.object({ confirm: z.string(), password: z.string().max(200).optional() }).parse(req.body ?? {});
      if (confirm.trim().toUpperCase() !== "RESTAURAR") throw Errors.badRequest("Digite RESTAURAR para confirmar");
      req.setTimeout(0);
      const result = await service.restoreBackupFile(file.path, typed || undefined, who(req));
      await writeAudit({ userId: req.auth!.userId, action: "BACKUP_RESTORED", entity: "SystemSetting", entityId: "backup", ipAddress: req.ip ?? null, metadata: { from: "UPLOAD", createdAt: result.manifest.createdAt, rows: result.rows } }).catch(() => undefined);
      res.json({ version: result.manifest.version, createdAt: result.manifest.createdAt, rows: result.rows, files: result.files, restarting: env.NODE_ENV === "production" });
      restartAfterRestore();
    } finally {
      if (file) fs.rm(file.path, { force: true }, () => undefined);
    }
  })
);
