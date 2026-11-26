import express, { Router, type Request } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { optionalDateQueryParam, resolvePeriod } from "../../lib/period";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import * as service from "./site-analytics.service";
import { TRACKER_SCRIPT } from "./tracker-script";

// ---------------------------------------------------------------------------
// Public: the page itself reports its visit. Any site may call it (the snippet runs on other sites), with no login and
// no cookie — so it has its own CORS (any origin, no credentials), its own request limits, and serves a script other
// sites are allowed to load.
// ---------------------------------------------------------------------------

export const publicSiteRouter = Router();
publicSiteRouter.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
publicSiteRouter.use(cors({ origin: true, credentials: false, methods: ["GET", "POST"] }));
// sendBeacon sends text/plain (a JSON content type would need a preflight it can't do): the body is JSON as text.
publicSiteRouter.use(express.text({ type: ["text/plain", "application/json"], limit: "8kb" }));

const json = (req: Request): unknown => {
  if (typeof req.body !== "string") return req.body ?? {};
  try {
    return JSON.parse(req.body);
  } catch {
    throw Errors.badRequest("Corpo inválido");
  }
};

const startLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const pingLimit = rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false });

publicSiteRouter.get("/tracker.js", (_req, res) => {
  res.type("application/javascript").setHeader("Cache-Control", "public, max-age=3600");
  res.send(TRACKER_SCRIPT);
});

const startSchema = z.object({
  visitorId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  url: z.string().url().max(2000),
  title: z.string().max(500).nullish(),
  referrer: z.string().max(2000).nullish(),
});

publicSiteRouter.post(
  "/visits",
  startLimit,
  asyncHandler(async (req, res) => {
    const input = startSchema.parse(json(req));
    const visit = await service.startVisit({ ...input, userAgent: req.get("user-agent"), ip: req.ip ?? null });
    if (!visit) return res.status(204).end();
    res.status(201).json({ id: visit.id });
  })
);

publicSiteRouter.post(
  "/visits/:id/ping",
  pingLimit,
  asyncHandler(async (req, res) => {
    const { seconds, ended } = z.object({ seconds: z.coerce.number().min(0).max(1_000_000), ended: z.boolean().optional() }).parse(json(req));
    const id = z.string().uuid().parse(req.params.id);
    await service.pingVisit(id, seconds, new Date(), ended ?? false);
    res.status(204).end();
  })
);

publicSiteRouter.post(
  "/visits/:id/login",
  pingLimit,
  asyncHandler(async (req, res) => {
    await service.markLoggedIn(z.string().uuid().parse(req.params.id));
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// The panel: Administração › Acessos ao site (administrador only)
// ---------------------------------------------------------------------------

export const siteAnalyticsRouter = Router();
siteAnalyticsRouter.use(requireAuth, requireRole("ADMIN"), requirePermission(PERMISSION.ACESSOS_SITE_VER));

const periodSchema = z.object({
  period: z.enum(["today", "yesterday", "last7days", "month", "lastMonth", "custom"]).default("last7days"),
  from: optionalDateQueryParam,
  to: optionalDateQueryParam,
  site: z.string().max(200).optional(),
  tzOffsetMinutes: z.coerce.number().default(0),
});

const filterOf = (req: Request) => {
  const q = periodSchema.parse(req.query);
  const { from, to } = resolvePeriod(q.period, q.from, q.to, q.tzOffsetMinutes);
  return { from, to, site: q.site || undefined, tzOffsetMinutes: q.tzOffsetMinutes };
};

siteAnalyticsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await service.summary(filterOf(req)));
  })
);

siteAnalyticsRouter.get(
  "/live",
  asyncHandler(async (req, res) => {
    const { site } = z.object({ site: z.string().max(200).optional() }).parse(req.query);
    res.json(await service.live(site || undefined));
  })
);

siteAnalyticsRouter.get(
  "/visits",
  asyncHandler(async (req, res) => {
    const { page, pageSize } = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(200).default(50) }).parse(req.query);
    res.json(await service.list(filterOf(req), page, pageSize));
  })
);

siteAnalyticsRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const filter = filterOf(req);
    const file = await service.exportXlsx(filter);
    await writeAudit({ userId: req.auth!.userId, action: "SITE_ANALYTICS_EXPORTED", entity: "SiteVisit", entityId: null, ipAddress: req.ip ?? null, metadata: { from: filter.from, to: filter.to, site: filter.site ?? null } });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="acessos-ao-site.xlsx"`);
    res.send(file);
  })
);

siteAnalyticsRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await service.getSettings());
  })
);

siteAnalyticsRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(30).max(1825) }).parse(req.body);
    const settings = await service.saveSettings(retentionDays);
    await writeAudit({ userId: req.auth!.userId, action: "SITE_ANALYTICS_SETTINGS_UPDATED", entity: "SystemSetting", entityId: "siteAnalytics", ipAddress: req.ip ?? null, metadata: settings });
    res.json(settings);
  })
);
