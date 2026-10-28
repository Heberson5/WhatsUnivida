import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { toPauseReasonDTO } from "./pause-reasons.mapper";
import * as service from "./pause-reasons.service";

export const pauseReasonsRouter = Router();
pauseReasonsRouter.use(requireAuth);

// Read-only, active reasons only — powers the pause picker in the profile
// menu. No permission beyond being logged in: pausing yourself is personal,
// same reasoning as quick-replies' conversation-scoped GET (using the list
// is not the same privilege as curating it).
pauseReasonsRouter.get(
  "/active",
  asyncHandler(async (_req, res) => {
    const rows = await service.listActivePauseReasons();
    res.json(rows.map(toPauseReasonDTO));
  })
);

pauseReasonsRouter.get(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_MOTIVO_PAUSA_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    const rows = await service.listPauseReasons();
    res.json(rows.map(toPauseReasonDTO));
  })
);

const nameSchema = z.object({ name: z.string().min(1).max(60) });

pauseReasonsRouter.post(
  "/",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_MOTIVO_PAUSA_ADICIONAR),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);
    const reason = await service.createPauseReason(name);
    await writeAudit({ userId: req.auth!.userId, action: "PAUSE_REASON_CREATED", entity: "PauseReason", entityId: reason.id, ipAddress: req.ip ?? null, metadata: { name } });
    res.status(201).json(toPauseReasonDTO(reason));
  })
);

pauseReasonsRouter.patch(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_MOTIVO_PAUSA_EDITAR),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);
    const reason = await service.updatePauseReason(req.params.id, name);
    await writeAudit({ userId: req.auth!.userId, action: "PAUSE_REASON_UPDATED", entity: "PauseReason", entityId: reason.id, ipAddress: req.ip ?? null, metadata: { name } });
    res.json(toPauseReasonDTO(reason));
  })
);

pauseReasonsRouter.delete(
  "/:id",
  requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR),
  requirePermission(PERMISSION.RESPOSTAS_MOTIVO_PAUSA_EXCLUIR),
  asyncHandler(async (req, res) => {
    await service.deactivatePauseReason(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "PAUSE_REASON_DEACTIVATED", entity: "PauseReason", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);
