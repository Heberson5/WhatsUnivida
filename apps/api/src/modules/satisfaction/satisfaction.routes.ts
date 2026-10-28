import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import * as service from "./satisfaction.service";

export const satisfactionRouter = Router();

satisfactionRouter.use(requireAuth, requirePermission(PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR));

satisfactionRouter.get(
  "/surveys",
  requirePermission(PERMISSION.RESPOSTAS_PESQUISA_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json((await service.listSurveys()).map(service.toSurveyDTO));
  })
);

const surveyFields = z.object({
  name: z.string().trim().min(1).max(120),
  active: z.boolean(),
  // A survey that is off may keep no connection — the templates ship that way.
  connectionScope: z.object({ allConnections: z.boolean(), connectionIds: z.array(z.string().uuid()).max(200) }),
  question: z.string().trim().min(1).max(1024),
  thanks: z.string().trim().min(1).max(1024),
  answerWindowHours: z.number().int().min(1).max(72),
  closingWaitMinutes: z.number().int().min(1).max(720),
});

type SurveyFields = z.infer<typeof surveyFields>;

function checkSurvey(s: SurveyFields, ctx: z.RefinementCtx) {
  if (s.active && !s.connectionScope.allConnections && s.connectionScope.connectionIds.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Escolha pelo menos uma conexão ou marque todas as conexões para ligar a pesquisa", path: ["connectionScope"] });
  }
  if (s.closingWaitMinutes > s.answerWindowHours * 60) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A espera pela nota não pode ser maior que o tempo para o cliente responder a pesquisa", path: ["closingWaitMinutes"] });
  }
}

const createSchema = surveyFields.superRefine(checkSurvey);

function auditMetadata(survey: ReturnType<typeof service.toSurveyDTO>) {
  return { name: survey.name, active: survey.active, connectionScope: survey.connectionScope, answerWindowHours: survey.answerWindowHours, closingWaitMinutes: survey.closingWaitMinutes };
}

satisfactionRouter.post(
  "/surveys",
  requirePermission(PERMISSION.RESPOSTAS_PESQUISA_ADICIONAR),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const survey = service.toSurveyDTO(await service.createSurvey(input));
    await writeAudit({ userId: req.auth!.userId, action: "SATISFACTION_SURVEY_CREATED", entity: "SatisfactionSurveyConfig", entityId: survey.id, ipAddress: req.ip ?? null, metadata: auditMetadata(survey) });
    res.status(201).json(survey);
  })
);

satisfactionRouter.patch(
  "/surveys/:id",
  requirePermission(PERMISSION.RESPOSTAS_PESQUISA_EDITAR),
  asyncHandler(async (req, res) => {
    const patch = surveyFields.partial().parse(req.body);
    const current = service.toSurveyDTO(await service.getSurvey(req.params.id));
    // The rules apply to the survey as it will be saved, not just to the fields that changed.
    const merged = {
      ...current,
      connectionScope: { allConnections: current.connectionScope.allConnections, connectionIds: current.connectionScope.connections.map((c) => c.id) },
      ...patch,
    };
    createSchema.parse(merged);
    const survey = service.toSurveyDTO(await service.updateSurvey(req.params.id, patch));
    await writeAudit({ userId: req.auth!.userId, action: "SATISFACTION_SURVEY_UPDATED", entity: "SatisfactionSurveyConfig", entityId: survey.id, ipAddress: req.ip ?? null, metadata: auditMetadata(survey) });
    res.json(survey);
  })
);

satisfactionRouter.delete(
  "/surveys/:id",
  requirePermission(PERMISSION.RESPOSTAS_PESQUISA_EXCLUIR),
  asyncHandler(async (req, res) => {
    const survey = service.toSurveyDTO(await service.getSurvey(req.params.id));
    await service.deleteSurvey(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "SATISFACTION_SURVEY_DELETED", entity: "SatisfactionSurveyConfig", entityId: survey.id, ipAddress: req.ip ?? null, metadata: { name: survey.name } });
    res.status(204).end();
  })
);

/** Relatórios e apresentação: the NPS goal and how the presentation names customers (one setting for every survey). */
satisfactionRouter.get(
  "/settings",
  requirePermission(PERMISSION.RESPOSTAS_PESQUISA_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json(await service.getSatisfactionSettings());
  })
);

const settingsSchema = z.object({
  npsGoal: z.number().int().min(0).max(100).nullable(),
  presentationCustomer: z.enum(["full", "initials"]),
});

satisfactionRouter.put(
  "/settings",
  requirePermission(PERMISSION.RESPOSTAS_PESQUISA_EDITAR),
  asyncHandler(async (req, res) => {
    const settings = await service.saveSatisfactionSettings(settingsSchema.parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "SATISFACTION_SETTINGS_UPDATED", entity: "SystemSetting", entityId: "satisfaction.settings", ipAddress: req.ip ?? null, metadata: { ...settings } });
    res.json(settings);
  })
);
