import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsunivida/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { resolvePeriod, optionalDateQueryParam } from "../../lib/period";
import { parseListParam } from "../../lib/parse-list-param";
import { resolveAllowedConnectionIds } from "../../lib/connection-access";
import * as service from "./reports.service";

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
    const buffer = await service.toXlsx(rows, title);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${baseFilename}.xlsx"`);
    res.send(buffer);
    return;
  }
  if (format === "pdf") {
    const buffer = await service.toPdf(rows, title, tzOffsetMinutes);
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
