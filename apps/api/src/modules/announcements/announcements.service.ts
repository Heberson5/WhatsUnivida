import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { Jimp } from "jimp";
import { imageSize } from "image-size";
import type { Announcement, Prisma, Role } from "@prisma/client";
import {
  ANNOUNCEMENT_REACTIONS,
  type AnnouncementAdminDTO,
  type AnnouncementAudience,
  type AnnouncementBoardSettingsDTO,
  type AnnouncementDTO,
  type AnnouncementFileDTO,
  type AnnouncementInput,
  type AnnouncementReceiptRowDTO,
  type AnnouncementStatsDTO,
  type AnnouncementStatus,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { Errors } from "../../lib/http-error";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { addDays, hasEnded, hasStarted, nextDay, nowKey, showsNow, todayKey } from "./announcement-days";

/**
 * Pop Up › Avisos: notices shown after login ("stories" pop-up, or grouped into Comunicados when there are many) and
 * kept as a history that can be duplicated. Images and PDFs live in UPLOAD_DIR/announcements under random names.
 */

const FILE_DIR = path.join(env.UPLOAD_DIR, "announcements");
fs.mkdirSync(FILE_DIR, { recursive: true });

const BOARD_SETTINGS_KEY = "announcementBoard";
const DEFAULT_BOARD: AnnouncementBoardSettingsDTO = { name: "Comunicados", trashDays: 30 };
/** How long an ended notice stays on the board, under "Anteriores". */
const BOARD_HISTORY_DAYS = 90;
// Wide enough for a full-width cover on a large screen, small enough to load fast on a phone.
const IMAGE_MAX_WIDTH = 1600;
const IMAGE_MAX_MB = 10;
const PDF_MAX_MB = 15;
const DEFAULT_TZ = 240;

interface StoredFile {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export interface Viewer {
  userId: string;
  role: Role;
  sessionId?: string;
}

// ---------------------------------------------------------------- settings

export async function getBoardSettings(): Promise<AnnouncementBoardSettingsDTO> {
  const row = await prisma.systemSetting.findUnique({ where: { key: BOARD_SETTINGS_KEY } });
  return { ...DEFAULT_BOARD, ...((row?.value as Partial<AnnouncementBoardSettingsDTO>) ?? {}) };
}

export async function updateBoardSettings(patch: Partial<AnnouncementBoardSettingsDTO>): Promise<AnnouncementBoardSettingsDTO> {
  const next = { ...(await getBoardSettings()), ...patch };
  next.name = next.name.trim() || DEFAULT_BOARD.name;
  await prisma.systemSetting.upsert({
    where: { key: BOARD_SETTINGS_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: BOARD_SETTINGS_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  realtimeEvents.announcementsChanged();
  return next;
}

// ---------------------------------------------------------------- files

export const announcementFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(IMAGE_MAX_MB, PDF_MAX_MB) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype)) {
      return cb(Errors.badRequest("Escolha uma imagem (JPG, PNG ou WEBP) ou um PDF."));
    }
    cb(null, true);
  },
});

function fileUrl(storageKey: string): string {
  return `/uploads/announcements/${storageKey}`;
}

function toFileDTO(f: StoredFile): AnnouncementFileDTO {
  return { url: fileUrl(f.storageKey), fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, width: f.width ?? null, height: f.height ?? null };
}

