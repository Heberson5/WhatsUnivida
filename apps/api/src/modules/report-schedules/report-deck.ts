import fs from "node:fs";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import { imageSize } from "image-size";
import type { ReportSchedule, Role } from "@prisma/client";
import type { ReportSchedulePeriod } from "@whatsatendende/types";
import { PRESENTATION_ICON_PNGS, buildDashboardPresentation, describePeriod, type DashboardSnapshot, type PeriodKey, type PresentationInput } from "@whatsatendende/presentation";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { resolvePeriod } from "../../lib/period";
import { resolveAllowedConnectionIds } from "../../lib/connection-access";
import { getExportBranding } from "../settings/settings.service";
import { getArrivalsByHour, getDashboard, getPresenceByHour, getTeam, getWordCloud } from "../dashboard/dashboard.service";
import { getSatisfactionOverview, getSatisfactionReport } from "../satisfaction/satisfaction-report.service";
import { getAutoMessageBlocks } from "../reports/auto-message-blocks.service";
import { stats as announcementStats } from "../announcements/announcements.service";

/**
 * The Dashboard's presentation built on the server, for a scheduled send: the same deck as the "Apresentação (PPT)"
 * button (packages/presentation), with the numbers read straight from the services behind the Dashboard — in the
 * Gestor's view of whoever last saved the schedule (their connections; satisfaction in detail). Built in memory and
 * handed back as a buffer; nothing is written to disk.
 */

export type DeckSchedule = Pick<ReportSchedule, "frequency" | "customInterval" | "customUnit" | "period" | "agentId" | "connectionIds" | "tzOffsetMinutes" | "createdById" | "updatedById">;

/** "Automático": the period the frequency covers — daily → the day before, weekly → 7 days, monthly → the month before... */
export function automaticPeriod(s: Pick<ReportSchedule, "frequency" | "customInterval" | "customUnit">): Exclude<ReportSchedulePeriod, "AUTO"> {
  switch (s.frequency) {
    case "DAILY":
      return "yesterday";
    case "WEEKLY":
      return "last7days";
    case "BIWEEKLY":
      return "last15days";
    case "MONTHLY":
      return "lastMonth";
    case "YEARLY":
      return "lastYear";
    case "CUSTOM": {
      const n = Math.max(1, s.customInterval);
      if (s.customUnit === "MONTH") return n >= 12 ? "lastYear" : "lastMonth";
      const days = s.customUnit === "WEEK" ? n * 7 : n;
      return days <= 1 ? "yesterday" : days <= 7 ? "last7days" : days <= 15 ? "last15days" : "lastMonth";
    }
  }
}

const DAY_MS = 86_400_000;

/** From/to instants of a schedule's period, in its time zone, plus how the deck names it. */
export function schedulePeriod(period: ReportSchedulePeriod, s: Parameters<typeof automaticPeriod>[0], tz: number, now = new Date()): { from: Date; to: Date; key: PeriodKey } {
  const chosen = period === "AUTO" ? automaticPeriod(s) : period;
  const local = new Date(now.getTime() - tz * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const dayStart = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd) + tz * 60_000);
  const dayEnd = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd, 23, 59, 59, 999) + tz * 60_000);
  switch (chosen) {
    case "yesterday":
    case "last7days":
    case "month":
    case "lastMonth": {
      const { from, to } = resolvePeriod(chosen, undefined, undefined, tz);
      return { from, to, key: chosen };
    }
    case "last15days":
      return { from: dayStart(y, m, d - 14), to: dayEnd(y, m, d), key: "last15days" };
    case "year":
      return { from: dayStart(y, 0, 1), to: dayEnd(y, m, d), key: "year" };
    case "lastYear":
      return { from: dayStart(y - 1, 0, 1), to: dayEnd(y - 1, 11, 31), key: "lastYear" };
    case "all":
      return { from: new Date(Date.UTC(2000, 0, 1)), to: new Date(dayEnd(y, m, d).getTime()), key: "all" };
  }
  return { from: new Date(now.getTime() - DAY_MS), to: now, key: "yesterday" };
}

function loadLogo(logoUrl: string | null | undefined): PresentationInput["logo"] {
  if (!logoUrl) return null;
  try {
    const file = path.join(env.UPLOAD_DIR, "branding", path.basename(logoUrl));
    const buffer = fs.readFileSync(file);
    const { width, height, type } = imageSize(buffer);
    if (!width || !height) return null;
    const mime = type === "jpg" ? "image/jpeg" : `image/${type ?? "png"}`;
    return { data: `data:${mime};base64,${buffer.toString("base64")}`, width, height };
  } catch {
    // A logo missing on disk never blocks the send — the cover goes without it.
    return null;
  }
}

