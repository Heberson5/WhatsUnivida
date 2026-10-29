import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { resolvePeriod, optionalDateQueryParam } from "../../lib/period";
import { parseListParam } from "../../lib/parse-list-param";
import { resolveAllowedConnectionIds } from "../../lib/connection-access";
import { getArrivalsByHour, getDashboard, getPresenceByHour, getTeam, getWordCloud } from "./dashboard.service";
import { getSatisfactionSummary } from "../satisfaction/satisfaction.service";
import { getSatisfactionOverview } from "../satisfaction/satisfaction-report.service";
import { stats as announcementStats } from "../announcements/announcements.service";
import { Errors } from "../../lib/http-error";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requirePermission(PERMISSION.DASHBOARD_ACESSAR));

const querySchema = z.object({
  period: z.enum(["today", "yesterday", "last7days", "month", "lastMonth", "custom"]).default("today"),
  from: optionalDateQueryParam,
  to: optionalDateQueryParam,
  agentId: z.string().uuid().optional(),
  connectionId: z.union([z.string(), z.array(z.string())]).optional(),
  tzOffsetMinutes: z.coerce.number().default(0),
});

dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const connectionIds = await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId));
    const data = await getDashboard({ from, to, agentId: query.agentId, connectionIds });
    res.json(data);
  })
);

dashboardRouter.get(
  "/word-cloud",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const connectionIds = await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId));
    const words = await getWordCloud({ from, to, agentId: query.agentId, connectionIds });
    res.json(words);
  })
);

dashboardRouter.get(
  "/presence-by-hour",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const data = await getPresenceByHour({ from, to, agentId: query.agentId, tzOffsetMinutes: query.tzOffsetMinutes });
    res.json(data);
  })
);

dashboardRouter.get(
  "/arrivals-by-hour",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const connectionIds = await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId));
    res.json(await getArrivalsByHour({ from, to, agentId: query.agentId, connectionIds, tzOffsetMinutes: query.tzOffsetMinutes }));
  })
);

dashboardRouter.get(
  "/team",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    res.json(await getTeam({ from, to, agentId: query.agentId }));
  })
);

dashboardRouter.get(
  "/satisfaction",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const connectionIds = await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId));
    res.json(await getSatisfactionSummary({ from, to, agentId: query.agentId, connectionIds }));
  })
);

/**
 * The Dashboard's satisfaction card and section: the same numbers as Relatórios › Pesquisa de satisfação. Each
 * attendant's NPS and the latest evaluations (they name customers) only for Gestor and Administrador.
 */
dashboardRouter.get(
  "/satisfaction-overview",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    const connectionIds = await resolveAllowedConnectionIds(req.auth!, parseListParam(query.connectionId));
    const withDetail = req.auth!.role === "ADMIN" || req.auth!.role === "MANAGER";
    res.json(await getSatisfactionOverview({ from, to, agentId: query.agentId, connectionIds, tzOffsetMinutes: query.tzOffsetMinutes }, withDetail));
  })
);

/**
 * Dashboard › Comunicados: the notices of Pop Up › Avisos that showed in the period, with reading and "ciente" — Gestor
 * and Administrador only (it names who hasn't confirmed). Notices aren't tied to a connection, so only the period applies.
 */
dashboardRouter.get(
  "/announcements",
  asyncHandler(async (req, res) => {
    if (req.auth!.role !== "ADMIN" && req.auth!.role !== "MANAGER") throw Errors.forbidden();
    const query = querySchema.parse(req.query);
    const { from, to } = resolvePeriod(query.period, query.from, query.to, query.tzOffsetMinutes);
    res.json(await announcementStats(from, to, query.tzOffsetMinutes));
  })
);
