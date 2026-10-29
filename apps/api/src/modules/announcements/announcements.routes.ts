import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { ANNOUNCEMENT_KIND_LABEL, PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { getExportBranding } from "../settings/settings.service";
import { toPdf, toXlsx } from "../reports/reports.service";
import * as service from "./announcements.service";

/** Pop Up › Avisos (managing notices) and Comunicados (receiving them). */
export const announcementsRouter = Router();
announcementsRouter.use(requireAuth);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida");
const tzSchema = z.coerce.number().int().min(-840).max(840).default(240);
const tzOf = (value: unknown) => tzSchema.parse(value ?? undefined);

const inputSchema = z.object({
  title: z.string().trim().min(1, "Informe o título").max(160),
  body: z.string().max(5000).default(""),
  kind: z.enum(["INFO", "IMPORTANT", "URGENT", "CELEBRATION", "NEWS"]),
  layout: z.enum(["COVER", "POSTER", "TEXT"]),
  display: z.enum(["POPUP_AND_BOARD", "BOARD_ONLY"]),
  category: z.string().trim().max(40).nullable().default(null),
  requireAck: z.boolean().default(false),
  pinned: z.boolean().default(false),
  linkUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "O link precisa começar com http:// ou https://")
    .nullable()
    .default(null),
  linkLabel: z.string().trim().max(40).nullable().default(null),
  startDate: day,
  endDate: day.nullable().default(null),
  recurrence: z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY"]),
  audience: z.object({
    all: z.boolean(),
    roles: z.array(z.enum(["ADMIN", "MANAGER", "AGENT"])).default([]),
    connectionIds: z.array(z.string()).default([]),
    userIds: z.array(z.string()).default([]),
  }),
});

/** The person and their login — the same through every token renewal, so each login counts once (see RefreshToken.loginId). */
async function viewer(req: import("express").Request): Promise<service.Viewer> {
  const sid = req.auth!.sessionId;
  const row = sid ? await prisma.refreshToken.findUnique({ where: { id: sid }, select: { id: true, loginId: true } }) : null;
  return { userId: req.auth!.userId, role: req.auth!.role, sessionId: row ? (row.loginId ?? row.id) : sid };
}
const audit = (req: import("express").Request, action: string, entityId: string, metadata?: Record<string, unknown>) =>
  writeAudit({ userId: req.auth!.userId, action, entity: "Announcement", entityId, ipAddress: req.ip ?? null, metadata });

// ------------------------------------------------------------ receiving

const canReceive = requirePermission(PERMISSION.COMUNICADOS_VER);

announcementsRouter.get(
  "/board",
  canReceive,
  asyncHandler(async (req, res) => {
    res.json(await service.board(await viewer(req), tzOf(req.query.tz)));
  })
);

announcementsRouter.get(
  "/pending",
  canReceive,
  asyncHandler(async (req, res) => {
    res.json(await service.pending(await viewer(req), tzOf(req.query.tz)));
  })
);

announcementsRouter.post(
  "/shown",
  canReceive,
  asyncHandler(async (req, res) => {
    const body = z.object({ ids: z.array(z.string()).max(50), tz: tzSchema }).parse(req.body ?? {});
    await service.markShown(body.ids, await viewer(req), body.tz);
    res.status(204).end();
  })
);

announcementsRouter.post(
  "/:id/read",
  canReceive,
  asyncHandler(async (req, res) => {
    await service.markRead(req.params.id, req.auth!.userId);
    res.status(204).end();
  })
);

announcementsRouter.post(
  "/:id/ack",
  canReceive,
  asyncHandler(async (req, res) => {
    await service.acknowledge(req.params.id, req.auth!.userId);
    res.status(204).end();
  })
);

announcementsRouter.post(
  "/:id/reactions",
  canReceive,
  asyncHandler(async (req, res) => {
    const { emoji } = z.object({ emoji: z.string().min(1).max(8) }).parse(req.body ?? {});
    res.json(await service.toggleReaction(req.params.id, req.auth!.userId, emoji));
  })
);

// ------------------------------------------------------------ Pop Up › Avisos