/** Big photos are reduced to IMAGE_MAX_WIDTH (JPG/PNG) so the pop-up opens fast; WEBP is kept as sent. */
async function storeFile(file: Express.Multer.File): Promise<{ kind: "image" | "attachment"; stored: StoredFile }> {
  if (file.mimetype === "application/pdf") {
    if (file.size > PDF_MAX_MB * 1024 * 1024) throw Errors.badRequest(`O PDF pode ter até ${PDF_MAX_MB} MB.`);
    const storageKey = `${randomUUID()}.pdf`;
    fs.writeFileSync(path.join(FILE_DIR, storageKey), file.buffer);
    return { kind: "attachment", stored: { storageKey, fileName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size } };
  }
  if (file.size > IMAGE_MAX_MB * 1024 * 1024) throw Errors.badRequest(`A imagem pode ter até ${IMAGE_MAX_MB} MB.`);
  let buffer = file.buffer;
  let mimeType = file.mimetype;
  let ext = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
  let { width, height } = imageSize(buffer);
  if (mimeType !== "image/webp" && width && width > IMAGE_MAX_WIDTH) {
    const image = await Jimp.fromBuffer(buffer);
    image.resize({ w: IMAGE_MAX_WIDTH, h: Math.round((image.height * IMAGE_MAX_WIDTH) / image.width) });
    // A photo becomes JPG (much smaller); a PNG with transparency (a logo, a drawing) stays PNG.
    const opaque = mimeType === "image/jpeg";
    buffer = opaque ? await image.getBuffer("image/jpeg", { quality: 84 }) : await image.getBuffer("image/png");
    mimeType = opaque ? "image/jpeg" : "image/png";
    ext = opaque ? ".jpg" : ".png";
    width = image.width;
    height = image.height;
  }
  const storageKey = `${randomUUID()}${ext}`;
  fs.writeFileSync(path.join(FILE_DIR, storageKey), buffer);
  return { kind: "image", stored: { storageKey, fileName: file.originalname, mimeType, sizeBytes: buffer.length, width: width ?? null, height: height ?? null } };
}

function removeStoredFiles(files: StoredFile[]): void {
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(FILE_DIR, path.basename(f.storageKey)));
    } catch {
      // Already gone — nothing to clean.
    }
  }
}

function copyStoredFiles(files: StoredFile[]): StoredFile[] {
  const copies: StoredFile[] = [];
  for (const f of files) {
    const storageKey = `${randomUUID()}${path.extname(f.storageKey)}`;
    try {
      fs.copyFileSync(path.join(FILE_DIR, path.basename(f.storageKey)), path.join(FILE_DIR, storageKey));
      copies.push({ ...f, storageKey });
    } catch {
      // A file missing on disk is simply left out of the copy.
    }
  }
  return copies;
}

const imagesOf = (a: Pick<Announcement, "images">) => (a.images as unknown as StoredFile[]) ?? [];
const attachmentsOf = (a: Pick<Announcement, "attachments">) => (a.attachments as unknown as StoredFile[]) ?? [];

export async function addFile(id: string, file: Express.Multer.File | undefined, userId: string): Promise<AnnouncementAdminDTO> {
  if (!file) throw Errors.badRequest("Nenhum arquivo enviado");
  const row = await findLive(id);
  const { kind, stored } = await storeFile(file);
  const data =
    kind === "image"
      ? { images: [...imagesOf(row), stored] as unknown as Prisma.InputJsonValue }
      : { attachments: [...attachmentsOf(row), stored] as unknown as Prisma.InputJsonValue };
  await prisma.announcement.update({ where: { id }, data: { ...data, updatedById: userId } });
  realtimeEvents.announcementsChanged();
  return getAdmin(id);
}

export async function removeFile(id: string, storageKey: string, userId: string): Promise<AnnouncementAdminDTO> {
  const row = await findLive(id);
  const images = imagesOf(row);
  const attachments = attachmentsOf(row);
  const gone = [...images, ...attachments].filter((f) => f.storageKey === storageKey);
  if (gone.length === 0) throw Errors.notFound("Arquivo não encontrado");
  await prisma.announcement.update({
    where: { id },
    data: {
      images: images.filter((f) => f.storageKey !== storageKey) as unknown as Prisma.InputJsonValue,
      attachments: attachments.filter((f) => f.storageKey !== storageKey) as unknown as Prisma.InputJsonValue,
      updatedById: userId,
    },
  });
  removeStoredFiles(gone);
  realtimeEvents.announcementsChanged();
  return getAdmin(id);
}

