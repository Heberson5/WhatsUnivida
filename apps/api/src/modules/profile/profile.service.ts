import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { sendTemplatedMail } from "../../lib/mail";

const withConnection = { whatsappConnection: true } as const;

export async function getOwnProfile(userId: string) {
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, include: withConnection });
}

export async function updateOwnProfile(userId: string, input: { fullName?: string; displayName?: string }) {
  return prisma.user.update({
    where: { id: userId },
    data: { fullName: input.fullName, displayName: input.displayName },
    include: withConnection,
  });
}

export async function updateOwnPhoto(userId: string, photoUrl: string | null) {
  return prisma.user.update({ where: { id: userId }, data: { photoUrl }, include: withConnection });
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
