import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import type { SiteAnalyticsCount, SiteAnalyticsLiveDTO, SiteAnalyticsSummaryDTO, SiteVisitDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { getIpPlaces, isInternalIp } from "../../lib/ip-location";

/**
 * Acessos ao site (administrador): visits to the public page — the system's own login page, and any site that carries
 * the tracking snippet (GET /api/public/site/tracker.js). Anonymous on purpose: a random id per browser to tell new
 * from returning visitors, the place looked up from the IP (the IP itself is never stored), no cookie and no name.
 */

const SETTINGS_KEY = "siteAnalytics";
export const RETENTION_DEFAULT_DAYS = 365;
/** A visit counts as "on the page now" while it sent a sign of life this recently (the page sends one every 15 s). */
export const LIVE_WINDOW_MS = 60_000;
/** Left in under this many seconds: a bounce. */
const BOUNCE_SECONDS = 10;
/** One visit never counts more than this, whatever a page reports (a tab forgotten open overnight). */
const MAX_VISIT_SECONDS = 4 * 60 * 60;
/** A sign of life after this long without one starts nothing new: that visit is over. */
const VISIT_EXPIRY_MS = 30 * 60_000;
const TOP = 10;

// ---------------------------------------------------------------------------
// Who is visiting: device, browser, system — read from the User-Agent, no library needed
// ---------------------------------------------------------------------------

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp|telegram|python|curl|wget|httpclient|axios|node-fetch|monitor|uptime/i;

export function parseUserAgent(ua: string | undefined) {
  const s = ua ?? "";
  const bot = !s || BOT.test(s);
  const device = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s) ? "Tablet" : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(s) ? "Celular" : "Computador";
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser/.test(s)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(s)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(s)
            ? "Chrome"
            : /Safari\//.test(s)
              ? "Safari"
              : null;
  const os = /Windows/.test(s)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(s)
      ? "iOS"
      : /Android/.test(s)
        ? "Android"
        : /Mac OS X|Macintosh/.test(s)
          ? "macOS"
          : /CrOS/.test(s)
            ? "ChromeOS"
            : /Linux/.test(s)
              ? "Linux"
              : null;
  return { bot, device, browser, os };
}

/** The host of an address ("https://www.google.com/search?q=x" → "google.com"), or null. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

const clip = (value: string | null | undefined, max: number) => {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
};

// ---------------------------------------------------------------------------
// Recording (public — called by the page itself)
// ---------------------------------------------------------------------------

export interface StartVisitInput {
  visitorId: string;
  url: string;
  title?: string | null;
  referrer?: string | null;
  userAgent?: string;
  ip?: string | null;
}

/** A new visit, or null when it is not one worth counting (a bot, a link preview, an unreadable address). */
export async function startVisit(input: StartVisitInput): Promise<{ id: string } | null> {
  const agent = parseUserAgent(input.userAgent);
  if (agent.bot) return null;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const site = url.hostname.replace(/^www\./, "").toLowerCase();
  const referrerHost = hostOf(input.referrer);
  const visit = await prisma.siteVisit.create({
    data: {
      visitorId: input.visitorId.slice(0, 64),
      site: site.slice(0, 200),
      path: (url.pathname || "/").slice(0, 300),
      title: clip(input.title, 200),
      // Moving inside the same site is not an origin.
      referrer: referrerHost && referrerHost !== site ? referrerHost.slice(0, 200) : null,
      utmSource: clip(url.searchParams.get("utm_source"), 100),
      utmMedium: clip(url.searchParams.get("utm_medium"), 100),
      utmCampaign: clip(url.searchParams.get("utm_campaign"), 100),
      device: agent.device,
      browser: agent.browser,
      os: agent.os,
    },
    select: { id: true },
  });
  if (input.ip) void fillPlace(visit.id, input.ip);
  return visit;
}

