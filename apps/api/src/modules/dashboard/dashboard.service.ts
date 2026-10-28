import { prisma } from "../../lib/prisma";
import { NO_RETURN_CLOSE_REASON } from "../conversations/conversations.service";
import { firstResponseDiffs, SCHEDULE_SELECT, spanDiffs } from "../../lib/conversation-timings";
import { cachedHolidayLookup } from "../../lib/business-time";
import type { ArrivalsByHourDTO } from "@whatsatendende/types";
import type { Prisma, WorkSchedule } from "@prisma/client";
import { findApplicableHoliday } from "../holidays/holidays.service";
import { isWorkScheduleOpen } from "../work-schedules/work-schedules.service";

function avgMs(diffs: number[]): number | null {
  if (diffs.length === 0) return null;
  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

export interface DashboardParams {
  from: Date;
  to: Date;
  agentId?: string;
  /** Empty/undefined = every WhatsApp connection — see PROMPT: filtro podendo selecionar várias ou todas. */
  connectionIds?: string[];
}

/**
 * "Conversas unicas" (spec section 23): number of distinct contacts with at
 * least one conversation created inside the window — a contact who wrote 30
 * messages in the same conversation still counts once.
 */
export async function getDashboard({ from, to, agentId, connectionIds }: DashboardParams) {
  const connectionFilter = connectionIds === undefined ? undefined : { in: connectionIds };
  const whereBase = {
    createdAt: { gte: from, lte: to },
    // WhatsApp groups never count: they are not customer conversations.
    status: { not: "GROUP" as const },
    ...(agentId ? { assignedAgentId: agentId } : {}),
    ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
  };

  const [conversationsInPeriod, messages, waitingCount] = await Promise.all([
    prisma.conversation.findMany({
      where: whereBase,
      select: {
        id: true,
        contactId: true,
        status: true,
        enteredQueueAt: true,
        acceptedAt: true,
        firstResponseAt: true,
        closedAt: true,
        closeReason: true,
        assignedAgentId: true,
        ...SCHEDULE_SELECT,
      },
    }),
    prisma.message.groupBy({
      by: ["direction"],
      where: {
        createdAt: { gte: from, lte: to },
        conversation: {
          status: { not: "GROUP" as const },          ...(agentId ? { assignedAgentId: agentId } : {}),
          ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
        },
      },
      _count: true,
    }),
    // Unlike every other figure here, "waiting" isn't scoped by the
    // reporting period — a conversation sitting unclaimed in the queue is
    // waiting right now regardless of which day it first entered it (the
    // same reasoning as getUsersSummary's "online" count below), and it's
    // always unassigned by definition, so agentId doesn't apply either.
    // Mirrors listQueue's own filter shape exactly, in
    // conversations.service.ts, which is what "Fila" itself shows.
    prisma.conversation.count({
      where: {
        status: { in: ["NEW", "WAITING"] },
        ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
      },
    }),
  ]);

  const uniqueContacts = new Set(conversationsInPeriod.map((c) => c.contactId)).size;
  const statusCounts = conversationsInPeriod.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  // Only time inside the connection's Horário de expediente counts (business-time.ts).
  const isHoliday = cachedHolidayLookup();
  const [acceptDiffs, handlingDiffs, closingDiffs, firstResponses] = await Promise.all([
    spanDiffs(conversationsInPeriod, (c) => [c.enteredQueueAt, c.acceptedAt], isHoliday),
    spanDiffs(conversationsInPeriod, (c) => [c.acceptedAt, c.closedAt], isHoliday),
    spanDiffs(conversationsInPeriod, (c) => [c.enteredQueueAt, c.closedAt], isHoliday),
    firstResponseDiffs(conversationsInPeriod, isHoliday),
  ]);

  const received = messages.find((m) => m.direction === "INBOUND")?._count ?? 0;
  const sent = messages.find((m) => m.direction === "OUTBOUND")?._count ?? 0;

  const perAgent = await getPerAgentBreakdown(from, to, connectionFilter);
  const users = await getUsersSummary();
  // Same-length window right before this one, for the "vs período anterior" deltas.
  const lengthMs = to.getTime() - from.getTime();
  const previous = await getPeriodTotals({
    from: new Date(from.getTime() - lengthMs - 1),
    to: new Date(from.getTime() - 1),
    agentId,
    connectionIds,
  });

  return {
    conversations: {
      received: conversationsInPeriod.length,
      unique: uniqueContacts,
      inProgress: (statusCounts.IN_PROGRESS ?? 0) + (statusCounts.TRANSFERRED ?? 0),
      closed: statusCounts.CLOSED ?? 0,
      // Part of `closed`, shown apart: closed for "falta de retorno" (the customer stopped answering).
      closedNoReturn: conversationsInPeriod.filter((c) => c.status === "CLOSED" && c.closeReason === NO_RETURN_CLOSE_REASON).length,
      waiting: waitingCount,
    },
    messages: { received, sent, total: received + sent },
    timings: {
      avgAcceptMs: avgMs(acceptDiffs),
      avgFirstResponseMs: avgMs(firstResponses),
      avgHandlingMs: avgMs(handlingDiffs),
      avgClosingMs: avgMs(closingDiffs),
    },
    perAgent,
    users,
    previous,
  };
}

/** The handful of headline numbers the Dashboard compares against the previous period. */
async function getPeriodTotals({ from, to, agentId, connectionIds }: DashboardParams) {
  const connectionFilter = connectionIds === undefined ? undefined : { in: connectionIds };
  const conversationScope = {
    status: { not: "GROUP" as const },
    ...(agentId ? { assignedAgentId: agentId } : {}),
    ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
  };
  const [conversations, messagesTotal] = await Promise.all([
    prisma.conversation.findMany({
      where: { createdAt: { gte: from, lte: to }, ...conversationScope },
      select: { contactId: true, status: true, acceptedAt: true, firstResponseAt: true, ...SCHEDULE_SELECT },
    }),
    prisma.message.count({ where: { createdAt: { gte: from, lte: to }, conversation: conversationScope } }),
  ]);
  return {
    received: conversations.length,
    unique: new Set(conversations.map((c) => c.contactId)).size,
    closed: conversations.filter((c) => c.status === "CLOSED").length,
    messagesTotal,
    avgFirstResponseMs: avgMs(await firstResponseDiffs(conversations)),
  };
}

/**
 * "Equipe agora" + per-agent presence durations. `now` is a live snapshot of
 * every active user (not scoped to the period); `agents` sums each AGENT's
 * Online and Paused time inside the period from AgentStatusLog.
 */
export async function getTeam({ from, to, agentId }: { from: Date; to: Date; agentId?: string }) {
  const now = new Date();
  const [users, openPauses, agents, logs] = await Promise.all([
    // "Equipe agora" counts attendants only — gestores and administradores are not part of the team on duty.
    prisma.user.findMany({
      where: { status: "ACTIVE", role: "AGENT" },
      select: { id: true, displayName: true, photoUrl: true, presence: true, pauseReason: { select: { name: true } } },
    }),
    prisma.agentStatusLog.findMany({ where: { status: "AWAY", endedAt: null }, select: { userId: true, startedAt: true } }),
    prisma.user.findMany({
      where: { role: "AGENT", status: "ACTIVE", ...(agentId ? { id: agentId } : {}) },
      select: { id: true, displayName: true, photoUrl: true, presence: true, pauseReason: { select: { name: true } } },
      orderBy: { displayName: "asc" },
    }),
    prisma.agentStatusLog.findMany({
      where: {
        status: { in: ["ONLINE", "AWAY"] },
        startedAt: { lt: to },
        OR: [{ endedAt: null }, { endedAt: { gt: from } }],
        user: { role: "AGENT", ...(agentId ? { id: agentId } : {}) },
      },
      select: { userId: true, status: true, startedAt: true, endedAt: true },
    }),
  ]);

  const pausedSince = new Map<string, Date>();
  for (const p of openPauses) {
    const current = pausedSince.get(p.userId);
    if (!current || p.startedAt < current) pausedSince.set(p.userId, p.startedAt);
  }

  const durations = new Map<string, { onlineMs: number; pausedMs: number }>();
  const windowEnd = Math.min(to.getTime(), now.getTime());
  for (const log of logs) {
    const start = Math.max(log.startedAt.getTime(), from.getTime());
    const end = Math.min((log.endedAt ?? now).getTime(), windowEnd);
    if (end <= start) continue;
    const entry = durations.get(log.userId) ?? { onlineMs: 0, pausedMs: 0 };
    if (log.status === "ONLINE") entry.onlineMs += end - start;
    else entry.pausedMs += end - start;
    durations.set(log.userId, entry);
  }

  const paused = users.filter((u) => u.presence === "AWAY");
  return {
    now: {
      online: users.filter((u) => u.presence === "ONLINE").length,
      paused: paused.length,
      offline: users.filter((u) => u.presence === "OFFLINE").length,
      pausedUsers: paused
        .map((u) => ({
          userId: u.id,
          name: u.displayName,
          photoUrl: u.photoUrl,
          reasonName: u.pauseReason?.name ?? null,
          since: pausedSince.get(u.id)?.toISOString() ?? null,
        }))
        .sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "")),
    },
    agents: agents.map((a) => ({
      agentId: a.id,
      agentName: a.displayName,
      photoUrl: a.photoUrl,
      presence: a.presence,
      pauseReasonName: a.presence === "AWAY" ? (a.pauseReason?.name ?? null) : null,
      onlineMs: durations.get(a.id)?.onlineMs ?? 0,
      pausedMs: durations.get(a.id)?.pausedMs ?? 0,
    })),
  };
}