const popup = requirePermission(PERMISSION.POPUP_ACESSAR);
const canView = [popup, requirePermission(PERMISSION.POPUP_AVISOS_VISUALIZAR)];
const canAdd = [popup, requirePermission(PERMISSION.POPUP_AVISOS_ADICIONAR)];
const canEdit = [popup, requirePermission(PERMISSION.POPUP_AVISOS_EDITAR)];
const canDelete = [popup, requirePermission(PERMISSION.POPUP_AVISOS_EXCLUIR)];
const canTrash = [popup, requirePermission(PERMISSION.POPUP_LIXEIRA_GERENCIAR)];

announcementsRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await service.getBoardSettings());
  })
);

announcementsRouter.patch(
  "/settings",
  ...canEdit,
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1, "Informe o nome").max(40) }).parse(req.body ?? {});
    const settings = await service.updateBoardSettings({ name });
    await writeAudit({ userId: req.auth!.userId, action: "ANNOUNCEMENT_BOARD_RENAMED", entity: "SystemSetting", entityId: "announcementBoard", ipAddress: req.ip ?? null, metadata: { name } });
    res.json(settings);
  })
);

announcementsRouter.get(
  "/admin",
  ...canView,
  asyncHandler(async (req, res) => {
    res.json(await service.listAdmin(tzOf(req.query.tz)));
  })
);

announcementsRouter.post(
  "/admin",
  ...canAdd,
  asyncHandler(async (req, res) => {
    const created = await service.create(inputSchema.parse(req.body ?? {}), req.auth!.userId);
    await audit(req, "ANNOUNCEMENT_CREATED", created.id, { title: created.title });
    res.status(201).json(created);
  })
);

announcementsRouter.patch(
  "/admin/:id",
  ...canEdit,
  asyncHandler(async (req, res) => {
    const updated = await service.update(req.params.id, inputSchema.parse(req.body ?? {}), req.auth!.userId);
    await audit(req, "ANNOUNCEMENT_UPDATED", updated.id, { title: updated.title });
    res.json(updated);
  })
);

announcementsRouter.post(
  "/admin/:id/duplicate",
  ...canAdd,
  asyncHandler(async (req, res) => {
    const copy = await service.duplicate(req.params.id, req.auth!.userId, tzOf(req.body?.tz));
    await audit(req, "ANNOUNCEMENT_DUPLICATED", copy.id, { from: req.params.id });
    res.status(201).json(copy);
  })
);

announcementsRouter.post(
  "/admin/:id/pause",
  ...canEdit,
  asyncHandler(async (req, res) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body ?? {});
    const updated = await service.setPaused(req.params.id, paused, req.auth!.userId);
    await audit(req, paused ? "ANNOUNCEMENT_PAUSED" : "ANNOUNCEMENT_RESUMED", updated.id);
    res.json(updated);
  })
);

announcementsRouter.delete(
  "/admin/:id",
  ...canDelete,
  asyncHandler(async (req, res) => {
    await service.moveToTrash(req.params.id, req.auth!.userId);
    await audit(req, "ANNOUNCEMENT_TRASHED", req.params.id);
    res.status(204).end();
  })
);

const filePermission = (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  // Adding files belongs to whoever is writing the notice: a new one (adicionar) or an existing one (editar).
  const editor = requirePermission(PERMISSION.POPUP_AVISOS_EDITAR);
  const creator = requirePermission(PERMISSION.POPUP_AVISOS_ADICIONAR);
  editor(req, res, (err?: unknown) => (err ? creator(req, res, next) : next()));
};

announcementsRouter.post(
  "/admin/:id/files",
  popup,
  filePermission,
  service.announcementFileUpload.single("file"),
  asyncHandler(async (req, res) => {
    res.json(await service.addFile(req.params.id, req.file, req.auth!.userId));
  })
);

announcementsRouter.delete(
  "/admin/:id/files/:storageKey",
  popup,
  filePermission,
  asyncHandler(async (req, res) => {
    res.json(await service.removeFile(req.params.id, req.params.storageKey, req.auth!.userId));
  })
);

announcementsRouter.post(
  "/admin/:id/files/:storageKey/cover",
  popup,
  filePermission,
  asyncHandler(async (req, res) => {
    res.json(await service.moveImageFirst(req.params.id, req.params.storageKey, req.auth!.userId));
  })
);

