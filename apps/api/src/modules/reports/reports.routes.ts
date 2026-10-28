import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { resolvePeriod, optionalDateQueryParam } from "../../lib/period";
import { parseListParam } from "../../lib/parse-list-param";
import { resolveAllowedConnectionIds } from "../../lib/connection-access";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { writeAudit } from "../../lib/audit";
import { getExportBranding } from "../settings/settings.service";
import * as service from "./reports.service";
import { agentsToRows, getSatisfactionReport, responsesToRows } from "../satisfaction/satisfaction-report.service";
import { arrivalsToRows, getArrivalsByHour } from "../dashboard/dashboard.service";
import { autoMessageBlocksToRows, getAutoMessageBlocks } from "./auto-message-blocks.service";

/** The exports' own logo/cor/nome — configured in Configurações >
 * Exportações, independent from the app's Identidade visual. See PROMPT:
 * "o layout de exportação dos relatórios", "Não é para ter vínculo com a
 * Identidade Visual". */
async function getReportBranding(): Promise<service.ReportBranding> {
  const branding = await getExportBranding();
  return {
    companyName: branding.companyName,
    primaryColor: branding.primaryColor,
    logoPath: branding.logoUrl ? path.join(env.UPLOAD_DIR, "branding", path.basename(branding.logoUrl)) : null,
  };
}

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requirePermission(PERMISSION.RELATORIOS_ACESSAR));

const querySchema = z.object({
  period: z.enum(["today", "yesterday", "last7days", "month", "lastMonth", "custom"]).default("month"),
  from: optionalDateQueryParam,
  to: optionalDateQueryParam,
  agentId: z.string().uuid().optional(),
  connectionId: z.union([z.string(), z.array(z.string())]).optional(),
  format: z.enum(["json", "csv", "pdf", "xlsx"]).default("json"),
  // The browser's own UTC offset in minutes (Date#getTimezoneOffset()) — see
  // lib/period.ts for why the server can't just use its own clock/timezone.
  tzOffsetMinutes: z.coerce.number().default(0),
  // Which columns to keep, in display order — lets the user hide columns
  // both on screen and in the exported file. Omitted/empty = every column.
  columns: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Keeps only the requested keys (in the requested order) on every row — used to let the user hide columns both on screen and in exports. */
function selectColumns(rows: Record<string, unknown>[], columns: string[] | undefined): Record<string, unknown>[] {
  if (!columns || columns.length === 0) return rows;
  return rows.map((row) => {
    const picked: Record<string, unknown> = {};
    for (const key of columns) if (key in row) picked[key] = row[key];
    return picked;
  });
}

// See PROMPT: "Relatórios poder extrair em PDF e em xlsx" — alongside the
// existing CSV/JSON. `title`/`baseFilename` are per-report only for the
// PDF heading and download filename; the row-to-document conversion itself
// is shared.
async function respond(
  res: import("express").Response,
  allRows: Record<string, unknown>[],
  format: "json" | "csv" | "pdf" | "xlsx",
  baseFilename: string,
  title: string,
  tzOffsetMinutes: number,
  columns?: string[]
) {
  const rows = selectColumns(allRows, columns);
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${baseFilename}.csv"`);
    res.send(service.toCsv(rows));
    return;
  }
  if (format === "xlsx") {
    const buffer = await service.toXlsx(rows, title, await getReportBranding());
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${baseFilename}.xlsx"`);
    res.send(buffer);
    return;
  }
  if (format === "pdf") {
    const buffer = await service.toPdf(rows, title, tzOffsetMinutes, await getReportBranding());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${baseFilename}.pdf"`);
    res.send(buffer);
    return;
  }
  res.json(rows);
}

reportsRouter.get(
  "/attendance",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const rows = await service.getAttendanceReport({
      from,
      to,
      agentId: query.agentId,
      connectionIds: await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId)),
      tzOffsetMinutes: query.tzOffsetMinutes,
    });
    await respond(res, rows, query.format, "relatorio-atendimentos", "Relatório de Atendimentos", query.tzOffsetMinutes, parseListParam(query.columns));
  })
);

reportsRouter.get(
  "/per-agent",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const rows = await service.getPerAgentReport({ from, to, connectionIds: await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId)) });
    await respond(res, rows, query.format, "relatorio-por-atendente", "Relatório por Atendente", query.tzOffsetMinutes, parseListParam(query.columns));
  })
);

