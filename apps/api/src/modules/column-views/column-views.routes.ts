import { Router } from "express";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import * as service from "./column-views.service";

export const columnViewsRouter = Router();

columnViewsRouter.use(requireAuth);

// The ⋮ menu of every table — any signed-in user manages their own view.
columnViewsRouter.get(
  "/effective",
  asyncHandler(async (req, res) => {
    res.json(await service.getEffectiveViews(req.auth!.userId));
  })
);

columnViewsRouter.put(
  "/mine/:screen",
  asyncHandler(async (req, res) => {
    const screen = service.screenSchema.parse(req.params.screen);
    res.json(await service.saveOwnView(req.auth!.userId, screen, service.saveOwnSchema.parse(req.body)));
  })
);

columnViewsRouter.delete(
  "/mine/:screen",
  asyncHandler(async (req, res) => {
    await service.deleteOwnView(req.auth!.userId, service.screenSchema.parse(req.params.screen));
    res.status(204).end();
  })
);

// Configurações › Visões de colunas.
columnViewsRouter.get(
  "/",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_VISOES_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json(await service.listViews());
  })
);

columnViewsRouter.patch(
  "/:id",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_VISOES_EDITAR),
  asyncHandler(async (req, res) => {
    const view = await service.updateView(req.params.id, service.updateViewSchema.parse(req.body));
    await writeAudit({
      userId: req.auth!.userId,
      action: "COLUMN_VIEW_UPDATED",
      entity: "ColumnView",
      entityId: view.id,
      ipAddress: req.ip ?? null,
      metadata: { name: view.name, screen: view.screen, owner: view.ownerName, shareAll: view.shareAll, sharedWith: view.sharedWith.map((u) => u.name) },
    });
    res.json(view);
  })
);

columnViewsRouter.delete(
  "/:id",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_VISOES_EDITAR),
  asyncHandler(async (req, res) => {
    const view = await service.deleteView(req.params.id);
    await writeAudit({
      userId: req.auth!.userId,
      action: "COLUMN_VIEW_DELETED",
      entity: "ColumnView",
      entityId: view.id,
      ipAddress: req.ip ?? null,
      metadata: { name: view.name, screen: view.screen, owner: view.ownerName },
    });
    res.status(204).end();
  })
);
