import type {
  SatisfactionCategory,
  SatisfactionOverviewDTO,
  SatisfactionPreviousDTO,
  SatisfactionReportDTO,
  SatisfactionResponseDTO,
  SatisfactionScoreStatsDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { calculateNps, getCurrentQuestion, getSatisfactionSettings, npsExcludedContactIds } from "./satisfaction.service";
import { parseSurveyScore } from "./survey-score";

/** A recorded score the current reading rules would read differently ("1o" once read as 1) — unless a manager already fixed it. */
function rereadScore(r: { score: number | null; answerText: string | null; scoreCorrectedAt: Date | null }): number | null {
  if (r.score === null || r.scoreCorrectedAt || !r.answerText) return null;
  const reread = parseSurveyScore(r.answerText);
  return reread !== null && reread !== r.score ? reread : null;
}

/**
 * Relatórios › Pesquisa de satisfação: the 0–10 (NPS) surveys sent in the
 * period — who rated what, each attendant's and each connection's numbers,
 * how it moved over the period, and every answer with its conversation. See
 * PROMPT: "relatório somente das pesquisas, podendo saber de qual cliente foi
 * a nota e poder olhar a conversa avaliada, poder saber as notas que cada
 * atendente recebe". Surveys of the old 1–5 scale are left out: they don't
 * add up with NPS.
 */

export interface SatisfactionReportParams {
  from: Date;
  to: Date;
  agentId?: string;
  connectionIds?: string[];
  /** The browser's UTC offset (Date#getTimezoneOffset) — days of the trend are the viewer's days. */
  tzOffsetMinutes?: number;
}

const MAX_RESPONSES = 5000;
const DAY_MS = 86_400_000;

export function categoryOf(score: number): SatisfactionCategory {
  return score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor";
}

export const CATEGORY_LABEL: Record<SatisfactionCategory, string> = { promoter: "Promotor", passive: "Neutro", detractor: "Detrator" };

function stats(sent: number, scores: number[], awaiting = 0): SatisfactionScoreStatsDTO {
  const distribution = Array<number>(11).fill(0);
  for (const s of scores) distribution[s] += 1;
  const nps = calculateNps(distribution);
  const average = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  return {
    sent,
    answered: scores.length,
    unanswered: sent - scores.length - awaiting,
    responseRate: sent ? Math.round((scores.length / sent) * 100) : null,
    average,
    nps: nps.nps,
    promoters: nps.promoters,
    passives: nps.passives,
    detractors: nps.detractors,
  };
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * The period right before, with the same length (e.g. the 13 days before "Este mês" on the 13th) — the totals and
 * each attendant's NPS, for "▲ 6 pontos em relação ao período anterior".
 */
async function previousPeriod(params: SatisfactionReportParams): Promise<{ previous: SatisfactionPreviousDTO; npsByAgent: Map<string, number | null> }> {
  const to = new Date(params.from.getTime() - 1);
  const from = new Date(params.from.getTime() - (params.to.getTime() - params.from.getTime()) - 1);
  const rows = await prisma.satisfactionSurvey.findMany({
    where: {
      sentAt: { gte: from, lte: to },
      questionId: { not: null },
      contactId: { notIn: await npsExcludedContactIds() },
      ...(params.agentId && { agentId: params.agentId }),
      ...(params.connectionIds && { whatsappConnectionId: { in: params.connectionIds } }),
    },
    select: { score: true, agentId: true },
  });
  const scores = rows.filter((r) => r.score !== null).map((r) => r.score!);
  const totals = stats(rows.length, scores);
  const perAgent = new Map<string, number[]>();
  for (const r of rows) if (r.agentId && r.score !== null) perAgent.set(r.agentId, [...(perAgent.get(r.agentId) ?? []), r.score]);
  return {
    previous: { from: from.toISOString(), to: to.toISOString(), nps: totals.nps, average: totals.average, answered: totals.answered, responseRate: totals.responseRate },
    npsByAgent: new Map([...perAgent].map(([agentId, s]) => [agentId, stats(s.length, s).nps])),
  };
}

export async function getSatisfactionReport(params: SatisfactionReportParams): Promise<SatisfactionReportDTO> {
  const now = new Date();
  const [{ previous, npsByAgent }, currentQuestion, settings] = await Promise.all([previousPeriod(params), getCurrentQuestion(), getSatisfactionSettings()]);
  const rows = await prisma.satisfactionSurvey.findMany({
    where: {
      sentAt: { gte: params.from, lte: params.to },
      questionId: { not: null },
      contactId: { notIn: await npsExcludedContactIds() },
      ...(params.agentId && { agentId: params.agentId }),
      ...(params.connectionIds && { whatsappConnectionId: { in: params.connectionIds } }),
    },
    orderBy: { sentAt: "desc" },
    select: {
      id: true,
      conversationId: true,
      sentAt: true,
      answeredAt: true,
      expiresAt: true,
      score: true,
      answerText: true,
      originalScore: true,
      scoreCorrectedAt: true,
      scoreCorrectedBy: { select: { displayName: true } },
      agentId: true,
      agent: { select: { displayName: true } },
      whatsappConnection: { select: { id: true, name: true, color: true } },
      question: { select: { text: true } },
      config: { select: { name: true } },
      conversation: { select: { contact: { select: { name: true, phone: true } } } },
    },
  });

  const answeredScores = rows.filter((r) => r.score !== null).map((r) => r.score!);
  const distribution = Array<number>(11).fill(0);
  for (const s of answeredScores) distribution[s] += 1;

  // Per attendant / per connection.
  const byAgent = new Map<string, { agentId: string | null; agentName: string; sent: number; scores: number[]; awaiting: number }>();
  const byConnection = new Map<string, { connectionId: string; connectionName: string; connectionColor: string; sent: number; scores: number[]; awaiting: number }>();
  const isAwaiting = (r: (typeof rows)[number]) => r.score === null && r.expiresAt > now;
  for (const r of rows) {
    const agentKey = r.agentId ?? "none";
    const agent = byAgent.get(agentKey) ?? { agentId: r.agentId, agentName: r.agent?.displayName ?? "Sem atendente", sent: 0, scores: [], awaiting: 0 };
    agent.sent += 1;
    if (r.score !== null) agent.scores.push(r.score);
    if (isAwaiting(r)) agent.awaiting += 1;
    byAgent.set(agentKey, agent);
    const conn = byConnection.get(r.whatsappConnection.id) ?? {
      connectionId: r.whatsappConnection.id,
      connectionName: r.whatsappConnection.name,
      connectionColor: r.whatsappConnection.color,
      sent: 0,
      scores: [],
      awaiting: 0,
    };
    conn.sent += 1;
    if (r.score !== null) conn.scores.push(r.score);
    if (isAwaiting(r)) conn.awaiting += 1;
    byConnection.set(r.whatsappConnection.id, conn);
  }

  // The trend: the viewer's days, or weeks (from Monday) when the period is longer than a month.
  const offsetMs = (params.tzOffsetMinutes ?? 0) * 60_000;
  const weekly = params.to.getTime() - params.from.getTime() > 31 * DAY_MS;
  const bucketOf = (d: Date) => {
    const local = new Date(d.getTime() - offsetMs);
    local.setUTCHours(0, 0, 0, 0);
    if (weekly) local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
    return local.getTime();
  };
  const buckets = new Map<number, number[]>();
  for (const r of rows) {
    if (r.score === null || !r.answeredAt) continue;
    const key = bucketOf(r.answeredAt);
    buckets.set(key, [...(buckets.get(key) ?? []), r.score]);
  }
  const trend = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, scores]) => {
      const d = new Date(start);
      const s = stats(scores.length, scores);
      return {
        start: new Date(start + offsetMs).toISOString(),
        label: `${weekly ? "Semana de " : ""}${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}`,
        answered: s.answered,
        average: s.average,
        nps: s.nps,
      };
    });

  const responses: SatisfactionResponseDTO[] = rows.slice(0, MAX_RESPONSES).map((r) => ({
    surveyId: r.id,
    conversationId: r.conversationId,
    sentAt: r.sentAt.toISOString(),
    answeredAt: r.answeredAt?.toISOString() ?? null,
    contactName: r.conversation.contact.name,
    contactPhone: r.conversation.contact.phone,
    agentName: r.agent?.displayName ?? null,
    connectionName: r.whatsappConnection.name,
    surveyName: r.config?.name ?? null,
    question: r.question?.text ?? null,
    score: r.score,
    answerText: r.answerText,
    rereadScore: rereadScore(r),
    correction: r.scoreCorrectedAt ? { originalScore: r.originalScore, byName: r.scoreCorrectedBy?.displayName ?? null, at: r.scoreCorrectedAt.toISOString() } : null,
    category: r.score === null ? null : categoryOf(r.score),
    status: r.score !== null ? "answered" : r.expiresAt > now ? "awaiting" : "expired",
  }));

  const sortByNps = <T extends SatisfactionScoreStatsDTO>(a: T, b: T) =>
    (b.nps ?? -Infinity) - (a.nps ?? -Infinity) || (b.average ?? -1) - (a.average ?? -1) || b.answered - a.answered;

  return {
    totals: { ...stats(rows.length, answeredScores, rows.filter(isAwaiting).length), distribution, awaiting: rows.filter(isAwaiting).length },
    byAgent: [...byAgent.values()]
      .map((a) => ({
        ...stats(a.sent, a.scores, a.awaiting),
        agentId: a.agentId,
        agentName: a.agentName,
        lowest: a.scores.length ? Math.min(...a.scores) : null,
        highest: a.scores.length ? Math.max(...a.scores) : null,
        previousNps: a.agentId ? (npsByAgent.get(a.agentId) ?? null) : null,
      }))
      .sort(sortByNps),
    byConnection: [...byConnection.values()].map((c) => ({ ...stats(c.sent, c.scores, c.awaiting), connectionId: c.connectionId, connectionName: c.connectionName, connectionColor: c.connectionColor })).sort(sortByNps),
    trend,
    responses,
    previous,
    currentQuestion,
    settings,
  };
}