reportsRouter.get(
  "/messages",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const data = await service.getMessagesReport({ from, to, agentId: query.agentId, connectionIds: await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId)) });
    if (query.format === "json") return res.json(data);
    // The other export formats need rows, not a single stats object — wrap it as one row.
    await respond(res, [data], query.format, "relatorio-mensagens", "Relatório de Mensagens", query.tzOffsetMinutes);
  })
);

// Relatórios › Chegadas por hora: the Dashboard's "Conversas que chegam ao longo do dia" — JSON for the screen's chart,
// one row per hour in the exports.
reportsRouter.get(
  "/arrivals",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const data = await getArrivalsByHour({
      from,
      to,
      agentId: query.agentId,
      connectionIds: await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId)),
      tzOffsetMinutes: query.tzOffsetMinutes,
    });
    if (query.format === "json") return res.json(data);
    await respond(res, arrivalsToRows(data), query.format, "relatorio-chegadas-por-hora", "Chegadas de conversas por hora", query.tzOffsetMinutes, parseListParam(query.columns));
  })
);

// Relatórios › Mensagens automáticas bloqueadas: what the tags (Etiquetas › "Não enviar estas mensagens automáticas")
// stopped in the period. JSON for the screen, one row per message in the exports.
reportsRouter.get(
  "/auto-message-blocks",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const report = await getAutoMessageBlocks({ from, to, agentId: query.agentId, connectionIds: await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId)) });
    if (query.format === "json") return res.json(report);
    await respond(
      res,
      autoMessageBlocksToRows(report, query.tzOffsetMinutes),
      query.format,
      "relatorio-mensagens-bloqueadas",
      "Mensagens automáticas bloqueadas",
      query.tzOffsetMinutes,
      parseListParam(query.columns)
    );
  })
);

// Relatórios › Pesquisa de satisfação. JSON for the screen; the exports are the answers (table=responses, default)
// or each attendant's numbers (table=agents).
const satisfactionQuerySchema = querySchema.extend({ table: z.enum(["responses", "agents"]).default("responses") });
reportsRouter.get(
  "/satisfaction",
  asyncHandler(async (req, res) => {
    const query = satisfactionQuerySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const report = await getSatisfactionReport({
      from,
      to,
      agentId: query.agentId,
      connectionIds: await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId)),
      tzOffsetMinutes: query.tzOffsetMinutes,
    });
    if (query.format === "json") return res.json(report);
    const agents = query.table === "agents";
    await respond(
      res,
      agents ? agentsToRows(report) : responsesToRows(report, query.tzOffsetMinutes),
      query.format,
      agents ? "relatorio-pesquisa-por-atendente" : "relatorio-pesquisa-respostas",
      agents ? "Pesquisa de satisfação por atendente" : "Pesquisa de satisfação — respostas",
      query.tzOffsetMinutes,
      parseListParam(query.columns)
    );
  })
);

// Fixes a score read wrong from the customer's text ("1o" read as 1). Keeps what had been read the first time.
const scoreCorrectionSchema = z.object({ score: z.number().int().min(0).max(10) });
reportsRouter.patch(
  "/satisfaction/:surveyId/score",
  requirePermission(PERMISSION.RELATORIOS_PESQUISA_CORRIGIR),
  asyncHandler(async (req, res) => {
    const { score } = scoreCorrectionSchema.parse(req.body);
    const survey = await prisma.satisfactionSurvey.findUnique({ where: { id: req.params.surveyId } });
    if (!survey || survey.score === null) throw Errors.notFound("Avaliação não encontrada.");
    const allowed = await resolveAllowedConnectionIds(req.auth!, [survey.whatsappConnectionId]);
    if (allowed && !allowed.includes(survey.whatsappConnectionId)) throw Errors.forbidden();
    await prisma.satisfactionSurvey.update({
      where: { id: survey.id },
      data: {
        score,
        originalScore: survey.scoreCorrectedAt ? survey.originalScore : survey.score,
        scoreCorrectedAt: new Date(),
        scoreCorrectedById: req.auth!.userId,
      },
    });
    await writeAudit({
      userId: req.auth!.userId,
      action: "SATISFACTION_SCORE_CORRECTED",
      entity: "SatisfactionSurvey",
      entityId: survey.id,
      ipAddress: req.ip ?? null,
      metadata: { from: survey.score, to: score, answer: survey.answerText },
    });
    res.status(204).end();
  })
);
