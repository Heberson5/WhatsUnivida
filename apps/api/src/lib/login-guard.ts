import { prisma } from "./prisma";
import { logger } from "./logger";
import { HttpError } from "./http-error";
import { normalizeIp, writeAudit } from "./audit";
import { composeCustomMail, sendMail } from "./mail";
import { createNotification } from "../modules/notifications/notifications.service";
import { toNotificationDTO } from "../modules/notifications/notifications.mapper";
import { realtimeEvents } from "../realtime/realtime";

/**
 * Protection against someone trying many users and passwords — see PROMPT: "precisa ter segurança para tentativa de
 * invasão ao tentar vários usuário e senhas". On top of the per-request limits of lib/rate-limit.ts (kept in memory,
 * gone on a restart), every attempt is written to the database and two rules are read from there:
 *
 *  - An IP with 100 wrong passwords in 15 minutes is refused, whatever the e-mails it tries.
 *  - An e-mail with 10 wrong passwords in 15 minutes is locked — for 15 minutes, then 1 hour, then 24 hours when the
 *    locks come one after the other — even when each attempt comes from a different IP (the per-IP limits never
 *    see that attack).
 *
 * A lock is on the e-mail typed, whether or not an account exists for it, and its answer is the same as the limiter's:
 * nothing here tells a stranger which e-mails have an account. And it only stops IPs the person never logged in from:
 * otherwise anybody could lock a colleague out on purpose just by typing their e-mail with wrong passwords.
 */

const WINDOW_MS = 15 * 60_000;
const IP_MAX_FAILURES = 100;
const EMAIL_MAX_FAILURES = 10;
const LOCK_MINUTES = [15, 60, 24 * 60];
// A lock within this long of the previous one is "one after the other": the next level.
const ESCALATION_MS = 24 * 3_600_000;
// An IP counts as the person's own for this long after a login from it.
const TRUSTED_IP_MS = 90 * 24 * 3_600_000;

export const LOGIN_BLOCKED_MESSAGE = "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.";

const blocked = () => new HttpError(429, "TOO_MANY_REQUESTS", LOGIN_BLOCKED_MESSAGE);
const normalize = (email: string) => email.trim().toLowerCase();

async function isTrustedIp(email: string, ip: string | null, now: Date): Promise<boolean> {
  if (!ip) return false;
  const seen = await prisma.loginAttempt.findFirst({
    where: { email, ipAddress: ip, success: true, createdAt: { gt: new Date(now.getTime() - TRUSTED_IP_MS) } },
    select: { id: true },
  });
  return seen !== null;
}

/** Before the password is even looked at: refuses a blocked IP and a locked e-mail (from an IP that isn't the person's own). */
export async function assertLoginAllowed(rawEmail: string, rawIp: string | null, now = new Date()): Promise<void> {
  const email = normalize(rawEmail);
  const ip = normalizeIp(rawIp);
  if (ip) {
    const fromIp = await prisma.loginAttempt.count({ where: { ipAddress: ip, success: false, createdAt: { gt: new Date(now.getTime() - WINDOW_MS) } } });
    if (fromIp >= IP_MAX_FAILURES) throw blocked();
  }
  const lock = await prisma.loginLock.findUnique({ where: { email } });
  if (lock && lock.lockedUntil > now && !(await isTrustedIp(email, ip, now))) throw blocked();
}

/** A wrong password (or an e-mail with no account): counted, and the e-mail is locked when it was one too many. */
export async function recordLoginFailure(rawEmail: string, rawIp: string | null, user: { id: string; email: string; displayName: string } | null, now = new Date()): Promise<void> {
  const email = normalize(rawEmail);
  const ip = normalizeIp(rawIp);
  await prisma.loginAttempt.create({ data: { email, ipAddress: ip, success: false, createdAt: now } });

  const lock = await prisma.loginLock.findUnique({ where: { email } });
  if (lock && lock.lockedUntil > now) return; // already locked (this attempt came from the person's own IP)
  // Only what came after the last lock ended counts toward the next one.
  const since = new Date(Math.max(now.getTime() - WINDOW_MS, lock ? lock.lockedUntil.getTime() : 0));
  const failures = await prisma.loginAttempt.count({ where: { email, success: false, createdAt: { gt: since } } });
  if (failures < EMAIL_MAX_FAILURES) return;

  const level = lock && now.getTime() - lock.lockedUntil.getTime() < ESCALATION_MS ? Math.min(lock.level + 1, LOCK_MINUTES.length) : 1;
  const minutes = LOCK_MINUTES[level - 1];
  const lockedUntil = new Date(now.getTime() + minutes * 60_000);
  await prisma.loginLock.upsert({ where: { email }, create: { email, level, lockedUntil }, update: { level, lockedUntil } });
  await announceLock({ email, ip, user, failures, minutes }).catch((err) => logger.error({ err, email }, "failed to announce a login lock"));
}