// A snapshot of right now, not scoped to the reporting period — "how many
// users are online" is inherently a current-moment question, not a
// historical one like the rest of this dashboard.
async function getUsersSummary() {
  const [online, active, total] = await Promise.all([
    // Attendants only, like every figure of the Dashboard.
    prisma.user.count({ where: { role: "AGENT", presence: "ONLINE" } }),
    prisma.user.count({ where: { role: "AGENT", status: "ACTIVE" } }),
    prisma.user.count({ where: { role: "AGENT" } }),
  ]);
  return { online, active, total };
}

async function getPerAgentBreakdown(from: Date, to: Date, connectionFilter?: { in: string[] }) {
  const agents = await prisma.user.findMany({ where: { role: "AGENT" }, select: { id: true, displayName: true } });

  const results = await Promise.all(
    agents.map(async (agent) => {
      const conversations = await prisma.conversation.findMany({
        where: { assignedAgentId: agent.id, createdAt: { gte: from, lte: to }, ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}) },
        select: { id: true, status: true, closeReason: true, acceptedAt: true, closedAt: true, enteredQueueAt: true, ...SCHEDULE_SELECT },
      });
      const sentCount = await prisma.message.count({
        where: {
          senderAgentId: agent.id,
          createdAt: { gte: from, lte: to },
          conversation: { status: { not: "GROUP" as const }, ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}) },
        },
      });
      // Inbound messages inside this agent's own conversations — not
      // "messages sent to this agent specifically" (WhatsApp has no such
      // concept), the same scoping the rest of this breakdown already uses.
      // See PROMPT: "separe gráficos... de mensagens enviadas/recebidas por
      // atendentes".
      const receivedCount = await prisma.message.count({
        where: {
          direction: "INBOUND",
          createdAt: { gte: from, lte: to },
          conversation: { assignedAgentId: agent.id, ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}) },
        },
      });
      const handlingDiffs = await spanDiffs(conversations, (c) => [c.acceptedAt, c.closedAt]);

      return {
        agentId: agent.id,
        agentName: agent.displayName,
        conversations: conversations.length,
        closedNoReturn: conversations.filter((c) => c.status === "CLOSED" && c.closeReason === NO_RETURN_CLOSE_REASON).length,
        messagesSent: sentCount,
        messagesReceived: receivedCount,
        avgHandlingMs: avgMs(handlingDiffs),
      };
    })
  );

  return results.filter((r) => r.conversations > 0 || r.messagesSent > 0);
}

