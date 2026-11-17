import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { sendMail } from "../../lib/mail";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import * as drive from "../../lib/google-drive";
import { backupFileName, restoreBackupFile, writeBackup, type BackupOptions } from "./backup.service";

/**
 * Backups on Google Drive (Configurações › Backup) — nothing is kept on this server: the file is built in a temporary
 * folder, encrypted with the backup password, sent, and removed. The newest `keep` backups stay on the Drive; older
 * ones are deleted. The automatic backup runs every night from BACKUP_HOUR (business time).
 */

const SETTINGS_KEY = "driveBackup";
const PASSWORD_KEY = "backupPassword";
export const KEEP_MIN = 1;
export const KEEP_MAX = 60;
/** A backup "running" for longer than this was cut off (a restart): it no longer blocks the next one. */
const STALE_RUN_MS = 6 * 60 * 60_000;

export interface DriveBackupSettings {
  autoEnabled: boolean;
  /** How many backups stay on the Drive (the newest ones). */
  keep: number;
  /** What the automatic backup takes: the data always; the files and the WhatsApp sessions as chosen here. */
  includeFiles: boolean;
  includeSessions: boolean;
  lastBackupAt: string | null;
  lastBackupSize: number | null;
  /** The last nightly attempt (worked or not): one try per night, never every few minutes after a failure. */
  lastAttemptAt: string | null;
  lastError: string | null;
  runningSince: string | null;
}

const DEFAULTS: DriveBackupSettings = {
  autoEnabled: false,
  keep: 7,
  includeFiles: true,
  includeSessions: false,
  lastBackupAt: null,
  lastBackupSize: null,
  lastAttemptAt: null,
  lastError: null,
  runningSince: null,
};

export async function getSettings(): Promise<DriveBackupSettings> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
  return { ...DEFAULTS, ...((row?.value as Partial<DriveBackupSettings> | undefined) ?? {}) };
}

export async function saveSettings(patch: Partial<DriveBackupSettings>): Promise<DriveBackupSettings> {
  const next = { ...(await getSettings()), ...patch };
  const value = next as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value }, create: { key: SETTINGS_KEY, value } });
  return next;
}

// ---------------------------------------------------------------------------
// The backup password (encrypts the Drive backups; typed once by an administrator, never shown again)
// ---------------------------------------------------------------------------

export async function hasBackupPassword(): Promise<boolean> {
  return Boolean(await prisma.systemSetting.findUnique({ where: { key: PASSWORD_KEY } }));
}

export async function getBackupPassword(): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: PASSWORD_KEY } });
  const stored = (row?.value as { password?: string } | undefined)?.password;
  return stored ? decryptSecret(stored) : null;
}

export async function setBackupPassword(password: string): Promise<void> {
  const value = { password: encryptSecret(password) } as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: PASSWORD_KEY }, update: { value }, create: { key: PASSWORD_KEY, value } });
}

/** Something the administrators have to know: in the bell of each one and by e-mail (Configurações › E-mail). */
export async function notifyAdmins(title: string, body: string): Promise<void> {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE", isAssistant: false }, select: { id: true, email: true } });
  for (const admin of admins) {
    await prisma.notification.create({ data: { userId: admin.id, type: "BACKUP_ALERT", title, body, entityType: "SystemSetting", entityId: SETTINGS_KEY } });
    await sendMail(admin.email, title, `<p>${body}</p>`, body).catch((err) => logger.error({ err }, "failed to e-mail a backup alert"));
  }
}

/** Free space where the temporary copy is built, in MB. */
export function freeSpaceMb(dir = os.tmpdir()): number {
  const stats = fs.statfsSync(dir);
  return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
}

/** Marks a backup as running — so two requests (or the night and a click) never build two at once. */
export async function claimBackupRun(): Promise<boolean> {
  const settings = await getSettings();
  if (settings.runningSince && Date.now() - Date.parse(settings.runningSince) < STALE_RUN_MS) return false;
  await saveSettings({ runningSince: new Date().toISOString() });
  return true;
}

const isBackupName = (name: string) => name.startsWith("backup-") && name.endsWith(".wabk");

/**
 * The whole backup straight to the Drive, encrypted with the backup password. Records the outcome on the settings and
 * tells the administrators when it fails.
 */
