import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import * as service from "./work-schedules.service";

export const workSchedulesRouter = Router();

workSchedulesRouter.use(requireAuth);

// Names only — the pickers in Conexões and in the Fluxo's hours node, whose users don't necessarily see the Respostas menu.
workSchedulesRouter.get(
  "/options",
  asyncHandler(async (_req, res) => {
    res.json(await service.listWorkScheduleOptions());
  })
);

workSchedulesRouter.use(requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR));

workSchedulesRouter.get(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_EXPEDIENTE_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json(await service.listWorkSchedules());
  })
);

const holidaysQuerySchema = z.object({ state: z.string().length(2).toUpperCase(), city: z.string().trim().min(1) });

workSchedulesRouter.get(
  "/holidays",
  requirePermission(PERMISSION.RESPOSTAS_EXPEDIENTE_VISUALIZAR),
  asyncHandler(async (req, res) => {
    const { state, city } = holidaysQuerySchema.parse(req.query);
    res.json(await service.listApplicableHolidays(state, city));
  })
);

workSchedulesRouter.post(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_EXPEDIENTE_ADICIONAR),
  asyncHandler(async (req, res) => {
    const input = service.workScheduleSchema.parse(req.body);
    const row = await service.createWorkSchedule(input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "WORK_SCHEDULE_CREATED",
      entity: "WorkSchedule",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { name: input.name, state: input.state, city: input.city },
    });
    res.status(201).json(row);
  })
);

workSchedulesRouter.patch(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_EXPEDIENTE_EDITAR),
  asyncHandler(async (req, res) => {
    const input = service.workScheduleSchema.partial().parse(req.body);
    const row = await service.updateWorkSchedule(req.params.id, input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "WORK_SCHEDULE_UPDATED",
      entity: "WorkSchedule",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { name: row.name, fields: Object.keys(input) },
    });
    res.json(row);
  })
);

workSchedulesRouter.delete(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_EXPEDIENTE_EXCLUIR),
  asyncHandler(async (req, res) => {
    await service.deleteWorkSchedule(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "WORK_SCHEDULE_DELETED", entity: "WorkSchedule", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);
