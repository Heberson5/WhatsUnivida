import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { sendTemplatedMail } from "../../lib/mail";
import { env } from "../../config/env";
import { queueMayMove } from "../../lib/presence-status";
import type { Role } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { AccessSchedule, WeekdayKey } from "@whatsatendende/types";

const WEEKDAY_KEYS: WeekdayKey[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Rejects a malformed schedule outright rather than silently storing something resolveAccessDecision can't parse — see lib/access-schedule.ts. */
function validateAccessSchedule(schedule: AccessSchedule | null | undefined) {
  if (!schedule) return;
  for (const [day, window] of Object.entries(schedule)) {
    if (!WEEKDAY_KEYS.includes(day as WeekdayKey)) throw Errors.badRequest(`Dia da semana invalido no horario de acesso: ${day}`);
    if (!window) continue;
    if (!HHMM_RE.test(window.start) || !HHMM_RE.test(window.end)) {
      throw Errors.badRequest(`Horario invalido para ${day} — use o formato HH:mm`);
    }
    if (window.start >= window.end) throw Errors.badRequest(`O horario final deve ser depois do inicial (${day})`);
  }
}

const withConnection = { whatsappConnection: true, pauseReason: true, deactivatedBy: { select: { displayName: true } } } as const;

/**
 * An e-mail repeats only across inactive users: at most one ACTIVE user per e-mail. Says who has it when it's taken —
 * checked when creating, reactivating and editing an active user's e-mail.
 */
export async function assertEmailFreeForActive(email: string, exceptUserId?: string) {
  const active = await prisma.user.findFirst({ where: { email: email.toLowerCase(), status: "ACTIVE", ...(exceptUserId && { id: { not: exceptUserId } }) } });
  if (active) throw Errors.conflict(`O e-mail ${email.toLowerCase()} já está em uso por "${active.fullName}" (ativo).`);
}

/** For the e-mail field of the user form: the active user that has it (if any) and the inactive ones that had it. */
export async function describeEmailUse(email: string, exceptUserId?: string) {
  const users = await prisma.user.findMany({
    where: { email: email.toLowerCase(), ...(exceptUserId && { id: { not: exceptUserId } }) },
    select: { fullName: true, status: true, deactivatedAt: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    active: users.find((u) => u.status === "ACTIVE")?.fullName ?? null,
    inactive: users.filter((u) => u.status === "INACTIVE").map((u) => ({ name: u.fullName, deactivatedAt: u.deactivatedAt?.toISOString() ?? null })),
  };
}

/** AGENT requires a home WhatsApp connection (which queue they see); ADMIN/MANAGER never have one — they see everything via oversight. */
async function resolveConnectionAssignment(role: Role, whatsappConnectionId: string | null | undefined): Promise<string | null> {
  if (role !== "AGENT") return null;
  if (!whatsappConnectionId) throw Errors.badRequest("Selecione a conexao de WhatsApp deste atendente");
  const connection = await prisma.whatsAppConnection.findUnique({ where: { id: whatsappConnectionId } });
  if (!connection) throw Errors.badRequest("Conexao de WhatsApp invalida");
  return whatsappConnectionId;
}

export async function listUsers() {
  return prisma.user.findMany({ orderBy: { fullName: "asc" }, include: withConnection });
}

export async function getUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, include: withConnection });
  if (!user) throw Errors.notFound("Usuario nao encontrado");
  return user;
}

export async function createUser(input: {
  fullName: string;
  displayName: string;
  email: string;
  password: string;
  role: Role;
  whatsappConnectionId?: string | null;
  workState?: string | null;
  workCity?: string | null;
  accessSchedule?: AccessSchedule | null;
}) {
  await assertEmailFreeForActive(input.email);
  if (input.workCity && !input.workState) throw Errors.badRequest("Selecione o estado antes da cidade");
  validateAccessSchedule(input.accessSchedule);

  const whatsappConnectionId = await resolveConnectionAssignment(input.role, input.whatsappConnectionId);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await prisma.user.create({
    data: {
      fullName: input.fullName,
      displayName: input.displayName,
      email: input.email.toLowerCase(),
      passwordHash,
      role: input.role,
      whatsappConnectionId,
      workState: input.workState ?? null,
      workCity: input.workCity ?? null,
      accessSchedule: (input.accessSchedule ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    include: withConnection,
  });
  // Never blocks account creation on e-mail delivery — sendTemplatedMail
  // already never throws (SMTP not configured, template disabled, or a
  // send failure all just resolve to { sent: false }).
  await sendTemplatedMail("USER_WELCOME", user.email, {
    nome: user.displayName,
    email: user.email,
    link_login: `${env.WEB_APP_URL}/login`,
  });
  return user;
}

export async function updateUser(
  id: string,
  input: Partial<{
    fullName: string;
    displayName: string;
    email: string;
    role: Role;
    whatsappConnectionId: string | null;
    password: string;
    workState: string | null;
    workCity: string | null;
    accessSchedule: AccessSchedule | null;
  }>
) {
  const current = await getUser(id);
  const nextRole = input.role ?? current.role;
  // Re-validated whenever the role or the connection itself changes — not
  // just once at creation — so an AGENT can never end up without one, and
  // a promoted ADMIN/MANAGER always has it cleared.
  const whatsappConnectionId =
    "role" in input || "whatsappConnectionId" in input
      ? await resolveConnectionAssignment(nextRole, input.whatsappConnectionId ?? current.whatsappConnectionId)
      : undefined;
  const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : undefined;
  const nextWorkState = "workState" in input ? input.workState : current.workState;
  const nextWorkCity = "workCity" in input ? input.workCity : current.workCity;
  if (nextWorkCity && !nextWorkState) throw Errors.badRequest("Selecione o estado antes da cidade");
  if ("accessSchedule" in input) validateAccessSchedule(input.accessSchedule);
  if (input.email && input.email.toLowerCase() !== current.email && current.status === "ACTIVE") await assertEmailFreeForActive(input.email, id);

  const user = await prisma.user.update({
    where: { id },
    data: {
      fullName: input.fullName,
      displayName: input.displayName,
      role: input.role,
      email: input.email ? input.email.toLowerCase() : undefined,
      whatsappConnectionId,
      passwordHash,
      workState: "workState" in input ? nextWorkState : undefined,
      workCity: "workCity" in input ? nextWorkCity : undefined,
      accessSchedule: "accessSchedule" in input
        ? input.accessSchedule === null
          ? Prisma.JsonNull
          : (input.accessSchedule as Prisma.InputJsonValue)
        : undefined,
    },
    include: withConnection,
  });
  // An admin setting a new password directly should also invalidate any
  // existing sessions, same as the random-reset flow already does.
  if (passwordHash) {
    await prisma.refreshToken.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } });
  }
  return user;
}