function formatDateTime(iso: string | null, tz: number): string {
  if (!iso) return "—";
  const local = new Date(Date.parse(iso) - tz * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(local.getUTCDate())}/${p(local.getUTCMonth() + 1)}/${local.getUTCFullYear()} ${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`;
}

const ROLE_LABEL = { ADMIN: "Administrador", MANAGER: "Gestor", AGENT: "Atendente" } as const;

/** Who read and who confirmed — on screen, or as the Excel/PDF "comprovante" of the confirmations. */
announcementsRouter.get(
  "/admin/:id/receipts",
  ...canView,
  asyncHandler(async (req, res) => {
    const { format, tz } = z.object({ format: z.enum(["json", "xlsx", "pdf"]).default("json"), tz: tzSchema }).parse(req.query);
    const rows = await service.receipts(req.params.id);
    if (format === "json") return res.json(rows);
    const announcement = await service.getAdmin(req.params.id, tz);
    const table = rows.map((r) => ({
      Nome: r.name,
      Perfil: ROLE_LABEL[r.role],
      "Leu em": formatDateTime(r.readAt, tz),
      ...(announcement.requireAck ? { "Confirmou (ciente) em": formatDateTime(r.ackAt, tz) } : {}),
      "Vezes que apareceu": r.shownCount,
    }));
    const branding = await getExportBranding();
    const reportBranding = {
      companyName: branding.companyName,
      primaryColor: branding.primaryColor,
      logoPath: branding.logoUrl ? path.join(env.UPLOAD_DIR, "branding", path.basename(branding.logoUrl)) : null,
    };
    const title = `Comprovante de leitura — ${announcement.title} (${ANNOUNCEMENT_KIND_LABEL[announcement.kind]})`;
    const base = `comprovante-aviso-${announcement.startDate}`;
    await audit(req, "ANNOUNCEMENT_RECEIPTS_EXPORTED", announcement.id, { format });
    if (format === "xlsx") {
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
      return res.send(await toXlsx(table, "Comprovante", reportBranding));
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
    res.send(await toPdf(table, title, tz, reportBranding));
  })
);

announcementsRouter.post(
  "/admin/:id/remind",
  ...canEdit,
  asyncHandler(async (req, res) => {
    const count = await service.remindPending(req.params.id, req.auth!.displayName);
    await audit(req, "ANNOUNCEMENT_REMINDED", req.params.id, { count });
    res.json({ count });
  })
);

// ------------------------------------------------------------ Pop Up › Lixeira

announcementsRouter.get(
  "/trash",
  ...canTrash,
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listTrash(tzOf(req.query.tz)), settings: await service.getBoardSettings() });
  })
);

announcementsRouter.patch(
  "/trash/settings",
  ...canTrash,
  asyncHandler(async (req, res) => {
    const { trashDays } = z.object({ trashDays: z.coerce.number().int().min(1, "Mínimo de 1 dia").max(365, "Máximo de 365 dias") }).parse(req.body ?? {});
    const settings = await service.updateBoardSettings({ trashDays });
    await writeAudit({ userId: req.auth!.userId, action: "ANNOUNCEMENT_TRASH_DAYS_CHANGED", entity: "SystemSetting", entityId: "announcementBoard", ipAddress: req.ip ?? null, metadata: { trashDays } });
    res.json(settings);
  })
);

announcementsRouter.post(
  "/trash/:id/restore",
  ...canTrash,
  asyncHandler(async (req, res) => {
    const restored = await service.restore(req.params.id, req.auth!.userId);
    await audit(req, "ANNOUNCEMENT_RESTORED", restored.id);
    res.json(restored);
  })
);

announcementsRouter.delete(
  "/trash/:id",
  ...canTrash,
  asyncHandler(async (req, res) => {
    await service.purge(req.params.id);
    await audit(req, "ANNOUNCEMENT_PURGED", req.params.id);
    res.status(204).end();
  })
);

// Last, so "/admin" and "/trash" above never match it.
announcementsRouter.get(
  "/admin/:id",
  ...canView,
  asyncHandler(async (req, res) => {
    res.json(await service.getAdmin(req.params.id, tzOf(req.query.tz)));
  })
);