// Common Portuguese function words (articles, prepositions, pronouns,
// conjunctions, auxiliary verb forms, generic fillers) — excluded from the
// Dashboard's word cloud so it surfaces what customers are actually asking
// about instead of the words every sentence has anyway. Not exhaustive by
// design: a short, high-frequency list is enough to keep the cloud useful.
const WORD_CLOUD_STOPWORDS = new Set([
  "a", "o", "as", "os", "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
  "um", "uma", "uns", "umas", "para", "pra", "pro", "por", "com", "sem", "que", "se",
  "e", "ou", "mas", "como", "mais", "menos", "muito", "muita", "muitos", "muitas",
  "já", "so", "só", "ainda", "tambem", "também", "ate", "até", "pelo", "pela", "pelos",
  "pelas", "ao", "aos", "eu", "tu", "ele", "ela", "nos", "nós", "vos", "eles",
  "elas", "me", "te", "lhe", "lhes", "meu", "minha", "meus", "minhas", "teu", "tua",
  "teus", "tuas", "seu", "sua", "seus", "suas", "nosso", "nossa", "nossos", "nossas",
  "isso", "isto", "aquilo", "este", "esta", "estes", "estas", "esse", "essa", "esses",
  "essas", "aquele", "aquela", "aqueles", "aquelas", "qual", "quais", "quando", "onde",
  "quem", "cujo", "cuja", "cujos", "cujas", "nao", "não", "sim", "foi", "ser",
  "estar", "está", "estou", "estão", "estao", "tem", "têm", "ter", "tinha",
  "vai", "vou", "vamos", "vao", "vão", "pode", "podem", "posso", "consegue", "consigo",
  "fazer", "faz", "fez", "dia", "dias", "hoje", "ontem", "amanha", "amanhã", "aqui",
  "ali", "la", "lá", "bom", "boa", "bem", "ola", "olá", "oi", "tudo", "ta", "tá", "num",
  "numa", "voce", "você", "voces", "vocês", "sr", "sra",
]);

