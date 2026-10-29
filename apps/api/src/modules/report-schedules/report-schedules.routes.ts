import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import * as service from "./report-schedules.service";

/** Configurações › Modelos de e-mail › Agendamento da apresentação. */
export const reportSchedulesRouter = Router();
reportSchedulesRouter.use(requireAuth, requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR));

const canView = requirePermission(PERMISSION.CONFIGURACOES_AGENDAMENTO_VISUALIZAR);
const canEdit = requirePermission(PERMISSION.CONFIGURACOES_AGENDAMENTO_EDITAR);
// Building a deck reads the whole Dashboard: a few per minute is plenty.
const deckLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida");
const email = z.string().trim().email("E-mail inválido");
const phone = z.string().trim().min(8, "Número inválido");

const inputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome ao agendamento").max(80),
  enabled: z.boolean(),
  subject: z.string().trim().min(1, "Informe o assunto").max(200),
  title: z.string().trim().min(1, "Informe o título").max(200),
  bodyText: z.string().trim().min(1, "Escreva o texto do e-mail").max(5000),
  to: z.array(email).min(1, "Informe pelo menos um destinatário").max(50),
  cc: z.array(email).max(50).default([]),
  frequency: z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "YEARLY", "CUSTOM"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido"),
  tzOffsetMinutes: z.number().int().min(-840).max(840),
  startDate: day,
  weekdays: z.array(z.number().int().min(0).max(6)).default([]),
  monthDay: z.number().int().min(1).max(31).nullable().default(null),
  month: z.number().int().min(1).max(12).nullable().default(null),
  customInterval: z.number().int().min(1).max(365).default(1),
  customUnit: z.enum(["DAY", "WEEK", "MONTH"]).default("DAY"),
  endType: z.enum(["NEVER", "AFTER", "ON_DATE"]).default("NEVER"),
  endAfter: z.number().int().min(1).max(10000).nullable().default(null),
  endDate: day.nullable().default(null),
  skipSaturday: z.boolean().default(false),
  skipSunday: z.boolean().default(false),
  period: z.enum(["AUTO", "yesterday", "last7days", "last15days", "lastMonth", "month", "lastYear", "year", "all"]).default("AUTO"),
  agentId: z.string().uuid().nullable().default(null),
  connectionIds: z.array(z.string()).default([]),
  alerts: z
    .object({
      emails: z.array(email).max(20).default([]),
      whatsapp: z.object({ connectionId: z.string().min(1), phones: z.array(phone).max(10) }).nullable().default(null),
      sms: z.object({ phones: z.array(phone).max(10) }).nullable().default(null),
    })
    .default({ emails: [], whatsapp: null, sms: null }),
});

const audit = (req: import("express").Request, action: string, entityId: string, metadata?: Record<string, unknown>) =>
  writeAudit({ userId: req.auth!.userId, action, entity: "ReportSchedule", entityId, ipAddress: req.ip ?? null, metadata });

reportSchedulesRouter.get(
  "/",
  canView,
  asyncHandler(async (_req, res) => {
    res.json({ schedules: await service.list(), defaults: service.DEFAULT_SCHEDULE_TEXT, tags: service.SCHEDULE_TAGS });
  })
);

reportSchedulesRouter.post(
  "/check",
  canEdit,
  asyncHandler(async (req, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : null;
    res.json(await service.check(inputSchema.parse(req.body ?? {}), id));
  })
);

reportSchedulesRouter.post(
  "/email-preview",
  canView,
  asyncHandler(async (req, res) => {
    const body = z.object({ subject: z.string().max(200).default(""), title: z.string().max(200).default(""), bodyText: z.string().max(5000).default("") }).parse(req.body ?? {});
    res.json(await service.emailPreview(body.subject, body.title, body.bodyText));
  })
);

reportSchedulesRouter.post(
  "/preview",
  canEdit,
  deckLimiter,
  asyncHandler(async (req, res) => {
    const input = inputSchema
      .pick({ frequency: true, customInterval: true, customUnit: true, period: true, agentId: true, connectionIds: true, tzOffsetMinutes: true })
      .parse(req.body ?? {});
    const deck = await service.preview(input, req.auth!.userId);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${deck.fileName}"`);
    res.send(deck.buffer);
  })
);

reportSchedulesRouter.post(
  "/",
  canEdit,
  asyncHandler(async (req, res) => {
    const result = await service.create(inputSchema.parse(req.body ?? {}), req.auth!.userId);
    await audit(req, "REPORT_SCHEDULE_CREATED", result.schedule.id, { name: result.schedule.name });
    res.status(201).json(result);
  })
);

reportSchedulesRouter.get(
  "/:id/runs",
  canView,
  asyncHandler(async (req, res) => {
    res.json(await service.runs(req.params.id));
  })
);

reportSchedulesRouter.put(
  "/:id",
  canEdit,
  asyncHandler(async (req, res) => {
    const result = await service.update(req.params.id, inputSchema.parse(req.body ?? {}), req.auth!.userId);
    await audit(req, "REPORT_SCHEDULE_UPDATED", result.schedule.id, { name: result.schedule.name });
    res.json(result);
  })
);

reportSchedulesRouter.post(
  "/:id/enabled",
  canEdit,
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const schedule = await service.setEnabled(req.params.id, enabled, req.auth!.userId);
    await audit(req, enabled ? "REPORT_SCHEDULE_ENABLED" : "REPORT_SCHEDULE_DISABLED", schedule.id);
    res.json(schedule);
  })
);

reportSchedulesRouter.post(
  "/:id/duplicate",
  canEdit,
  asyncHandler(async (req, res) => {
    const copy = await service.duplicate(req.params.id, req.auth!.userId);
    await audit(req, "REPORT_SCHEDULE_DUPLICATED", copy.id, { from: req.params.id });
    res.status(201).json(copy);
  })
);

reportSchedulesRouter.post(
  "/:id/send-now",
  canEdit,
  deckLimiter,
  asyncHandler(async (req, res) => {
    const run = await service.sendNow(req.params.id).finally(() => audit(req, "REPORT_SCHEDULE_SENT_NOW", req.params.id));
    res.json(run);
  })
);

reportSchedulesRouter.delete(
  "/:id",
  canEdit,
  asyncHandler(async (req, res) => {
    await service.remove(req.params.id);
    await audit(req, "REPORT_SCHEDULE_DELETED", req.params.id);
    res.status(204).end();
  })
);