/** City, state and country from the IP (cached lookup) — written on the visit; the IP itself is not kept. */
export async function fillPlace(visitId: string, ip: string) {
  try {
    if (isInternalIp(ip)) return;
    await getIpPlaces([ip]);
    const place = await prisma.ipLocation.findUnique({ where: { ip }, select: { found: true, city: true, region: true, country: true } });
    if (place?.found) await prisma.siteVisit.update({ where: { id: visitId }, data: { city: place.city, region: place.region, country: place.country } });
  } catch (err) {
    logger.warn({ err }, "could not find the place of a site visit");
  }
}

/** A sign of life: the page is still open, with this many seconds in front of the visitor so far (`ended`: its last). */
export async function pingVisit(id: string, activeSeconds: number, now = new Date(), ended = false): Promise<boolean> {
  const visit = await prisma.siteVisit.findUnique({ where: { id }, select: { startedAt: true, lastSeenAt: true, durationSeconds: true } });
  if (!visit || now.getTime() - visit.lastSeenAt.getTime() > VISIT_EXPIRY_MS) return false;
  // Never more than the time since the visit began (plus a little clock slack), never less than already counted.
  const elapsed = Math.ceil((now.getTime() - visit.startedAt.getTime()) / 1000) + 5;
  const seconds = Math.max(visit.durationSeconds, Math.min(Math.max(0, Math.floor(activeSeconds)), elapsed, MAX_VISIT_SECONDS));
  await prisma.siteVisit.update({ where: { id }, data: { lastSeenAt: now, durationSeconds: seconds, endedAt: ended ? now : null } });
  return true;
}

/** The visitor logged in to the system from this visit (login page). */
export async function markLoggedIn(id: string) {
  await prisma.siteVisit.updateMany({ where: { id }, data: { loggedIn: true } });
}

// ---------------------------------------------------------------------------
// The panel (administrador)
// ---------------------------------------------------------------------------

export interface PanelFilter {
  from: Date;
  to: Date;
  site?: string;
  tzOffsetMinutes: number;
}

const where = (f: { from: Date; to: Date; site?: string }): Prisma.SiteVisitWhereInput => ({
  startedAt: { gte: f.from, lte: f.to },
  ...(f.site ? { site: f.site } : {}),
});

function top(map: Map<string, number>, limit = TOP): SiteAnalyticsCount[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, visits]) => ({ key, visits }));
}

const bump = (map: Map<string, number>, key: string | null | undefined, fallback: string) => {
  const k = key || fallback;
  map.set(k, (map.get(k) ?? 0) + 1);
};

const placeOf = (v: { city: string | null; region: string | null; country: string | null }) => [v.city, v.region, v.country].filter(Boolean).join(", ") || null;
const campaignOf = (v: { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null }) =>
  [v.utmCampaign, v.utmSource, v.utmMedium].filter(Boolean).join(" · ") || null;

/** Visitors of these ids who had a visit before `before` (returning), so the rest are new. */
async function returningVisitors(visitorIds: string[], before: Date, site?: string): Promise<Set<string>> {
  if (!visitorIds.length) return new Set();
  const rows = await prisma.siteVisit.findMany({
    where: { visitorId: { in: visitorIds }, startedAt: { lt: before }, ...(site ? { site } : {}) },
    select: { visitorId: true },
    distinct: ["visitorId"],
  });
  return new Set(rows.map((r) => r.visitorId));
}

