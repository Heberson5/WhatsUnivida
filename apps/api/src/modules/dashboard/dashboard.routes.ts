import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsunivida/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { resolvePeriod, optionalDateQueryParam } from "../../lib/period";
import { parseListParam } from "../../lib/parse-list-param";
import { resolveAllowedConnectionIds } from "../../lib/connection-access";
import { getDashboard } from "./dashboard.service";

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