/** The cover is the first image — the admin picks which one by moving it to the front. */
export async function moveImageFirst(id: string, storageKey: string, userId: string): Promise<AnnouncementAdminDTO> {
  const row = await findLive(id);
  const images = imagesOf(row);
  const chosen = images.find((f) => f.storageKey === storageKey);
  if (!chosen) throw Errors.notFound("Imagem não encontrada");
  await prisma.announcement.update({
    where: { id },
    data: { images: [chosen, ...images.filter((f) => f !== chosen)] as unknown as Prisma.InputJsonValue, updatedById: userId },
  });
  realtimeEvents.announcementsChanged();
  return getAdmin(id);
}

// ---------------------------------------------------------------- audience

interface AudienceUser {
  id: string;
  displayName: string;
  role: Role;
  whatsappConnectionId: string | null;
}

function normalizeAudience(raw: unknown): AnnouncementAudience {
  const a = (raw ?? {}) as Partial<AnnouncementAudience>;
  return { all: a.all ?? true, roles: a.roles ?? [], connectionIds: a.connectionIds ?? [], userIds: a.userIds ?? [] };
}

export function inAudience(user: AudienceUser, audienceRaw: unknown): boolean {
  const a = normalizeAudience(audienceRaw);
  if (a.all) return true;
  return a.roles.includes(user.role) || (user.whatsappConnectionId !== null && a.connectionIds.includes(user.whatsappConnectionId)) || a.userIds.includes(user.id);
}

async function activeUsers(): Promise<AudienceUser[]> {
  return prisma.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, displayName: true, role: true, whatsappConnectionId: true } });
}

async function viewerUser(userId: string): Promise<AudienceUser> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, role: true, whatsappConnectionId: true } });
  if (!user) throw Errors.notFound("Usuário não encontrado");
  return user;
}

// ---------------------------------------------------------------- mapping

function statusOf(a: Announcement, now: string): AnnouncementStatus {
  if (a.paused) return "PAUSED";
  if (hasEnded(a, now)) return "ENDED";
  if (!hasStarted(a, now)) return "SCHEDULED";
  return "ACTIVE";
}

function baseDTO(
  a: Announcement,
  now: string,
  extra: { authorName: string | null; readAt: Date | null; ackAt: Date | null; reactions: AnnouncementDTO["reactions"] }
): AnnouncementDTO {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    kind: a.kind,
    layout: a.layout,
    display: a.display,
    category: a.category,
    requireAck: a.requireAck,
    pinned: a.pinned,
    linkUrl: a.linkUrl,
    linkLabel: a.linkLabel,
    startDate: a.startDate,
    startTime: a.startTime,
    endDate: a.endDate,
    endTime: a.endTime,
    recurrence: a.recurrence,
    audience: normalizeAudience(a.audience),
    images: imagesOf(a).map(toFileDTO),
    attachments: attachmentsOf(a).map(toFileDTO),
    createdAt: a.createdAt.toISOString(),
    authorName: extra.authorName,
    readAt: extra.readAt?.toISOString() ?? null,
    ackAt: extra.ackAt?.toISOString() ?? null,
    reactions: extra.reactions,
    showsToday: !a.paused && showsNow(a, now),
  };
}

async function authorNames(ids: string[]): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, displayName: true } });
  return new Map(users.map((u) => [u.id, u.displayName]));
}

async function reactionsFor(ids: string[], userId: string | null): Promise<Map<string, AnnouncementDTO["reactions"]>> {
  const rows = ids.length ? await prisma.announcementReaction.findMany({ where: { announcementId: { in: ids } }, select: { announcementId: true, userId: true, emoji: true } }) : [];
  const out = new Map<string, AnnouncementDTO["reactions"]>();
  for (const id of ids) {
    const mine = rows.filter((r) => r.announcementId === id);
    out.set(
      id,
      ANNOUNCEMENT_REACTIONS.map((emoji) => ({
        emoji,
        count: mine.filter((r) => r.emoji === emoji).length,
        mine: userId !== null && mine.some((r) => r.emoji === emoji && r.userId === userId),
      }))
    );
  }
  return out;
}