/** A correct password: the IP becomes the person's own and any lock on the e-mail is over. */
export async function recordLoginSuccess(rawEmail: string, rawIp: string | null, now = new Date()): Promise<void> {
  const email = normalize(rawEmail);
  const ip = normalizeIp(rawIp);
  await prisma.loginAttempt.create({ data: { email, ipAddress: ip, success: true, createdAt: now } });
  await prisma.loginLock.deleteMany({ where: { email } });
}

/** Until when each of these e-mails is locked — only the ones locked right now. */
export async function activeLoginLocks(emails: string[], now = new Date()): Promise<Map<string, Date>> {
  if (emails.length === 0) return new Map();
  const rows = await prisma.loginLock.findMany({ where: { email: { in: emails.map(normalize) }, lockedUntil: { gt: now } }, select: { email: true, lockedUntil: true } });
  return new Map(rows.map((r) => [r.email, r.lockedUntil]));
}

/** Usuários › Desbloquear login: the lock is lifted and the count starts again. True when there was one. */
export async function unlockLogin(rawEmail: string): Promise<boolean> {
  const email = normalize(rawEmail);
  const removed = await prisma.loginLock.deleteMany({ where: { email } });
  await prisma.loginAttempt.deleteMany({ where: { email, success: false, createdAt: { gt: new Date(Date.now() - WINDOW_MS) } } });
  return removed.count > 0;
}

/** Daily: attempts too old to matter (past the trusted-IP period) and locks long over. */
export async function purgeOldLoginAttempts(now = new Date()): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - TRUSTED_IP_MS) } } });
  await prisma.loginLock.deleteMany({ where: { lockedUntil: { lt: new Date(now.getTime() - ESCALATION_MS) } } });
}

const durationLabel = (minutes: number) => (minutes >= 24 * 60 ? "24 horas" : minutes >= 60 ? "1 hora" : `${minutes} minutos`);

/** Tells the administrators (bell + Auditoria) and, when the account exists, its owner by e-mail. */
async function announceLock(input: { email: string; ip: string | null; user: { id: string; email: string; displayName: string } | null; failures: number; minutes: number }) {
  const { email, ip, user, failures, minutes } = input;
  await writeAudit({ userId: user?.id ?? null, action: "LOGIN_LOCKED", entity: "User", entityId: user?.id ?? null, ipAddress: ip, metadata: { email, failures, minutes, accountExists: user !== null } });

  const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE", isAssistant: false }, select: { id: true } });
  const title = "Login bloqueado por senhas erradas";
  const body = `${email}: ${failures} senhas erradas em 15 minutos${ip ? ` (último IP ${ip})` : ""}. Bloqueado por ${durationLabel(minutes)} para IPs desconhecidos${user ? "" : " — não existe usuário com este e-mail"}.`;
  for (const admin of admins) {
    const notification = await createNotification({ userId: admin.id, type: "SECURITY", title, body, entityType: user ? "User" : undefined, entityId: user?.id });
    realtimeEvents.notificationCreated(admin.id, toNotificationDTO(notification));
  }

  if (user) {
    const mail = await composeCustomMail(
      "Tentativas de acesso à sua conta",
      "Tentativas de acesso à sua conta",
      `Olá, {{nome}}.\n\nDetectamos ${failures} tentativas de login com senha errada na sua conta em poucos minutos. Por segurança, o acesso a partir de locais desconhecidos ficou bloqueado por ${durationLabel(minutes)}.\n\nSe foi você, aguarde esse tempo ou peça a um administrador para desbloquear. Se não foi você, sua senha continua valendo: ninguém entrou na sua conta. Avise um administrador.`,
      { nome: user.displayName }
    );
    await sendMail(user.email, mail.subject, mail.html, mail.text);
  }
}