function tokenizeForWordCloud(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ") // strip links before splitting
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !WORD_CLOUD_STOPWORDS.has(word));
}

/**
 * Top ~40 words from messages the customer sent (never the agent's own
 * replies) in the selected period — same filters as the rest of the
 * Dashboard. See PROMPT: "nuvem das palavras ou frases que os clientes mais
 * escreveram". Capped at WORD_CLOUD_MESSAGE_LIMIT messages scanned so a
 * very large date range can't turn this into an unbounded full-table scan.
 */
const WORD_CLOUD_MESSAGE_LIMIT = 20_000;
const WORD_CLOUD_TOP_N = 40;

// ---------------------------------------------------------------------------
// "Presença ao longo do dia" (Dashboard section 8): for each hour-of-day
// (0-23), how many distinct agent/day occurrences were Online vs Paused
// (broken down by pause reason) during that hour across the selected
// period. Built from AgentStatusLog, the per-transition history that feeds
// this chart (see presence-status.ts) — before that table existed, only the
// *current* presence was known, never when a change happened.
// ---------------------------------------------------------------------------

const OTHER_PAUSE_REASON_LABEL = "Outros motivos";
// Defensive cap on how many hour-cells a single log segment can touch —
// comfortably above any real shift length, just in case a row is ever left
// open for an unexpectedly long time (e.g. a crashed disconnect timer).
const MAX_HOUR_CELLS_PER_SEGMENT = 24 * 62;

/** Every local hour-of-day cell `[startUtc, endUtc)` touches, as `{dateKey, hour}` — dateKey disambiguates the same hour-of-day across different calendar days. */
function iterateHourCells(startUtc: Date, endUtc: Date, tzOffsetMinutes: number): { dateKey: string; hour: number }[] {
  const offsetMs = tzOffsetMinutes * 60_000;
  const cells: { dateKey: string; hour: number }[] = [];
  let cursor = new Date(startUtc.getTime() - offsetMs);
  const endLocal = new Date(endUtc.getTime() - offsetMs);
  let guard = 0;
  while (cursor < endLocal && guard < MAX_HOUR_CELLS_PER_SEGMENT) {
    cells.push({ dateKey: cursor.toISOString().slice(0, 10), hour: cursor.getUTCHours() });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), cursor.getUTCHours() + 1));
    guard++;
  }
  return cells;
}

export interface PresenceByHourParams {
  from: Date;
  to: Date;
  agentId?: string;
  tzOffsetMinutes: number;
}