export async function summary(f: PanelFilter): Promise<SiteAnalyticsSummaryDTO> {
  const visits = await prisma.siteVisit.findMany({
    where: where(f),
    select: {
      visitorId: true,
      path: true,
      referrer: true,
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      device: true,
      browser: true,
      os: true,
      city: true,
      region: true,
      country: true,
      startedAt: true,
      durationSeconds: true,
      loggedIn: true,
    },
  });
  // The period just before, the same length: "compared to the previous period".
  const length = f.to.getTime() - f.from.getTime();
  const previousFilter = { from: new Date(f.from.getTime() - length - 1), to: new Date(f.from.getTime() - 1), site: f.site };
  const previous = await prisma.siteVisit.findMany({ where: where(previousFilter), select: { visitorId: true, durationSeconds: true } });
  const sites = (await prisma.siteVisit.findMany({ select: { site: true }, distinct: ["site"], orderBy: { site: "asc" } })).map((r) => r.site);

  const visitorIds = [...new Set(visits.map((v) => v.visitorId))];
  const returning = await returningVisitors(visitorIds, f.from, f.site);
  const avg = (rows: { durationSeconds: number }[]) => (rows.length ? Math.round(rows.reduce((sum, r) => sum + r.durationSeconds, 0) / rows.length) : 0);
  const local = (d: Date) => new Date(d.getTime() - f.tzOffsetMinutes * 60_000);

  const byDay = new Map<string, { visits: number; visitors: Set<string> }>();
  const byHour = Array<number>(24).fill(0);
  const byWeekday = Array<number>(7).fill(0);
  const pages = new Map<string, { visits: number; seconds: number }>();
  const referrers = new Map<string, number>();
  const campaigns = new Map<string, number>();
  const devices = new Map<string, number>();
  const browsers = new Map<string, number>();
  const systems = new Map<string, number>();
  const places = new Map<string, number>();
  for (const v of visits) {
    const at = local(v.startedAt);
    const day = at.toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { visits: 0, visitors: new Set<string>() };
    d.visits++;
    d.visitors.add(v.visitorId);
    byDay.set(day, d);
    byHour[at.getUTCHours()]++;
    byWeekday[at.getUTCDay()]++;
    const p = pages.get(v.path) ?? { visits: 0, seconds: 0 };
    p.visits++;
    p.seconds += v.durationSeconds;
    pages.set(v.path, p);
    bump(referrers, v.referrer, "Acesso direto");
    const campaign = campaignOf(v);
    if (campaign) bump(campaigns, campaign, "");
    bump(devices, v.device, "Outro");
    bump(browsers, v.browser, "Outro");
    bump(systems, v.os, "Outro");
    bump(places, placeOf(v), "Não identificado");
  }
  // Every day of the period, also the ones with no visit (a continuous line on the chart).
  const days: SiteAnalyticsSummaryDTO["byDay"] = [];
  for (let t = local(f.from).getTime(), end = local(f.to).getTime(); t <= end && days.length < 400; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const d = byDay.get(day);
    days.push({ day, visits: d?.visits ?? 0, visitors: d?.visitors.size ?? 0 });
  }
  const loginVisits = visits.filter((v) => v.path === "/login");

  return {
    sites,
    totals: {
      visits: visits.length,
      visitors: visitorIds.length,
      newVisitors: visitorIds.filter((id) => !returning.has(id)).length,
      avgDurationSeconds: avg(visits),
      bounceRate: visits.length ? visits.filter((v) => v.durationSeconds < BOUNCE_SECONDS).length / visits.length : 0,
      loginRate: loginVisits.length ? loginVisits.filter((v) => v.loggedIn).length / loginVisits.length : null,
    },
    previous: { visits: previous.length, visitors: new Set(previous.map((v) => v.visitorId)).size, avgDurationSeconds: avg(previous) },
    byDay: days,
    byHour,
    byWeekday,
    pages: [...pages.entries()]
      .sort((a, b) => b[1].visits - a[1].visits)
      .slice(0, TOP)
      .map(([path, p]) => ({ path, visits: p.visits, avgDurationSeconds: Math.round(p.seconds / p.visits) })),
    referrers: top(referrers),
    campaigns: top(campaigns),
    devices: top(devices),
    browsers: top(browsers),
    systems: top(systems),
    places: top(places),
  };
}

type VisitRow = Prisma.SiteVisitGetPayload<object>;

function toDTO(v: VisitRow, returning: Set<string>): SiteVisitDTO {
  return {
    id: v.id,
    site: v.site,
    path: v.path,
    referrer: v.referrer,
    campaign: campaignOf(v),
    device: v.device,
    browser: v.browser,
    os: v.os,
    place: placeOf(v),
    startedAt: v.startedAt.toISOString(),
    lastSeenAt: v.lastSeenAt.toISOString(),
    durationSeconds: v.durationSeconds,
    loggedIn: v.loggedIn,
    returning: returning.has(v.id),
  };
}