async function toAdminDTOs(rows: Announcement[], tz = DEFAULT_TZ): Promise<AnnouncementAdminDTO[]> {
  if (rows.length === 0) return [];
  const now = nowKey(tz);
  const ids = rows.map((r) => r.id);
  const [names, users, receipts, reactions] = await Promise.all([
    authorNames(rows.map((r) => r.createdById)),
    activeUsers(),
    prisma.announcementReceipt.findMany({ where: { announcementId: { in: ids } }, select: { announcementId: true, userId: true, readAt: true, ackAt: true } }),
    reactionsFor(ids, null),
  ]);
  return rows.map((a) => {
    const audience = users.filter((u) => inAudience(u, a.audience));
    const audienceIds = new Set(audience.map((u) => u.id));
    const mine = receipts.filter((r) => r.announcementId === a.id && audienceIds.has(r.userId));
    return {
      ...baseDTO(a, now, { authorName: names.get(a.createdById) ?? null, readAt: null, ackAt: null, reactions: reactions.get(a.id) ?? [] }),
      paused: a.paused,
      status: statusOf(a, now),
      deletedAt: a.deletedAt?.toISOString() ?? null,
      audienceCount: audience.length,
      readCount: mine.filter((r) => r.readAt).length,
      ackCount: mine.filter((r) => r.ackAt).length,
      updatedAt: a.updatedAt.toISOString(),
      nextDay: a.paused || hasEnded(a, now) ? null : nextDay(a, now.slice(0, 10)),
    };
  });
}

// ---------------------------------------------------------------- admin CRUD

async function findLive(id: string): Promise<Announcement> {
  const row = await prisma.announcement.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw Errors.notFound("Aviso não encontrado");
  return row;
}

export async function listAdmin(tz = DEFAULT_TZ): Promise<AnnouncementAdminDTO[]> {
  const rows = await prisma.announcement.findMany({ where: { deletedAt: null }, orderBy: [{ startDate: "desc" }, { createdAt: "desc" }] });
  return toAdminDTOs(rows, tz);
}

export async function getAdmin(id: string, tz = DEFAULT_TZ): Promise<AnnouncementAdminDTO> {
  const row = await prisma.announcement.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Aviso não encontrado");
  return (await toAdminDTOs([row], tz))[0];
}

function inputData(input: AnnouncementInput) {
  if (`${input.endDate} ${input.endTime}` <= `${input.startDate} ${input.startTime}`) {
    throw Errors.badRequest("O término precisa ser depois do início.");
  }
  return {
    title: input.title.trim(),
    body: input.body,
    kind: input.kind,
    layout: input.layout,
    display: input.display,
    category: input.category?.trim() || null,
    // A pop-up only closes with "Li e estou ciente"; the option is only a choice for a notice shown just on the board.
    requireAck: input.display === "POPUP_AND_BOARD" || input.requireAck,
    pinned: input.pinned,
    linkUrl: input.linkUrl?.trim() || null,
    linkLabel: input.linkLabel?.trim() || null,
    startDate: input.startDate,
    startTime: input.startTime,
    endDate: input.endDate,
    endTime: input.endTime,
    recurrence: input.recurrence,
    audience: normalizeAudience(input.audience) as unknown as Prisma.InputJsonValue,
  };
}

export async function create(input: AnnouncementInput, userId: string): Promise<AnnouncementAdminDTO> {
  const row = await prisma.announcement.create({ data: { ...inputData(input), createdById: userId } });
  realtimeEvents.announcementsChanged();
  return getAdmin(row.id);
}

export async function update(id: string, input: AnnouncementInput, userId: string): Promise<AnnouncementAdminDTO> {
  await findLive(id);
  await prisma.announcement.update({ where: { id }, data: { ...inputData(input), updatedById: userId } });
  realtimeEvents.announcementsChanged();
  return getAdmin(id);
}