export async function setUserStatus(id: string, status: "ACTIVE" | "INACTIVE", actorId: string) {
  const current = await getUser(id);
  // Reactivating an old user can't take an e-mail an active user already has.
  if (status === "ACTIVE" && current.status !== "ACTIVE") await assertEmailFreeForActive(current.email, id);
  const changed = current.status !== status;
  const user = await prisma.user.update({
    where: { id },
    data: {
      status,
      ...(changed && status === "INACTIVE" && { deactivatedAt: new Date(), deactivatedById: actorId }),
      ...(changed && status === "ACTIVE" && { deactivatedAt: null, deactivatedById: null }),
    },
    include: withConnection,
  });
  // Only on an actual ACTIVE->INACTIVE transition — never on a no-op PATCH
  // (e.g. deactivating an already-deactivated user) or on reactivation.
  if (status === "INACTIVE" && current.status !== "INACTIVE") {
    await sendTemplatedMail("USER_DEACTIVATED", user.email, { nome: user.displayName });
  }
  return user;
}

/**
 * Revokes every refresh token so the user can't silently renew their
 * session, and marks them offline. On its own this isn't truly instant — a
 * short-lived access token they already hold keeps working until it
 * naturally expires — see realtimeEvents.userForceLoggedOut (called by the
 * route right after this) for the part that actually disconnects them
 * immediately.
 */
export async function forceLogoutUser(id: string) {
  await getUser(id);
  await prisma.$transaction([
    prisma.refreshToken.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } }),
    // Same as signing out: a pause ends here too (it would otherwise come back on the next login).
    prisma.user.update({ where: { id }, data: { presence: "OFFLINE", pauseReasonId: null, pausedAt: null } }),
  ]);
  await queueMayMove(id);
}

/**
 * Hard delete — distinct from setUserStatus("INACTIVE") above, which only
 * blocks login and keeps everything else intact. See PROMPT: "função de
 * excluir usuário, somente para o acesso Administrador".
 *
 * Only actually possible for an account with no history: every relation
 * that points at a user (messages sent, conversations assigned/transferred,
 * audit log entries, WhatsApp connections they created) has no onDelete
 * rule in the schema, so Postgres refuses the delete outright (a foreign
 * key violation) the moment any of that exists — which in practice is
 * almost every real account. That's deliberate, not a gap to work around:
 * deleting a user who sent real messages would either cascade away actual
 * conversation history or leave it silently orphaned, and an audit log
 * entry that no longer names who did what defeats its entire purpose. The
 * route-level permission gate keeps this ADMIN-only; the checks below are
 * about not leaving the system in a broken/lockout state, not about who's
 * allowed to call this.
 */
export async function deleteUser(id: string, requestingUserId: string) {
  const target = await getUser(id);
  if (id === requestingUserId) throw Errors.badRequest("Você não pode excluir sua própria conta");
  if (target.role === "ADMIN") {
    const otherAdmins = await prisma.user.count({ where: { role: "ADMIN", id: { not: id } } });
    if (otherAdmins === 0) throw Errors.badRequest("Não é possível excluir o único administrador do sistema");
  }
  try {
    await prisma.user.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      throw Errors.badRequest(
        "Este usuário já tem atendimentos, mensagens ou outro histórico registrado e não pode ser excluído — use \"Desativar\" para bloquear o acesso mantendo o histórico."
      );
    }
    throw err;
  }
}

export async function resetUserPassword(id: string): Promise<{ temporaryPassword: string }> {
  await getUser(id);
  const temporaryPassword = crypto.randomBytes(6).toString("base64url");
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } }),
  ]);
  return { temporaryPassword };
}