/**
 * Dashboard › Pesquisa de satisfação: built from the same report, so its numbers are always the ones of
 * Relatórios. Each attendant's numbers and the latest 5 of each group name customers — only for whoever
 * `withDetail` (Gestor and Administrador).
 */
export async function getSatisfactionOverview(params: SatisfactionReportParams, withDetail: boolean): Promise<SatisfactionOverviewDTO> {
  const report = await getSatisfactionReport(params);
  const latestOf = (category: SatisfactionCategory) =>
    report.responses
      .filter((r) => r.category === category)
      .sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""))
      .slice(0, 5);
  return {
    totals: report.totals,
    previous: report.previous,
    currentQuestion: report.currentQuestion,
    settings: report.settings,
    byAgent: withDetail ? report.byAgent : null,
    latest: withDetail ? { detractor: latestOf("detractor"), passive: latestOf("passive"), promoter: latestOf("promoter") } : null,
  };
}

/** Local date/time as dd/mm/aaaa hh:mm for exports — the viewer's clock, not the server's. */
function formatLocal(iso: string | null, tzOffsetMinutes: number): string {
  if (!iso) return "-";
  const d = new Date(new Date(iso).getTime() - tzOffsetMinutes * 60_000);
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

const STATUS_LABEL: Record<SatisfactionResponseDTO["status"], string> = { answered: "Respondida", awaiting: "Aguardando", expired: "Sem resposta" };

/** Rows for the CSV / Excel / PDF export of the answers. */
export function responsesToRows(report: SatisfactionReportDTO, tzOffsetMinutes: number): Record<string, unknown>[] {
  return report.responses.map((r) => ({
    "Enviada em": formatLocal(r.sentAt, tzOffsetMinutes),
    "Respondida em": formatLocal(r.answeredAt, tzOffsetMinutes),
    Cliente: r.contactName ?? "-",
    Telefone: r.contactPhone ?? "-",
    Atendente: r.agentName ?? "-",
    Conexão: r.connectionName,
    Pesquisa: r.surveyName ?? "-",
    Nota: r.score ?? "-",
    "Resposta do cliente": r.answerText ?? "-",
    Classificação: r.category ? CATEGORY_LABEL[r.category] : STATUS_LABEL[r.status],
  }));
}

/** Rows for the export of each attendant's numbers. */
export function agentsToRows(report: SatisfactionReportDTO): Record<string, unknown>[] {
  return report.byAgent.map((a) => ({
    Atendente: a.agentName,
    "Pesquisas enviadas": a.sent,
    Respostas: a.answered,
    "Não responderam": a.unanswered,
    "Taxa de resposta (%)": a.responseRate ?? "-",
    "Nota média": a.average ?? "-",
    "NPS (0 a 100)": a.nps ?? "-",
    "NPS no período anterior": a.previousNps ?? "-",
    Promotores: a.promoters,
    Neutros: a.passives,
    Detratores: a.detractors,
    "Menor nota": a.lowest ?? "-",
    "Maior nota": a.highest ?? "-",
  }));
}