/** A copy to publish again: same text, files and audience, starting today, without readings. */
export async function duplicate(id: string, userId: string, tz = DEFAULT_TZ): Promise<AnnouncementAdminDTO> {
  const source = await prisma.announcement.findUnique({ where: { id } });
  if (!source) throw Errors.notFound("Aviso não encontrado");
  const today = todayKey(tz);
  const length = source.endDate ? Math.max(0, (Date.parse(source.endDate) - Date.parse(source.startDate)) / 86_400_000) : null;
  const row = await prisma.announcement.create({
    data: {
      title: source.title,
      body: source.body,
      kind: source.kind,
      layout: source.layout,
      display: source.display,
      category: source.category,
      requireAck: source.display === "POPUP_AND_BOARD" || source.requireAck,
      pinned: source.pinned,
      linkUrl: source.linkUrl,
      linkLabel: source.linkLabel,
      startDate: today,
      startTime: source.startTime,
      endDate: length === null ? null : addDays(today, length),
      endTime: source.endTime,
      recurrence: source.recurrence,
      audience: source.audience as Prisma.InputJsonValue,
      images: copyStoredFiles(imagesOf(source)) as unknown as Prisma.InputJsonValue,
      attachments: copyStoredFiles(attachmentsOf(source)) as unknown as Prisma.InputJsonValue,
      paused: true,
      createdById: userId,
    },
  });
  // Paused: the copy is a draft until the admin reviews the dates and resumes it.
  return getAdmin(row.id);
}

export async function setPaused(id: string, paused: boolean, userId: string): Promise<AnnouncementAdminDTO> {
  await findLive(id);
  await prisma.announcement.update({ where: { id }, data: { paused, updatedById: userId } });
  realtimeEvents.announcementsChanged();
  return getAdmin(id);
}

/** "Encerrar agora": it ends at this minute on the clock of whoever clicked; a pop-up already open still waits for its "ciente". */
export async function endNow(id: string, userId: string, tz = DEFAULT_TZ): Promise<AnnouncementAdminDTO> {
  const row = await findLive(id);
  const now = nowKey(tz);
  if (!hasStarted(row, now)) throw Errors.badRequest("Este aviso ainda não começou.");
  if (hasEnded(row, now)) throw Errors.badRequest("Este aviso já terminou.");
  await prisma.announcement.update({ where: { id }, data: { endDate: now.slice(0, 10), endTime: now.slice(11), updatedById: userId } });
  realtimeEvents.announcementsChanged();
  return getAdmin(id, tz);
}

export async function moveToTrash(id: string, userId: string): Promise<void> {
  await findLive(id);
  await prisma.announcement.update({ where: { id }, data: { deletedAt: new Date(), deletedById: userId } });
  realtimeEvents.announcementsChanged();
}

export async function listTrash(tz = DEFAULT_TZ): Promise<(AnnouncementAdminDTO & { purgeOn: string })[]> {
  const { trashDays } = await getBoardSettings();
  const rows = await prisma.announcement.findMany({ where: { deletedAt: { not: null } }, orderBy: { deletedAt: "desc" } });
  const dtos = await toAdminDTOs(rows, tz);
  return dtos.map((d) => ({ ...d, purgeOn: new Date(Date.parse(d.deletedAt!) + trashDays * 86_400_000).toISOString() }));
}

export async function restore(id: string, userId: string): Promise<AnnouncementAdminDTO> {
  const row = await prisma.announcement.findFirst({ where: { id, deletedAt: { not: null } } });
  if (!row) throw Errors.notFound("Aviso não encontrado na Lixeira");
  await prisma.announcement.update({ where: { id }, data: { deletedAt: null, deletedById: null, updatedById: userId } });
  realtimeEvents.announcementsChanged();
  return getAdmin(id);
}

export async function purge(id: string): Promise<void> {
  const row = await prisma.announcement.findFirst({ where: { id, deletedAt: { not: null } } });
  if (!row) throw Errors.notFound("Aviso não encontrado na Lixeira");
  await prisma.announcement.delete({ where: { id } });
  removeStoredFiles([...imagesOf(row), ...attachmentsOf(row)]);
}

/** Daily: removes for good what has been in the Lixeira longer than its configured days. */
export async function purgeExpiredTrash(now = new Date()): Promise<number> {
  const { trashDays } = await getBoardSettings();
  const cutoff = new Date(now.getTime() - trashDays * 86_400_000);
  const rows = await prisma.announcement.findMany({ where: { deletedAt: { lt: cutoff } } });
  for (const row of rows) {
    await prisma.announcement.delete({ where: { id: row.id } });
    removeStoredFiles([...imagesOf(row), ...attachmentsOf(row)]);
  }
  return rows.length;
}