export async function getPresenceByHour({ from, to, agentId, tzOffsetMinutes }: PresenceByHourParams) {
  const now = new Date();
  const logs = await prisma.agentStatusLog.findMany({
    where: {
      status: { in: ["ONLINE", "AWAY"] },
      startedAt: { lt: to },
      OR: [{ endedAt: null }, { endedAt: { gt: from } }],
      user: { role: "AGENT", ...(agentId ? { id: agentId } : {}) },
    },
    select: { userId: true, status: true, startedAt: true, endedAt: true, pauseReason: { select: { name: true } } },
  });

  // Dedup per (agent, calendar day, hour, bucket) — a reconnect every ~15min
  // (presence-tracker's access-token refresh) closes and reopens the ONLINE
  // log back-to-back, which would otherwise inflate the same hour's count
  // several times over for one agent who was online the whole time.
  const touched = new Set<string>();
  const countsByHour: Record<number, Record<string, number>> = {};
  for (let h = 0; h < 24; h++) countsByHour[h] = {};

  for (const log of logs) {
    const bucket = log.status === "ONLINE" ? "Online" : log.pauseReason?.name ?? OTHER_PAUSE_REASON_LABEL;
    const segStart = Math.max(log.startedAt.getTime(), from.getTime());
    const segEnd = Math.min((log.endedAt ?? now).getTime(), to.getTime(), now.getTime());
    if (segEnd <= segStart) continue;

    for (const cell of iterateHourCells(new Date(segStart), new Date(segEnd), tzOffsetMinutes)) {
      const key = `${log.userId}|${cell.dateKey}|${cell.hour}|${bucket}`;
      if (touched.has(key)) continue;
      touched.add(key);
      countsByHour[cell.hour][bucket] = (countsByHour[cell.hour][bucket] ?? 0) + 1;
    }
  }

  // "Online" always first, then every pause reason seen — by total count
  // descending so the biggest bar segments legend first, "Outros motivos"
  // (if present) always last since it's a catch-all, not a real reason.
  const reasonTotals = new Map<string, number>();
  for (const hourCounts of Object.values(countsByHour)) {
    for (const [bucket, count] of Object.entries(hourCounts)) {
      if (bucket === "Online") continue;
      reasonTotals.set(bucket, (reasonTotals.get(bucket) ?? 0) + count);
    }
  }
  const reasons = Array.from(reasonTotals.entries())
    .sort((a, b) => (a[0] === OTHER_PAUSE_REASON_LABEL ? 1 : b[0] === OTHER_PAUSE_REASON_LABEL ? -1 : b[1] - a[1]))
    .map(([name]) => name);
  const series = ["Online", ...reasons];

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, counts: countsByHour[hour] }));
  return { series, hours };
}

/**
 * "Conversas que chegam ao longo do dia": each new conversation the customer opened (its first message is the
 * customer's — not one an attendant started or the phone sent), counted at the hour of that message, split by the
 * connection's Horário de expediente; plus the attendants online in each hour, averaged over the period's days.
 */
/** The conversations Gestão lists for the same filters — no groups, Instagram/Messenger whatever the connection filter. */
function gestaoScope({ agentId, connectionIds }: Pick<DashboardParams, "agentId" | "connectionIds">): Prisma.ConversationWhereInput {
  return {
    status: { not: "GROUP" },
    ...(agentId ? { assignedAgentId: agentId } : {}),
    OR: [{ channel: "WHATSAPP", whatsappConnectionId: connectionIds === undefined ? undefined : { in: connectionIds } }, { channel: { not: "WHATSAPP" } }],
  };
}

/** The conversations the customer opened in the period (their first message is the customer's), with when. */
async function customerArrivals({ from, to, agentId, connectionIds }: Pick<DashboardParams, "from" | "to" | "agentId" | "connectionIds">) {
  const conversations = await prisma.conversation.findMany({
    where: { createdAt: { gte: from, lte: to }, ...gestaoScope({ agentId, connectionIds }) },
    select: {
      id: true,
      whatsappConnection: { select: { workSchedule: true } },
      metaConnection: { select: { workSchedule: true } },
      messages: { orderBy: { createdAt: "asc" }, take: 1, select: { direction: true, createdAt: true } },
    },
  });
  return conversations.flatMap((c) => {
    const first = c.messages[0];
    if (!first || first.direction !== "INBOUND") return [];
    const schedule: WorkSchedule | null = c.whatsappConnection?.workSchedule ?? c.metaConnection?.workSchedule ?? null;
    return [{ id: c.id, at: first.createdAt, schedule }];
  });
}

const localHour = (at: Date, tzOffsetMinutes: number) => new Date(at.getTime() - tzOffsetMinutes * 60_000).getUTCHours();

/** Gestão's list behind a bar of the chart: the conversations the customer opened in the period — at `hour`, when given. */
export async function customerArrivalIds(params: Pick<DashboardParams, "from" | "to" | "agentId" | "connectionIds">, hour: number | undefined, tzOffsetMinutes: number): Promise<string[]> {
  const arrivals = await customerArrivals(params);
  return arrivals.filter((a) => hour === undefined || localHour(a.at, tzOffsetMinutes) === hour).map((a) => a.id);
}

