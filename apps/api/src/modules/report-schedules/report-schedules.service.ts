import type { Prisma, ReportSchedule } from "@prisma/client";
import {
  REPORT_SCHEDULE_FREQUENCY_LABEL,
  type ReportScheduleAlerts,
  type ReportScheduleConflictDTO,
  type ReportScheduleDTO,
  type ReportScheduleInput,
  type ReportScheduleRunDTO,
  type ReportScheduleSaveResultDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { Errors } from "../../lib/http-error";
import { composeCustomMail, sendMailExtended } from "../../lib/mail";
import { getEmailSettings } from "../settings/settings.service";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { sendSystemNotice } from "../whatsapp/whatsapp.service";
import { availability as smsAvailability, sendSms } from "../sms/sms.service";
import { buildScheduledDeck, type BuiltDeck } from "./report-deck";
import { localDay, nextSend, sendDays, type HolidayCheck } from "./schedule-dates";

/**
 * Agendamento da apresentação: the Dashboard's PowerPoint e-mailed on a schedule. A failed send is tried again 5 and
 * 15 minutes later; when the third try also fails (or the server refuses some recipients) the people in the schedule's
 * alerts hear about it — inside the system, by e-mail, WhatsApp and SMS. The file is never stored.
 */

const RETRY_DELAYS_MIN = [5, 15];
const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;
const CONFLICT_HORIZON_DAYS = 366;

export const DEFAULT_SCHEDULE_TEXT = {
  subject: "Relatório de atendimento — {{periodo}}",
  title: "Relatório de atendimento",
  bodyText:
    "Olá!\n\nSegue em anexo a apresentação do Dashboard com os números do período {{periodo}} ({{datas}}).\nFiltros: {{escopo}}.\n\nEste e-mail é enviado automaticamente pelo agendamento \"{{agendamento}}\".",
};

export const SCHEDULE_TAGS = [
  { tag: "{{periodo}}", description: "Nome do período da apresentação (ex.: Mês anterior)" },
  { tag: "{{datas}}", description: "Os dias que o período cobre (ex.: outubro de 2026)" },
  { tag: "{{escopo}}", description: "Conexões e atendentes filtrados" },
  { tag: "{{agendamento}}", description: "Nome deste agendamento" },
  { tag: "{{data_envio}}", description: "Data do envio (dd/mm/aaaa)" },
];

// ------------------------------------------------------------ holidays

/** Every holiday of the cadastro (dated or repeating every year) — the schedule respects only the cadastro. */
async function holidayCheck(): Promise<HolidayCheck> {
  const [dated, yearly] = await Promise.all([
    prisma.holiday.findMany({ where: { recurringYearly: false }, select: { date: true } }),
    prisma.holiday.findMany({ where: { recurringYearly: true }, select: { monthDay: true } }),
  ]);
  const days = new Set(dated.filter((h) => h.date).map((h) => h.date!.toISOString().slice(0, 10)));
  const monthDays = new Set(yearly.map((h) => h.monthDay).filter(Boolean) as string[]);
  return (day) => days.has(day) || monthDays.has(day.slice(5));
}

// ------------------------------------------------------------ mapping

function alertsOf(row: Pick<ReportSchedule, "alerts">): ReportScheduleAlerts {
  const a = (row.alerts ?? {}) as Partial<ReportScheduleAlerts>;
  return { emails: a.emails ?? [], whatsapp: a.whatsapp ?? null, sms: a.sms ?? null };
}

async function toDTOs(rows: ReportSchedule[]): Promise<ReportScheduleDTO[]> {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, displayName: true } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    subject: r.subject,
    title: r.title,
    bodyText: r.bodyText,
    to: r.to,
    cc: r.cc,
    frequency: r.frequency,
    time: r.time,
    tzOffsetMinutes: r.tzOffsetMinutes,
    startDate: r.startDate,
    weekdays: r.weekdays,
    monthDay: r.monthDay,
    month: r.month,
    customInterval: r.customInterval,
    customUnit: r.customUnit as ReportScheduleDTO["customUnit"],
    endType: r.endType as ReportScheduleDTO["endType"],
    endAfter: r.endAfter,
    endDate: r.endDate,
    skipSaturday: r.skipSaturday,
    skipSunday: r.skipSunday,
    period: r.period as ReportScheduleDTO["period"],
    agentId: r.agentId,
    connectionIds: r.connectionIds,
    alerts: alertsOf(r),
    nextRunAt: r.enabled ? (r.retryAt ?? r.nextRunAt)?.toISOString() ?? null : null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    runCount: r.runCount,
    createdByName: users.find((u) => u.id === r.createdById)?.displayName ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function list(): Promise<ReportScheduleDTO[]> {
  return toDTOs(await prisma.reportSchedule.findMany({ orderBy: [{ enabled: "desc" }, { name: "asc" }] }));
}

async function find(id: string): Promise<ReportSchedule> {
  const row = await prisma.reportSchedule.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Agendamento não encontrado");
  return row;
}

export async function get(id: string): Promise<ReportScheduleDTO> {
  return (await toDTOs([await find(id)]))[0];
}

export async function runs(id: string): Promise<ReportScheduleRunDTO[]> {
  const rows = await prisma.reportScheduleRun.findMany({ where: { scheduleId: id }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((r) => ({
    id: r.id,
    scheduledFor: r.scheduledFor.toISOString(),
    createdAt: r.createdAt.toISOString(),
    attempt: r.attempt,
    manual: r.manual,
    status: r.status,
    recipients: r.recipients,
    rejected: r.rejected,
    error: r.error,
  }));
}

// ------------------------------------------------------------ saving

const unique = (list: string[]) => [...new Set(list.map((e) => e.trim().toLowerCase()).filter(Boolean))];

function data(input: ReportScheduleInput) {
  const to = unique(input.to);
  if (to.length === 0) throw Errors.badRequest("Informe pelo menos um destinatário.");
  if (input.endType === "ON_DATE" && input.endDate && input.endDate < input.startDate) throw Errors.badRequest("A data de término precisa ser depois do início.");
  return {
    name: input.name.trim(),
    enabled: input.enabled,
    subject: input.subject,
    title: input.title,
    bodyText: input.bodyText,
    to,
    cc: unique(input.cc).filter((e) => !to.includes(e)),
    frequency: input.frequency,
    time: input.time,
    tzOffsetMinutes: input.tzOffsetMinutes,
    startDate: input.startDate,
    weekdays: [...new Set(input.weekdays)].sort(),
    monthDay: input.monthDay,
    month: input.month,
    customInterval: Math.max(1, input.customInterval),
    customUnit: input.customUnit,
    endType: input.endType,
    endAfter: input.endType === "AFTER" ? input.endAfter : null,
    endDate: input.endType === "ON_DATE" ? input.endDate : null,
    skipSaturday: input.skipSaturday,
    skipSunday: input.skipSunday,
    period: input.period,
    agentId: input.agentId,
    connectionIds: input.connectionIds,
    alerts: {
      emails: unique(input.alerts.emails),
      whatsapp: input.alerts.whatsapp?.connectionId && input.alerts.whatsapp.phones.length ? input.alerts.whatsapp : null,
      sms: input.alerts.sms?.phones.length ? input.alerts.sms : null,
    } as unknown as Prisma.InputJsonValue,
  };
}

/** Other enabled schedules that send on one of the same days to someone in common (To or CC) — only a warning. */
async function conflictsFor(row: ReportSchedule, isHoliday: HolidayCheck): Promise<ReportScheduleConflictDTO[]> {
  if (!row.enabled) return [];
  const mine = new Set([...row.to, ...row.cc]);
  const now = new Date();
  const myDays = new Set(sendDays(row, now, CONFLICT_HORIZON_DAYS, isHoliday, row.runCount));
  const others = await prisma.reportSchedule.findMany({ where: { enabled: true, id: { not: row.id } } });
  const out: ReportScheduleConflictDTO[] = [];
  for (const other of others) {
    const common = [...other.to, ...other.cc].filter((e) => mine.has(e));
    if (common.length === 0) continue;
    const day = sendDays(other, now, CONFLICT_HORIZON_DAYS, isHoliday, other.runCount).find((d) => myDays.has(d));
    if (day) out.push({ scheduleId: other.id, name: other.name, day, recipients: [...new Set(common)] });
  }
  return out;
}

/**
 * Recipients outside the company: domains other than the SMTP sender's and the users' own. The slide with names of who
 * hasn't confirmed a notice goes along, so the form asks before saving — it never blocks.
 */
async function externalRecipients(row: ReportSchedule): Promise<string[]> {
  const [smtp, users] = await Promise.all([getEmailSettings(), prisma.user.findMany({ where: { status: "ACTIVE" }, select: { email: true } })]);
  const domain = (e: string) => e.split("@")[1]?.toLowerCase() ?? "";
  const internal = new Set([domain(smtp?.fromEmail ?? ""), ...users.map((u) => domain(u.email))].filter(Boolean));
  return [...row.to, ...row.cc].filter((e) => !internal.has(domain(e)));
}

async function schedule(row: ReportSchedule, isHoliday: HolidayCheck): Promise<ReportSchedule> {
  const next = row.enabled ? nextSend(row, new Date(), isHoliday, row.runCount) : null;
  return prisma.reportSchedule.update({ where: { id: row.id }, data: { nextRunAt: next, retryAt: null, retryAttempt: 0, retryFor: null } });
}

async function saveResult(row: ReportSchedule, isHoliday: HolidayCheck): Promise<ReportScheduleSaveResultDTO> {
  return { schedule: (await toDTOs([row]))[0], conflicts: await conflictsFor(row, isHoliday), externalRecipients: await externalRecipients(row) };
}

export async function create(input: ReportScheduleInput, userId: string): Promise<ReportScheduleSaveResultDTO> {
  const isHoliday = await holidayCheck();
  const row = await prisma.reportSchedule.create({ data: { ...data(input), createdById: userId } });
  return saveResult(await schedule(row, isHoliday), isHoliday);
}

export async function update(id: string, input: ReportScheduleInput, userId: string): Promise<ReportScheduleSaveResultDTO> {
  await find(id);
  const isHoliday = await holidayCheck();
  const row = await prisma.reportSchedule.update({ where: { id }, data: { ...data(input), updatedById: userId } });
  return saveResult(await schedule(row, isHoliday), isHoliday);
}

/** The warnings for a schedule being edited, before saving — same rules as a save. */
export async function check(input: ReportScheduleInput, id: string | null): Promise<Omit<ReportScheduleSaveResultDTO, "schedule"> & { upcoming: string[] }> {
  const isHoliday = await holidayCheck();
  const draft = { ...data(input), id: id ?? "draft", runCount: id ? (await find(id)).runCount : 0 } as unknown as ReportSchedule;
  // The next sends as the form describes them — already moved past holidays and skipped weekends.
  const upcoming: string[] = [];
  let cursor = new Date();
  for (let i = 0; i < 5; i++) {
    const next = nextSend(draft, cursor, isHoliday, draft.runCount + i);
    if (!next) break;
    upcoming.push(next.toISOString());
    cursor = next;
  }
  return { conflicts: await conflictsFor(draft, isHoliday), externalRecipients: await externalRecipients(draft), upcoming };
}

/** The e-mail as it goes out, with sample values for the tags — the form's live preview. */
export async function emailPreview(subject: string, title: string, bodyText: string) {
  return composeCustomMail(subject, title, bodyText, {
    periodo: "Últimos 7 dias",
    datas: "22/10 a 28/10/2026",
    escopo: "Todas as conexões · todos os atendentes",
    agendamento: "Diretoria — semanal",
    data_envio: "29/10/2026",
  });
}

export async function duplicate(id: string, userId: string): Promise<ReportScheduleDTO> {
  const source = await find(id);
  const isHoliday = await holidayCheck();
  const row = await prisma.reportSchedule.create({
    data: {
      ...data((await toDTOs([source]))[0]),
      name: `${source.name} (cópia)`,
      enabled: false,
      createdById: userId,
    },
  });
  return (await toDTOs([await schedule(row, isHoliday)]))[0];
}

export async function setEnabled(id: string, enabled: boolean, userId: string): Promise<ReportScheduleDTO> {
  await find(id);
  const row = await prisma.reportSchedule.update({ where: { id }, data: { enabled, updatedById: userId } });
  return (await toDTOs([await schedule(row, await holidayCheck())]))[0];
}

export async function remove(id: string): Promise<void> {
  await find(id);
  await prisma.reportSchedule.delete({ where: { id } });
}

// ------------------------------------------------------------ sending

function formatDay(day: string): string {
  return day.split("-").reverse().join("/");
}

async function sendDeck(row: ReportSchedule, deck: BuiltDeck) {
  const vars = {
    periodo: deck.periodName,
    datas: deck.periodDates,
    escopo: deck.scopeLabel,
    agendamento: row.name,
    data_envio: formatDay(localDay(new Date(), row.tzOffsetMinutes)),
  };
  const mail = await composeCustomMail(row.subject, row.title, row.bodyText, vars);
  return sendMailExtended({
    to: row.to,
    cc: row.cc,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: [{ filename: deck.fileName, content: deck.buffer, contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
  });
}

/** One try of a send: builds the deck in memory, e-mails it and drops it. */
async function attempt(row: ReportSchedule): Promise<{ ok: boolean; rejected: string[]; error: string | null }> {
  try {
    const deck = await buildScheduledDeck(row);
    const result = await sendDeck(row, deck);
    if (!result.sent) return { ok: false, rejected: result.rejected, error: result.reason ?? "Falha ao enviar o e-mail" };
    return { ok: true, rejected: result.rejected, error: null };
  } catch (err) {
    logger.error({ err, scheduleId: row.id }, "scheduled presentation failed");
    return { ok: false, rejected: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function alertFailure(row: ReportSchedule, problem: string, rejected: string[]): Promise<void> {
  const alerts = alertsOf(row);
  const partial = rejected.length > 0 && !problem;
  const title = partial ? `Apresentação agendada: alguns e-mails não receberam` : `Falha no envio da apresentação agendada`;
  const detail = partial ? `O servidor de e-mail recusou: ${rejected.join(", ")}.` : `${problem}${rejected.length ? ` Recusados: ${rejected.join(", ")}.` : ""}`;
  const message = `${title} — "${row.name}" (${REPORT_SCHEDULE_FREQUENCY_LABEL[row.frequency].toLowerCase()}). ${detail}`;

  // Inside the system: whoever created it and every administrator.
  const admins = await prisma.user.findMany({ where: { status: "ACTIVE", OR: [{ role: "ADMIN" }, { id: row.createdById }] }, select: { id: true } });
  for (const { id } of admins) {
    const notification = await createNotification({ userId: id, type: "REPORT_SCHEDULE_FAILED", title, body: `"${row.name}": ${detail}`, entityType: "ReportSchedule", entityId: row.id });
    realtimeEvents.notificationCreated(id, toNotificationDTO(notification));
  }
  // Each channel on its own: one that fails (the SMTP that just failed, a WhatsApp offline) never stops the others.
  if (alerts.emails.length) {
    const mail = await composeCustomMail(title, title, `${message}\n\nConfira em Configurações › Modelos de e-mail › Agendamento da apresentação.`, {});
    await sendMailExtended({ to: alerts.emails, subject: mail.subject, html: mail.html, text: mail.text }).catch((err) => logger.warn({ err }, "alert e-mail failed"));
  }
  if (alerts.whatsapp) {
    for (const phone of alerts.whatsapp.phones) {
      await sendSystemNotice(alerts.whatsapp.connectionId, phone, `⚠️ *${title}*\n\n${message}`).catch((err) => logger.warn({ err, phone }, "alert WhatsApp failed"));
    }
  }
  if (alerts.sms && (await smsAvailability()).available) {
    for (const phone of alerts.sms.phones) {
      await sendSms(phone, message.slice(0, 300)).catch((err) => logger.warn({ err, phone }, "alert SMS failed"));
    }
  }
}

async function record(row: ReportSchedule, scheduledFor: Date, attemptNo: number, status: ReportScheduleRunDTO["status"], rejected: string[], error: string | null, manual = false) {
  await prisma.reportScheduleRun.create({
    data: { scheduleId: row.id, scheduledFor, attempt: attemptNo, manual, status, recipients: [...row.to, ...row.cc], rejected, error },
  });
}

/** A due send (or one of its retries). Moves the schedule to its next date unless a retry is still pending. */
async function runDue(row: ReportSchedule, isHoliday: HolidayCheck): Promise<void> {
  const retrying = row.retryAt !== null;
  const scheduledFor = retrying ? row.retryFor ?? row.retryAt! : row.nextRunAt!;
  const attemptNo = retrying ? row.retryAttempt + 1 : 1;
  // Claim it first, so a slow send is never picked up twice by the next sweep.
  const claimed = await prisma.reportSchedule.updateMany({
    where: { id: row.id, ...(retrying ? { retryAt: row.retryAt } : { nextRunAt: row.nextRunAt, retryAt: null }) },
    data: retrying ? { retryAt: null } : { nextRunAt: null },
  });
  if (claimed.count === 0) return;

  const result = await attempt(row);
  const now = new Date();
  if (!result.ok && attemptNo < MAX_ATTEMPTS) {
    await record(row, scheduledFor, attemptNo, "RETRYING", result.rejected, result.error);
    await prisma.reportSchedule.update({
      where: { id: row.id },
      data: { retryAt: new Date(now.getTime() + RETRY_DELAYS_MIN[attemptNo - 1] * 60_000), retryAttempt: attemptNo, retryFor: scheduledFor, lastStatus: "RETRYING", lastError: result.error, lastRunAt: now },
    });
    return;
  }
  const status = !result.ok ? "FAILED" : result.rejected.length ? "PARTIAL" : "SENT";
  await record(row, scheduledFor, attemptNo, status, result.rejected, result.error);
  const runCount = row.runCount + 1;
  const next = nextSend(row, scheduledFor, isHoliday, runCount);
  await prisma.reportSchedule.update({
    where: { id: row.id },
    data: { runCount, lastRunAt: now, lastStatus: status, lastError: result.error, nextRunAt: next, retryAt: null, retryAttempt: 0, retryFor: null },
  });
  if (status !== "SENT") await alertFailure(row, result.ok ? "" : (result.error ?? "Falha no envio"), result.rejected);
}

/** Every minute (server.ts): the sends and retries that are due. */
export async function processDueSchedules(now = new Date()): Promise<void> {
  const due = await prisma.reportSchedule.findMany({
    where: { enabled: true, OR: [{ retryAt: { lte: now } }, { retryAt: null, nextRunAt: { lte: now } }] },
  });
  if (due.length === 0) return;
  const isHoliday = await holidayCheck();
  for (const row of due) {
    await runDue(row, isHoliday).catch((err) => logger.error({ err, scheduleId: row.id }, "failed to process a scheduled presentation"));
  }
}

/**
 * Holidays added after a schedule was saved: its next date is recalculated once a day, and when the server starts — which
 * also recovers a send the server was in the middle of when it stopped (claimed, so with no next date left).
 */
export async function refreshNextRuns(): Promise<void> {
  const isHoliday = await holidayCheck();
  const rows = await prisma.reportSchedule.findMany({ where: { enabled: true, retryAt: null } });
  for (const row of rows) {
    // From the last send (or the creation): a send that came due while the server was down still goes out.
    const after = row.lastRunAt ?? new Date(row.createdAt.getTime() - 60_000);
    const next = nextSend(row, after, isHoliday, row.runCount);
    if (next?.getTime() !== row.nextRunAt?.getTime()) await prisma.reportSchedule.update({ where: { id: row.id }, data: { nextRunAt: next } });
  }
}

/** "Enviar agora": a send outside the schedule — the answer says right away whether it went; no retries, no alerts. */
export async function sendNow(id: string): Promise<ReportScheduleRunDTO> {
  const row = await find(id);
  const result = await attempt(row);
  const status = !result.ok ? "FAILED" : result.rejected.length ? "PARTIAL" : "SENT";
  await record(row, new Date(), 1, status, result.rejected, result.error, true);
  if (!result.ok) throw Errors.badRequest(result.error ?? "Falha no envio");
  return (await runs(id))[0];
}

/** "Baixar prévia": the deck with the form's filters, straight to the browser — not e-mailed, not stored. */
export async function preview(input: Pick<ReportScheduleInput, "frequency" | "customInterval" | "customUnit" | "period" | "agentId" | "connectionIds" | "tzOffsetMinutes">, userId: string) {
  return buildScheduledDeck({ ...input, createdById: userId, updatedById: userId });
}