// ---------------------------------------------------------------- receiving

async function visibleRows(user: AudienceUser): Promise<Announcement[]> {
  const rows = await prisma.announcement.findMany({ where: { deletedAt: null, paused: false }, orderBy: [{ pinned: "desc" }, { startDate: "desc" }, { createdAt: "desc" }] });
  return rows.filter((a) => inAudience(user, a.audience));
}

async function toViewerDTOs(rows: Announcement[], userId: string, now: string): Promise<AnnouncementDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [names, receipts, reactions] = await Promise.all([
    authorNames(rows.map((r) => r.createdById)),
    prisma.announcementReceipt.findMany({ where: { announcementId: { in: ids }, userId } }),
    reactionsFor(ids, userId),
  ]);
  return rows.map((a) => {
    const receipt = receipts.find((r) => r.announcementId === a.id);
    return baseDTO(a, now, { authorName: names.get(a.createdById) ?? null, readAt: receipt?.readAt ?? null, ackAt: receipt?.ackAt ?? null, reactions: reactions.get(a.id) ?? [] });
  });
}

/** Comunicados: what shows today, then the ones that ended in the last BOARD_HISTORY_DAYS ("Anteriores"). */
export async function board(viewer: Viewer, tz = DEFAULT_TZ): Promise<{ settings: AnnouncementBoardSettingsDTO; items: AnnouncementDTO[]; unread: number }> {
  const user = await viewerUser(viewer.userId);
  const now = nowKey(tz);
  const historyFrom = addDays(now.slice(0, 10), -BOARD_HISTORY_DAYS);
  const rows = (await visibleRows(user)).filter((a) => hasStarted(a, now) && !(hasEnded(a, now) && (a.endDate ?? a.startDate) < historyFrom));
  const items = await toViewerDTOs(rows, user.id, now);
  return { settings: await getBoardSettings(), items, unread: items.filter((i) => i.showsToday && !i.readAt).length };
}

export async function unreadCount(viewer: Viewer, tz = DEFAULT_TZ): Promise<number> {
  return (await board(viewer, tz)).unread;
}

/**
 * The pop-ups due for this login session: notices showing now, as pop-up, that this person has not yet seen in this
 * session — so every login, until they confirm "Li e estou ciente" or the notice ends. A reminder from "Lembrar
 * pendentes" brings one back once more. Each showing is still counted (see markShown).
 */
export async function pending(viewer: Viewer, tz = DEFAULT_TZ): Promise<AnnouncementDTO[]> {
  const user = await viewerUser(viewer.userId);
  const now = nowKey(tz);
  const today = now.slice(0, 10);
  const rows = (await visibleRows(user)).filter((a) => a.display === "POPUP_AND_BOARD" && showsNow(a, now));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [deliveries, receipts] = await Promise.all([
    prisma.announcementDelivery.findMany({ where: { announcementId: { in: ids }, userId: user.id, day: today } }),
    prisma.announcementReceipt.findMany({ where: { announcementId: { in: ids }, userId: user.id } }),
  ]);
  const due = rows.filter((a) => {
    const receipt = receipts.find((r) => r.announcementId === a.id);
    if (a.requireAck && receipt?.ackAt) return false;
    const delivery = deliveries.find((d) => d.announcementId === a.id);
    const reminded = receipt?.remindedAt && (!delivery || receipt.remindedAt > delivery.lastShownAt);
    if (reminded) return true;
    if (!delivery) return true;
    return !viewer.sessionId || !delivery.sessionIds.includes(viewer.sessionId);
  });
  // Urgent first, then those that need a "ciente", then the newest.
  const weight = (a: Announcement) => (a.kind === "URGENT" ? 0 : a.requireAck ? 1 : 2);
  due.sort((a, b) => weight(a) - weight(b) || b.createdAt.getTime() - a.createdAt.getTime());
  return toViewerDTOs(due, user.id, now);
}