export async function backupToDrive(options: BackupOptions, trigger: "MANUAL" | "AUTOMATIC", by: { userId: string; name: string }, claimed = false): Promise<drive.DriveFile> {
  if (!claimed && !(await claimBackupRun())) throw Errors.conflict("Já há um backup em andamento");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-drive-backup-"));
  try {
    const password = await getBackupPassword();
    if (!password) throw Errors.badRequest("Cadastre a senha de backup (Configurações › Backup) antes de enviar ao Google Drive");
    const free = freeSpaceMb(tmp);
    if (free < env.BACKUP_MIN_FREE_MB) throw Errors.conflict(`Pouco espaço livre no servidor para preparar o backup (${free} MB livres; o mínimo é ${env.BACKUP_MIN_FREE_MB} MB)`);
    const folder = await drive.backupsFolder();
    const file = path.join(tmp, backupFileName(true));
    await writeBackup(fs.createWriteStream(file), options, by, password);
    const sent = await drive.uploadFile(file, path.basename(file), folder);
    // Only the newest ones stay; only files the system itself named as backups are ever deleted.
    const { keep } = await getSettings();
    const backups = (await drive.listFiles(folder)).filter((f) => isBackupName(f.name));
    for (const old of backups.slice(keep)) await drive.deleteFile(old.id);
    await saveSettings({ lastBackupAt: new Date().toISOString(), lastBackupSize: sent.size, lastError: null, runningSince: null });
    logger.info({ trigger, size: sent.size }, "backup sent to Google Drive");
    return sent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveSettings({ lastError: message.slice(0, 500), runningSince: null }).catch(() => undefined);
    logger.error({ err, trigger }, "backup to Google Drive failed");
    await notifyAdmins("Backup não feito", `O backup ${trigger === "AUTOMATIC" ? "automático" : "manual"} para o Google Drive falhou: ${message}`).catch(() => undefined);
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function listDriveBackups() {
  const status = await drive.driveStatus();
  if (!status.connected) return { connected: false, files: [] as drive.DriveFile[] };
  const folder = await drive.backupsFolder();
  return { connected: true, files: (await drive.listFiles(folder)).filter((f) => isBackupName(f.name)) };
}

/** A backup kept on the Drive, brought down to a temporary file only to be restored (then removed). */
export async function restoreFromDrive(fileId: string, password: string | undefined, by: { userId: string; name: string }) {
  const folder = await drive.backupsFolder();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-drive-restore-"));
  try {
    const free = freeSpaceMb(tmp);
    if (free < env.BACKUP_MIN_FREE_MB) throw Errors.conflict(`Pouco espaço livre no servidor para baixar o backup (${free} MB livres)`);
    const file = path.join(tmp, "backup.wabk");
    await drive.downloadFile(fileId, folder, file);
    const usable = password || (await getBackupPassword()) || undefined;
    return await restoreBackupFile(file, usable, by);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let nightlyRunning = false;

/** The business day (BUSINESS_TZ_OFFSET_MINUTES) of a moment, as YYYY-MM-DD, and its local hour. */
function businessClock(now: Date) {
  const local = new Date(now.getTime() - env.BUSINESS_TZ_OFFSET_MINUTES * 60_000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

/**
 * server.ts's timer: from BACKUP_HOUR (local time) on, if the automatic backup is on and there was no attempt yet
 * today, one backup to the Drive. A failure is retried the next night (or by hand), never every few minutes.
 */
export async function runNightlyBackup(now = new Date()): Promise<"DONE" | "FAILED" | "SKIPPED"> {
  if (nightlyRunning) return "SKIPPED";
  const { day, hour } = businessClock(now);
  if (hour < env.BACKUP_HOUR) return "SKIPPED";
  const settings = await getSettings();
  if (!settings.autoEnabled) return "SKIPPED";
  if (settings.lastAttemptAt && businessClock(new Date(settings.lastAttemptAt)).day >= day) return "SKIPPED";
  nightlyRunning = true;
  try {
    await saveSettings({ lastAttemptAt: now.toISOString() });
    if (!(await drive.driveStatus()).connected) {
      await saveSettings({ lastError: "O Google Drive não está conectado" });
      await notifyAdmins("Backup automático parado", "O Google Drive não está conectado: o backup automático de hoje não foi feito. Conecte em Configurações › Backup.");
      return "FAILED";
    }
    if (!(await claimBackupRun())) return "SKIPPED";
    try {
      await backupToDrive({ files: settings.includeFiles, whatsappSessions: settings.includeSessions }, "AUTOMATIC", { userId: "", name: "Backup automático" }, true);
      return "DONE";
    } catch {
      // Already recorded on the settings and told to the administrators.
      return "FAILED";
    }
  } finally {
    nightlyRunning = false;
  }
}
