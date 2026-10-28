import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { sendTemplatedMail } from "../../lib/mail";
import { recordPresenceTransition } from "../../lib/presence-status";

const withConnection = { whatsappConnection: true, pauseReason: true } as const;

export async function getOwnProfile(userId: string) {
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, include: withConnection });
}


export async function markReleaseNotesSeen(userId: string, version: string) {
  await prisma.user.update({ where: { id: userId }, data: { releaseNotesSeenVersion: version } });
}

export async function updateOwnSounds(userId: string, sounds: { soundNewMessage?: boolean; soundNewQueue?: boolean; soundVolume?: number }) {
  return prisma.user.update({ where: { id: userId }, data: sounds, include: withConnection });
}

export async function updateOwnPhoto(userId: string, photoUrl: string | null) {
  return prisma.user.update({ where: { id: userId }, data: { photoUrl }, include: withConnection });
}

/**
 * Pause/resume one's own attendance from the profile menu — personal
 * action, no permission beyond being logged in (see pause-reasons.routes
 * for the same reasoning on the /active list this picks from). Queued
 * conversation distribution already treats AWAY the same as OFFLINE; this
 * just gives agents an explicit, intentional way to set it instead of it
 * only ever happening passively. See PROMPT: "poderão pausar no mesmo
 * local onde está a foto do perfil do usuário".
 */
export async function pauseOwnAttendance(userId: string, pauseReasonId: string) {
  const reason = await prisma.pauseReason.findUnique({ where: { id: pauseReasonId } });
  if (!reason || !reason.active) throw Errors.badRequest("Motivo de pausa invalido");
  const user = await prisma.user.update({
    where: { id: userId },
    data: { presence: "AWAY", pauseReasonId, pausedAt: new Date() },
    include: withConnection,
  });
  await recordPresenceTransition(userId, "AWAY", pauseReasonId);
  return user;
}

export async function resumeOwnAttendance(userId: string) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { presence: "ONLINE", pauseReasonId: null, pausedAt: null },
    include: withConnection,
  });
  await recordPresenceTransition(userId, "ONLINE");
  return user;
}

export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw Errors.unauthorized("Senha atual incorreta");

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    // Every refresh token is revoked, including this browser's own — the
    // current tab keeps working until its short-lived access token expires,
    // then re-authenticates with the new password like any other session.
    prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } }),
  ]);
  await sendTemplatedMail("PASSWORD_CHANGED", user.email, { nome: user.displayName });
}