/** The pop-up was shown in this session: counts one of today's showings and marks it as read. */
export async function markShown(ids: string[], viewer: Viewer, tz = DEFAULT_TZ): Promise<void> {
  const today = todayKey(tz);
  const now = new Date();
  for (const announcementId of ids) {
    const existing = await prisma.announcementDelivery.findUnique({ where: { announcementId_userId_day: { announcementId, userId: viewer.userId, day: today } } });
    if (existing && viewer.sessionId && existing.sessionIds.includes(viewer.sessionId)) {
      await prisma.announcementDelivery.update({ where: { id: existing.id }, data: { lastShownAt: now } });
    } else if (existing) {
      await prisma.announcementDelivery.update({
        where: { id: existing.id },
        data: { count: { increment: 1 }, lastShownAt: now, sessionIds: viewer.sessionId ? { push: viewer.sessionId } : undefined },
      });
    } else {
      await prisma.announcementDelivery
        .create({ data: { announcementId, userId: viewer.userId, day: today, count: 1, sessionIds: viewer.sessionId ? [viewer.sessionId] : [], lastShownAt: now } })
        .catch(() => undefined); // two tabs at once: the other one already counted it
    }
    await markRead(announcementId, viewer.userId);
  }
}

export async function markRead(announcementId: string, userId: string): Promise<void> {
  await prisma.announcementReceipt.upsert({
    where: { announcementId_userId: { announcementId, userId } },
    update: {},
    create: { announcementId, userId, readAt: new Date() },
  });
  await prisma.announcementReceipt.updateMany({ where: { announcementId, userId, readAt: null }, data: { readAt: new Date() } });
}

export async function acknowledge(announcementId: string, userId: string): Promise<void> {
  await findLive(announcementId);
  const now = new Date();
  await prisma.announcementReceipt.upsert({
    where: { announcementId_userId: { announcementId, userId } },
    update: { ackAt: now },
    create: { announcementId, userId, readAt: now, ackAt: now },
  });
  await prisma.announcementReceipt.updateMany({ where: { announcementId, userId, readAt: null }, data: { readAt: now } });
  realtimeEvents.announcementReceiptsChanged();
}

export async function toggleReaction(announcementId: string, userId: string, emoji: string): Promise<AnnouncementDTO["reactions"]> {
  if (!(ANNOUNCEMENT_REACTIONS as readonly string[]).includes(emoji)) throw Errors.badRequest("Reação não disponível");
  await findLive(announcementId);
  const existing = await prisma.announcementReaction.findUnique({ where: { announcementId_userId_emoji: { announcementId, userId, emoji } } });
  if (existing) await prisma.announcementReaction.delete({ where: { id: existing.id } });
  else await prisma.announcementReaction.create({ data: { announcementId, userId, emoji } });
  await markRead(announcementId, userId);
  return (await reactionsFor([announcementId], userId)).get(announcementId) ?? [];
}

// ---------------------------------------------------------------- readings

export async function receipts(id: string): Promise<AnnouncementReceiptRowDTO[]> {
  const row = await prisma.announcement.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Aviso não encontrado");
  const users = (await activeUsers()).filter((u) => inAudience(u, row.audience));
  const [rows, deliveries] = await Promise.all([
    prisma.announcementReceipt.findMany({ where: { announcementId: id } }),
    prisma.announcementDelivery.groupBy({ by: ["userId"], where: { announcementId: id }, _sum: { count: true } }),
  ]);
  return users
    .map((u) => {
      const r = rows.find((x) => x.userId === u.id);
      return {
        userId: u.id,
        name: u.displayName,
        role: u.role,
        readAt: r?.readAt?.toISOString() ?? null,
        ackAt: r?.ackAt?.toISOString() ?? null,
        shownCount: deliveries.find((d) => d.userId === u.id)?._sum.count ?? 0,
      };
    })
    .sort((a, b) => Number(Boolean(a.ackAt)) - Number(Boolean(b.ackAt)) || Number(Boolean(a.readAt)) - Number(Boolean(b.readAt)) || a.name.localeCompare(b.name, "pt-BR"));
}