/** Visits whose visitor had come before (their id → returning), for the "nova / retorno" mark on each row. */
async function returningVisits(rows: VisitRow[]): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const earlier = await prisma.siteVisit.groupBy({ by: ["visitorId"], where: { visitorId: { in: [...new Set(rows.map((r) => r.visitorId))] } }, _min: { startedAt: true } });
  const first = new Map(earlier.map((e) => [e.visitorId, e._min.startedAt?.getTime() ?? 0]));
  return new Set(rows.filter((r) => (first.get(r.visitorId) ?? 0) < r.startedAt.getTime()).map((r) => r.id));
}

/** Who is on the public page right now (a sign of life in the last minute). */
export async function live(site?: string, now = new Date()): Promise<SiteAnalyticsLiveDTO> {
  const rows = await prisma.siteVisit.findMany({
    where: { lastSeenAt: { gte: new Date(now.getTime() - LIVE_WINDOW_MS) }, endedAt: null, ...(site ? { site } : {}) },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  const returning = await returningVisits(rows);
  return { now: rows.length, visits: rows.map((r) => toDTO(r, returning)) };
}

/** The visits of the period, newest first, a page at a time. */
export async function list(f: { from: Date; to: Date; site?: string }, page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    prisma.siteVisit.count({ where: where(f) }),
    prisma.siteVisit.findMany({ where: where(f), orderBy: { startedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  const returning = await returningVisits(rows);
  return { total, page, pageSize, visits: rows.map((r) => toDTO(r, returning)) };
}

/** Every visit of the period in a spreadsheet (up to 50 000 rows). */
export async function exportXlsx(f: { from: Date; to: Date; site?: string; tzOffsetMinutes: number }): Promise<Buffer> {
  const rows = await prisma.siteVisit.findMany({ where: where(f), orderBy: { startedAt: "asc" }, take: 50_000 });
  const returning = await returningVisits(rows);
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Acessos ao site");
  sheet.columns = [
    { header: "Início", key: "startedAt", width: 18 },
    { header: "Site", key: "site", width: 30 },
    { header: "Página", key: "path", width: 28 },
    { header: "Tempo na página (s)", key: "duration", width: 18 },
    { header: "Origem", key: "referrer", width: 24 },
    { header: "Campanha", key: "campaign", width: 26 },
    { header: "Aparelho", key: "device", width: 12 },
    { header: "Navegador", key: "browser", width: 16 },
    { header: "Sistema", key: "os", width: 12 },
    { header: "Local", key: "place", width: 30 },
    { header: "Visitante", key: "kind", width: 12 },
    { header: "Entrou no sistema", key: "loggedIn", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) {
    const dto = toDTO(r, returning);
    sheet.addRow({
      startedAt: new Date(r.startedAt.getTime() - f.tzOffsetMinutes * 60_000),
      site: dto.site,
      path: dto.path,
      duration: dto.durationSeconds,
      referrer: dto.referrer ?? "Acesso direto",
      campaign: dto.campaign ?? "",
      device: dto.device,
      browser: dto.browser ?? "",
      os: dto.os ?? "",
      place: dto.place ?? "",
      kind: dto.returning ? "Retorno" : "Nova",
      loggedIn: dto.loggedIn ? "Sim" : "",
    });
  }
  sheet.getColumn("startedAt").numFmt = "dd/mm/yyyy hh:mm";
  return Buffer.from(await book.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// How long visits are kept
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<{ retentionDays: number }> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
  return { retentionDays: RETENTION_DEFAULT_DAYS, ...((row?.value as { retentionDays?: number } | null) ?? {}) };
}

export async function saveSettings(retentionDays: number) {
  const value = { retentionDays } as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value }, create: { key: SETTINGS_KEY, value } });
  return getSettings();
}

/** Visits older than the retention are deleted (server.ts, once an hour). */
export async function purgeOldVisits(now = new Date()): Promise<number> {
  const { retentionDays } = await getSettings();
  const { count } = await prisma.siteVisit.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - retentionDays * 86_400_000) } } });
  return count;
}