export interface BuiltDeck {
  buffer: Buffer;
  fileName: string;
  periodName: string;
  periodDates: string;
  scopeLabel: string;
}

export async function buildScheduledDeck(schedule: DeckSchedule, now = new Date()): Promise<BuiltDeck> {
  const tz = schedule.tzOffsetMinutes;
  const ownerId = schedule.updatedById ?? schedule.createdById;
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { id: true, role: true, status: true, presenceChartStartHour: true, presenceChartEndHour: true, arrivalsChartStartHour: true, arrivalsChartEndHour: true },
  });
  if (!owner || owner.status !== "ACTIVE") {
    throw new Error("Quem salvou este agendamento não está mais ativo no sistema — abra o agendamento e salve de novo para ele voltar a ser enviado.");
  }
  // The Gestor's view: an AGENT never gets here (the permission is Gestor/Administrador only), but is read as a Gestor.
  const role: Role = owner.role === "AGENT" ? "MANAGER" : owner.role;
  const connectionIds = await resolveAllowedConnectionIds({ userId: owner.id, role }, schedule.connectionIds.length ? schedule.connectionIds : undefined);
  const { from, to, key } = schedulePeriod(schedule.period as ReportSchedulePeriod, schedule, tz, now);
  const agentId = schedule.agentId ?? undefined;
  const scope = { from, to, agentId, connectionIds };

  const [data, wordCloud, satisfaction, satisfactionReport, team, presenceByHour, arrivalsByHour, autoMessageBlocks, announcements, branding, connections, agent] = await Promise.all([
    getDashboard(scope),
    getWordCloud(scope),
    getSatisfactionOverview({ ...scope, tzOffsetMinutes: tz }, true),
    getSatisfactionReport({ ...scope, tzOffsetMinutes: tz }).catch(() => null),
    getTeam({ from, to, agentId }),
    getPresenceByHour({ from, to, agentId, tzOffsetMinutes: tz }),
    getArrivalsByHour({ ...scope, tzOffsetMinutes: tz }),
    getAutoMessageBlocks(scope).catch(() => null),
    announcementStats(from, to, tz).catch(() => null),
    getExportBranding(),
    schedule.connectionIds.length ? prisma.whatsAppConnection.findMany({ where: { id: { in: schedule.connectionIds } }, select: { name: true } }) : Promise.resolve([]),
    agentId ? prisma.user.findUnique({ where: { id: agentId }, select: { displayName: true } }) : Promise.resolve(null),
  ]);

  const connectionsText =
    schedule.connectionIds.length === 0
      ? "Todas as conexões"
      : connections.length <= 3
        ? `${connections.length === 1 ? "Conexão" : "Conexões"}: ${connections.map((c) => c.name).join(", ")}`
        : `${connections.length} conexões`;
  const scopeLabel = `${connectionsText} · ${agent ? `atendente: ${agent.displayName}` : "todos os atendentes"}`;

  // The server runs in UTC: the deck's clock is shifted to the schedule's own time zone (see clockShiftMinutes).
  const localNow = new Date(now.getTime() - tz * 60_000);
  const range = (start: number | null, end: number | null) => (start !== null && end !== null ? { start, end } : null);
  const periodValue = { period: key };
  const pptx = buildDashboardPresentation(PptxGenJS, {
    companyName: branding.companyName ?? "WhatsAtendende",
    primaryColor: branding.primaryColor ?? "#0097B4",
    logo: loadLogo(branding.logoUrl),
    icons: PRESENTATION_ICON_PNGS,
    period: periodValue,
    scopeLabel,
    data: data as unknown as DashboardSnapshot,
    satisfaction,
    satisfactionReport,
    team,
    wordCloud,
    presenceByHour,
    presenceHourRange: range(owner.presenceChartStartHour, owner.presenceChartEndHour),
    arrivalsByHour,
    arrivalsHourRange: range(owner.arrivalsChartStartHour, owner.arrivalsChartEndHour),
    autoMessageBlocks,
    announcements,
    clockShiftMinutes: tz,
    now: localNow,
  });
  const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const described = describePeriod(periodValue, localNow);
  return {
    buffer,
    fileName: `apresentacao-atendimento-${key}-${localNow.toISOString().slice(0, 10)}.pptx`,
    periodName: described.name,
    periodDates: described.dates,
    scopeLabel,
  };
}
