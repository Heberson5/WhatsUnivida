import { Router, type Request } from "express";
import { z } from "zod";
import type { AutoMessageTrigger } from "@prisma/client";
import { PERMISSION, type Permission } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { isPermissionAllowed, requirePermission } from "../../lib/permissions";
import { Errors } from "../../lib/http-error";
import { writeAudit } from "../../lib/audit";
import { connectionScopeSchema } from "../../lib/connection-scope";
import { toAutoMessageTemplateDTO } from "./auto-message-templates.mapper";
import * as service from "./auto-message-templates.service";

export const autoMessageTemplatesRouter = Router();

autoMessageTemplatesRouter.use(requireAuth);
// Same audience as respostas rápidas/encerramento — see PROMPT: "O menu de
// Respostas, deverá estar habilitado nas permissões para o administrador e
// gestor." Still just the umbrella: which specific trigger (Transferência
// vs Aceite) a role can actually edit is checked per-route below, against
// the trigger the row itself belongs to — see PROMPT: "Mapeie todos os
// menus e o que tem dentro dos menus e inclua nas permissões".
autoMessageTemplatesRouter.use(requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR));

type Action = "visualizar" | "adicionar" | "editar" | "excluir";

const TRIGGER_PERMISSION: Record<AutoMessageTrigger, Record<Action, Permission>> = {
  TRANSFER: {
    visualizar: PERMISSION.RESPOSTAS_TRANSFERENCIA_VISUALIZAR,
    adicionar: PERMISSION.RESPOSTAS_TRANSFERENCIA_ADICIONAR,
    editar: PERMISSION.RESPOSTAS_TRANSFERENCIA_EDITAR,
    excluir: PERMISSION.RESPOSTAS_TRANSFERENCIA_EXCLUIR,
  },
  ACCEPT: {
    visualizar: PERMISSION.RESPOSTAS_ACEITE_VISUALIZAR,
    adicionar: PERMISSION.RESPOSTAS_ACEITE_ADICIONAR,
    editar: PERMISSION.RESPOSTAS_ACEITE_EDITAR,
    excluir: PERMISSION.RESPOSTAS_ACEITE_EXCLUIR,
  },
};

async function requireTriggerPermission(req: Request, trigger: AutoMessageTrigger, action: Action): Promise<void> {
  if (!(await isPermissionAllowed(req.auth!.role, TRIGGER_PERMISSION[trigger][action]))) {
    throw Errors.forbidden();
  }
}

const triggerQuerySchema = z.object({ trigger: z.enum(["TRANSFER", "ACCEPT"]) });

autoMessageTemplatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { trigger } = triggerQuerySchema.parse(req.query);
    await requireTriggerPermission(req, trigger, "visualizar");
    const rows = await service.listAutoMessageTemplates(trigger);
    res.json(rows.map(toAutoMessageTemplateDTO));
  })
);

const bodySchema = z.object({
  trigger: z.enum(["TRANSFER", "ACCEPT"]),
  name: z.string().min(1).max(120),
  text: z.string().min(1).max(4096),
  active: z.boolean(),
  showSenderName: z.boolean().default(true),
  connectionScope: connectionScopeSchema,
  userScope: service.userScopeSchema.optional(),
});

autoMessageTemplatesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = bodySchema.parse(req.body);
    await requireTriggerPermission(req, input.trigger, "adicionar");
    const row = await service.createAutoMessageTemplate(input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "AUTO_MESSAGE_TEMPLATE_CREATED",
      entity: "AutoMessageTemplate",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: { trigger: input.trigger, name: input.name, active: input.active, connectionScope: input.connectionScope, userScope: input.userScope },
    });
    res.status(201).json(toAutoMessageTemplateDTO(row));
  })
);

const updateSchema = bodySchema.partial();

autoMessageTemplatesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await service.getAutoMessageTemplate(req.params.id);
    await requireTriggerPermission(req, existing.trigger, "editar");
    const input = updateSchema.parse(req.body);
    const row = await service.updateAutoMessageTemplate(req.params.id, input);
    await writeAudit({
      userId: req.auth!.userId,
      action: "AUTO_MESSAGE_TEMPLATE_UPDATED",
      entity: "AutoMessageTemplate",
      entityId: row.id,
      ipAddress: req.ip ?? null,
      metadata: input,
    });
    res.json(toAutoMessageTemplateDTO(row));
  })
);

autoMessageTemplatesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await service.getAutoMessageTemplate(req.params.id);
    await requireTriggerPermission(req, existing.trigger, "excluir");
    await service.deleteAutoMessageTemplate(req.params.id);
    await writeAudit({
      userId: req.auth!.userId,
      action: "AUTO_MESSAGE_TEMPLATE_DELETED",
      entity: "AutoMessageTemplate",
      entityId: req.params.id,
      ipAddress: req.ip ?? null,
    });
    res.status(204).end();
  })
);
