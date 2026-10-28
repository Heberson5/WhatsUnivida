import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { realtimeEvents } from "../../realtime/realtime";
import * as service from "./goals.service";

export const goalsRouter = Router();
goalsRouter.use(requireAuth, requirePermission(PERMISSION.CONFIGURACOES_FILA_VISUALIZAR));
const requireEdit = requirePermission(PERMISSION.CONFIGURACOES_FILA_EDITAR);

const goalSchema = z
  .object({
    type: z.enum(["CLOSED_PER_DAY", "AVG_FIRST_RESPONSE", "NPS"]),
    target: z.number().int(),
    active: z.boolean().default(true),
    scope: z.enum(["ALL", "CONNECTIONS", "AGENTS"]).default("ALL"),
    connectionIds: z.array(z.string().uuid()).default([]),
    agentIds: z.array(z.string().uuid()).default([]),
  })
  .strict()
  .refine((g) => (g.type === "NPS" ? g.target >= -100 && g.target <= 100 : g.target >= 1 && g.target <= 1000), { message: "Valor da meta fora do permitido" })
  .refine((g) => g.scope !== "CONNECTIONS" || g.connectionIds.length > 0, { message: "Escolha ao menos uma conexão" })
  .refine((g) => g.scope !== "AGENTS" || g.agentIds.length > 0, { message: "Escolha ao menos um atendente" });

goalsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await service.listGoals());
  })
);

goalsRouter.post(
  "/",
  requireEdit,
  asyncHandler(async (req, res) => {
    const goal = await service.createGoal(goalSchema.parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "GOAL_CREATED", entity: "Goal", entityId: goal.id, ipAddress: req.ip ?? null, metadata: { ...goal } });
    realtimeEvents.goalsChanged();
    res.status(201).json(goal);
  })
);

goalsRouter.put(
  "/:id",
  requireEdit,
  asyncHandler(async (req, res) => {
    const goal = await service.updateGoal(req.params.id, goalSchema.parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "GOAL_UPDATED", entity: "Goal", entityId: goal.id, ipAddress: req.ip ?? null, metadata: { ...goal } });
    realtimeEvents.goalsChanged();
    res.json(goal);
  })
);

goalsRouter.delete(
  "/:id",
  requireEdit,
  asyncHandler(async (req, res) => {
    await service.deleteGoal(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "GOAL_DELETED", entity: "Goal", entityId: req.params.id, ipAddress: req.ip ?? null });
    realtimeEvents.goalsChanged();
    res.status(204).end();
  })
);
