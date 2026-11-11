import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { generateTotpSecret, matchTotpStep, totpAuthUrl } from "../../lib/totp";
import { getBranding, getBusinessSettings } from "../settings/settings.service";

/**
 * Verificação em duas etapas: besides the password, a 6-digit code from an authenticator app on the person's phone
 * (Google Authenticator, Microsoft Authenticator, Authy...). With it on, a password that leaked or was guessed is
 * not enough to get in.
 *
 * Meu Perfil switches it on: a secret is shown as a QR Code, and it only starts to count once a code read from the
 * app is confirmed — so nobody is locked out by a QR Code they never scanned. Ten recovery codes are shown once, for
 * the day the phone is lost; each works a single time. Whoever manages users can remove it from someone else.
 */

const RECOVERY_CODES = 10;
const hashCode = (code: string) => crypto.createHash("sha256").update(code).digest("hex");
/** "ABCDE-FGHJK" typed in any case, with or without the dash. */
const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function newRecoveryCodes(): string[] {
  // No 0/O/1/I: they are read from paper.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: RECOVERY_CODES }, () => {
    const chars = Array.from(crypto.randomBytes(10), (byte) => alphabet[byte % alphabet.length]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** Whether the Administrador profile is required to use it (Configurações › Segurança). */
export async function adminTwoFactorRequired(): Promise<boolean> {
  return (await getBusinessSettings()).requireAdminTwoFactor === true;
}

/** An Administrador who has to switch it on before anything else. */
export async function mustSetUpTwoFactor(user: { role: string; totpEnabledAt: Date | null }): Promise<boolean> {
  return user.role === "ADMIN" && !user.totpEnabledAt && (await adminTwoFactorRequired());
}

/** Step 1: a new secret, shown as a QR Code. Nothing changes for the login until it is confirmed (confirmTwoFactor). */
export async function beginTwoFactorSetup(userId: string): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.totpEnabledAt) throw Errors.badRequest("A verificação em duas etapas já está ativada");
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { totpSecret: encryptSecret(secret), totpLastStep: null } });
  const issuer = (await getBranding()).companyName || "Atendimento";
  const otpauthUrl = totpAuthUrl(secret, user.email, issuer);
  return { secret, otpauthUrl, qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }) };
}

/** Step 2: a code from the app proves the phone has the secret — it is on from here. Returns the recovery codes, once. */
export async function confirmTwoFactor(userId: string, code: string, now = new Date()): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.totpEnabledAt) throw Errors.badRequest("A verificação em duas etapas já está ativada");
  if (!user.totpSecret) throw Errors.badRequest("Comece pela leitura do QR Code");
  const step = matchTotpStep(decryptSecret(user.totpSecret), code, now);
  if (step === null) throw Errors.badRequest("Código incorreto. Confira no aplicativo e tente de novo");
  const recoveryCodes = newRecoveryCodes();
  await prisma.user.update({
    where: { id: userId },
    data: { totpEnabledAt: now, totpLastStep: step, totpRecoveryCodes: recoveryCodes.map((c) => hashCode(normalizeRecovery(c))) },
  });
  return { recoveryCodes };
}

/**
 * The second step of a login: the app's current code, or one of the recovery codes. An app code is accepted once (the
 * same 30 seconds can't be replayed by someone who watched it being typed); a recovery code is spent.
 */
export async function verifyTwoFactorCode(user: { id: string; totpSecret: string | null; totpLastStep: number | null; totpRecoveryCodes: string[] }, code: string, now = new Date()): Promise<boolean> {
  if (!user.totpSecret) return false;
  const step = matchTotpStep(decryptSecret(user.totpSecret), code, now);
  if (step !== null) {
    if (user.totpLastStep !== null && step <= user.totpLastStep) return false;
    // Only one of two logins typing the same code at the same moment gets it.
    const claimed = await prisma.user.updateMany({ where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
    return claimed.count > 0;
  }
  const recovery = normalizeRecovery(code);
  if (recovery.length !== 10) return false;
  const hash = hashCode(recovery);
  if (!user.totpRecoveryCodes.includes(hash)) return false;
  const remaining = user.totpRecoveryCodes.filter((h) => h !== hash);
  const spent = await prisma.user.updateMany({ where: { id: user.id, totpRecoveryCodes: { has: hash } }, data: { totpRecoveryCodes: remaining } });
  return spent.count > 0;
}

const CLEARED = { totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryCodes: [] };

/** Meu Perfil › Desativar: asks the password and a code again — a session left open on a desk can't switch it off. */
export async function disableOwnTwoFactor(userId: string, password: string, code: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpEnabledAt) throw Errors.badRequest("A verificação em duas etapas não está ativada");
  if (user.role === "ADMIN" && (await adminTwoFactorRequired())) throw Errors.forbidden("A verificação em duas etapas é obrigatória para administradores");
  if (!(await bcrypt.compare(password, user.passwordHash))) throw Errors.unauthorized("Senha incorreta");
  if (!(await verifyTwoFactorCode(user, code))) throw Errors.badRequest("Código incorreto");
  await prisma.user.update({ where: { id: userId }, data: CLEARED });
}

/** Usuários › Remover verificação em duas etapas: for someone who lost the phone and the recovery codes. */
export async function resetTwoFactor(userId: string): Promise<boolean> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true, totpSecret: true } });
  await prisma.user.update({ where: { id: userId }, data: CLEARED });
  return Boolean(user.totpEnabledAt);
}