/** "Lembrar pendentes": a notification for whoever hasn't confirmed (or read), and the pop-up comes back once more. */
export async function remindPending(id: string, senderName: string): Promise<number> {
  const row = await findLive(id);
  const pendingRows = (await receipts(id)).filter((r) => (row.requireAck ? !r.ackAt : !r.readAt));
  const now = new Date();
  for (const r of pendingRows) {
    await prisma.announcementReceipt.upsert({
      where: { announcementId_userId: { announcementId: id, userId: r.userId } },
      update: { remindedAt: now },
      create: { announcementId: id, userId: r.userId, remindedAt: now },
    });
    const notification = await createNotification({
      userId: r.userId,
      type: "ANNOUNCEMENT_REMINDER",
      title: row.requireAck ? `Confirme a leitura: ${row.title}` : `Aviso: ${row.title}`,
      body: `${senderName} pediu para você ${row.requireAck ? "ler e confirmar" : "ler"} este aviso.`,
      entityType: "Announcement",
      entityId: id,
    });
    realtimeEvents.notificationCreated(r.userId, toNotificationDTO(notification));
  }
  realtimeEvents.announcementsChanged(pendingRows.map((r) => r.userId));
  return pendingRows.length;
}

// ---------------------------------------------------------------- dashboard

/**
 * Dashboard › Comunicados and the presentation's slide: the notices that showed in the period (from its first to its
 * last day), how many of the people meant to see each one read it and confirmed it, and who still owes a "ciente".
 */
export async function stats(from: Date, to: Date, tz = DEFAULT_TZ): Promise<AnnouncementStatsDTO> {
  const fromDay = todayKey(tz, from);
  const toDay = todayKey(tz, to);
  const rows = (await prisma.announcement.findMany({ where: { deletedAt: null }, orderBy: { startDate: "desc" } })).filter((a) => {
    const first = nextDay(a, fromDay);
    return first !== null && first <= toDay;
  });
  const users = await activeUsers();
  const ids = rows.map((r) => r.id);
  const allReceipts = ids.length ? await prisma.announcementReceipt.findMany({ where: { announcementId: { in: ids } } }) : [];

  let audienceTotal = 0;
  let readTotal = 0;
  let ackAudience = 0;
  let ackTotal = 0;
  const items = rows.map((a) => {
    const audience = users.filter((u) => inAudience(u, a.audience));
    const audienceIds = new Set(audience.map((u) => u.id));
    const mine = allReceipts.filter((r) => r.announcementId === a.id && audienceIds.has(r.userId));
    const read = mine.filter((r) => r.readAt).length;
    const acked = mine.filter((r) => r.ackAt).length;
    audienceTotal += audience.length;
    readTotal += read;
    if (a.requireAck) {
      ackAudience += audience.length;
      ackTotal += acked;
    }
    const ackedIds = new Set(mine.filter((r) => r.ackAt).map((r) => r.userId));
    return {
      id: a.id,
      title: a.title,
      kind: a.kind,
      startDate: a.startDate,
      audience: audience.length,
      read,
      acked,
      requireAck: a.requireAck,
      pendingNames: a.requireAck ? audience.filter((u) => !ackedIds.has(u.id)).map((u) => u.displayName).sort((x, y) => x.localeCompare(y, "pt-BR")) : [],
    };
  });

  const byDay = new Map<string, { reads: number; acks: number }>();
  for (let day = fromDay; day <= toDay && byDay.size < 400; day = addDays(day, 1)) byDay.set(day, { reads: 0, acks: 0 });
  for (const r of allReceipts) {
    if (r.readAt) {
      const slot = byDay.get(todayKey(tz, r.readAt));
      if (slot) slot.reads++;
    }
    if (r.ackAt) {
      const slot = byDay.get(todayKey(tz, r.ackAt));
      if (slot) slot.acks++;
    }
  }

  return {
    published: rows.length,
    audience: audienceTotal,
    readRate: audienceTotal ? Math.round((readTotal / audienceTotal) * 100) : null,
    ackRate: ackAudience ? Math.round((ackTotal / ackAudience) * 100) : null,
    items,
    readsByDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })),
  };
}