export async function getArrivalsByHour({ from, to, agentId, connectionIds, tzOffsetMinutes }: DashboardParams & { tzOffsetMinutes: number }): Promise<ArrivalsByHourDTO> {
  const now = new Date();
  const scope = gestaoScope({ agentId, connectionIds });
  const inPeriod = { gte: from, lte: to };
  const [arrivals, withActivity, createdInPeriod, logs] = await Promise.all([
    customerArrivals({ from, to, agentId, connectionIds }),
    // The same count as Gestão's list for the period: anything happened in it (opened, a message, closed).
    prisma.conversation.count({ where: { AND: [scope, { OR: [{ createdAt: inPeriod }, { lastMessageAt: inPeriod }, { closedAt: inPeriod }] }] } }),
    prisma.conversation.count({ where: { AND: [scope, { createdAt: inPeriod }] } }),
    prisma.agentStatusLog.findMany({
      where: {
        status: "ONLINE",
        startedAt: { lt: to },
        OR: [{ endedAt: null }, { endedAt: { gt: from } }],
        user: { role: "AGENT", ...(agentId ? { id: agentId } : {}) },
      },
      select: { userId: true, startedAt: true, endedAt: true },
    }),
  ]);

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, inside: 0, outside: 0, onlineAvg: 0, days: 0 }));
  const holidays = new Map<string, Promise<unknown>>();
  const cachedHoliday = (dateKey: string, state: string, city: string) => {
    const key = `${dateKey}|${state}|${city}`;
    if (!holidays.has(key)) holidays.set(key, findApplicableHoliday(dateKey, state, city));
    return holidays.get(key)!;
  };
  for (const arrival of arrivals) {
    const inside = !arrival.schedule || (await isWorkScheduleOpen(arrival.schedule, arrival.at, cachedHoliday));
    hours[localHour(arrival.at, tzOffsetMinutes)][inside ? "inside" : "outside"]++;
  }

  // Each attendant counts once per (day, hour) they were online in it — the same dedup as getPresenceByHour.
  const touched = new Set<string>();
  const onlineByHour = Array<number>(24).fill(0);
  for (const log of logs) {
    const segStart = Math.max(log.startedAt.getTime(), from.getTime());
    const segEnd = Math.min((log.endedAt ?? now).getTime(), to.getTime(), now.getTime());
    if (segEnd <= segStart) continue;
    for (const cell of iterateHourCells(new Date(segStart), new Date(segEnd), tzOffsetMinutes)) {
      const key = `${log.userId}|${cell.dateKey}|${cell.hour}`;
      if (touched.has(key)) continue;
      touched.add(key);
      onlineByHour[cell.hour]++;
    }
  }
  // How many of the period's days reach each hour ("Hoje" stops at now) — the average divides by these.
  for (const cell of iterateHourCells(from, new Date(Math.min(to.getTime(), now.getTime())), tzOffsetMinutes)) hours[cell.hour].days++;
  for (const h of hours) h.onlineAvg = h.days ? Math.round((onlineByHour[h.hour] / h.days) * 10) / 10 : 0;
  // Why Gestão shows more: it also lists the conversations the team started and the ones from earlier days that moved.
  const summary = {
    withActivity,
    openedByCustomer: arrivals.length,
    startedByTeam: createdInPeriod - arrivals.length,
    fromEarlierDays: withActivity - createdInPeriod,
  };
  return { hours, summary };
}

/** One row per hour for Relatórios' exports (CSV/PDF/Excel) — the same columns as the screen's table. */
export function arrivalsToRows(data: ArrivalsByHourDTO): Record<string, unknown>[] {
  const decimal = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return data.hours.map((h) => ({
    Hora: `${String(h.hour).padStart(2, "0")}h`,
    "Dentro do expediente": h.inside,
    "Fora do expediente": h.outside,
    Total: h.inside + h.outside,
    "Média por dia": h.days ? decimal((h.inside + h.outside) / h.days) : "0",
    "Atendentes online (média)": decimal(h.onlineAvg),
  }));
}

export async function getWordCloud({ from, to, agentId, connectionIds }: DashboardParams): Promise<{ word: string; count: number }[]> {
  const connectionFilter = connectionIds === undefined ? undefined : { in: connectionIds };
  const messages = await prisma.message.findMany({
    where: {
      direction: "INBOUND",
      body: { not: null },
      createdAt: { gte: from, lte: to },
      conversation: {
        status: { not: "GROUP" as const },
        ...(agentId ? { assignedAgentId: agentId } : {}),
        ...(connectionFilter ? { whatsappConnectionId: connectionFilter } : {}),
      },
    },
    select: { body: true },
    take: WORD_CLOUD_MESSAGE_LIMIT,
  });

  const counts = new Map<string, number>();
  for (const { body } of messages) {
    for (const word of tokenizeForWordCloud(body!)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, WORD_CLOUD_TOP_N)
    .map(([word, count]) => ({ word, count }));
}
