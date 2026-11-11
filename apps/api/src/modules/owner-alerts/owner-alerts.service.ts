import nodemailer from "nodemailer";
import type { Prisma } from "@prisma/client";
import { OWNER_ALERT_EVENTS, SMS_PROVIDERS, type OwnerAlertEvent, type OwnerAlertsDTO, type SmsProviderId } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { SMS_SENDERS, normalizeSmsPhone } from "../sms/sms-providers";

/**
 * Configurações › Avisos do administrador — see PROMPT: "uma segunda configuração de e-mail, SMS etc., que é somente
 * para o administrador, pois o intuito é gerenciar a empresa que usará o sistema, pois quero ser notificado de algumas
 * situações". Whoever runs the platform gets told, on their own e-mail server and SMS provider, when something needs
 * them — apart from the company's own Configurações › E-mail and SMS, which a Gestor may see and edit. Everything here
 * is for the Administrador alone (owner-alerts.routes.ts), secrets encrypted at rest and never sent back.
 *
 * An alert never gets in the way of what caused it: notifyOwner never throws, and a failure is only kept as
 * `lastError` for the screen to show.
 */

const KEY = "ownerAlerts";

interface Stored {
  events: Record<string, boolean>;
  email: { enabled: boolean; host: string; port: number; secure: boolean; username: string; password: string; fromName: string; fromEmail: string; recipients: string[] };
  sms: { enabled: boolean; provider: SmsProviderId | null; config: Record<string, string>; recipients: string[] };
  lastError: OwnerAlertsDTO["lastError"];
  lastSentAt: string | null;
}

const EVENT_KEYS = Object.keys(OWNER_ALERT_EVENTS) as OwnerAlertEvent[];

const EMPTY: Stored = {
  events: Object.fromEntries(EVENT_KEYS.map((k) => [k, true])),
  email: { enabled: false, host: "", port: 587, secure: false, username: "", password: "", fromName: "Avisos do sistema", fromEmail: "", recipients: [] },
  sms: { enabled: false, provider: null, config: {}, recipients: [] },
  lastError: null,
  lastSentAt: null,
};

async function read(): Promise<Stored> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  const value = (row?.value as Partial<Stored> | undefined) ?? {};
  return { ...EMPTY, ...value, events: { ...EMPTY.events, ...value.events }, email: { ...EMPTY.email, ...value.email }, sms: { ...EMPTY.sms, ...value.sms } };
}

async function write(next: Stored): Promise<void> {
  const value = next as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
}

const smsSecretKeys = (provider: SmsProviderId | null) => new Set(provider ? SMS_PROVIDERS[provider].fields.filter((f) => f.secret).map((f) => f.key) : []);

function toDTO(stored: Stored): OwnerAlertsDTO {
  const secrets = smsSecretKeys(stored.sms.provider);
  const config: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(stored.sms.config)) {
    if (secrets.has(k)) {
      config[k] = "";
      secretsSet[k] = Boolean(v);
    } else config[k] = v;
  }
  const { password, ...email } = stored.email;
  return {
    events: Object.fromEntries(EVENT_KEYS.map((k) => [k, stored.events[k] !== false])) as Record<OwnerAlertEvent, boolean>,
    email: { ...email, hasPassword: Boolean(password) },
    sms: { enabled: stored.sms.enabled, provider: stored.sms.provider, config, secretsSet, recipients: stored.sms.recipients },
    lastError: stored.lastError,
    lastSentAt: stored.lastSentAt,
  };
}

export async function getOwnerAlerts(): Promise<OwnerAlertsDTO> {
  return toDTO(await read());
}

export interface OwnerAlertsPatch {
  events: Partial<Record<OwnerAlertEvent, boolean>>;
  email: { enabled: boolean; host: string; port: number; secure: boolean; username: string; password?: string; fromName: string; fromEmail: string; recipients: string[] };
  sms: { enabled: boolean; provider: SmsProviderId | null; config: Record<string, string>; recipients: string[] };
}

/** A secret left blank (the SMTP password, a provider's key) keeps the saved one — the form never receives it back to resend. */
export async function saveOwnerAlerts(patch: OwnerAlertsPatch): Promise<OwnerAlertsDTO> {
  const current = await read();
  if (patch.email.enabled) {
    if (!patch.email.host.trim() || !patch.email.fromEmail.trim()) throw Errors.badRequest("Para avisar por e-mail, informe o servidor SMTP e o e-mail do remetente");
    if (patch.email.recipients.length === 0) throw Errors.badRequest("Informe pelo menos um e-mail para receber os avisos");
  }
  if (patch.sms.enabled) {
    if (!patch.sms.provider) throw Errors.badRequest("Para avisar por SMS, escolha o provedor");
    if (patch.sms.recipients.length === 0) throw Errors.badRequest("Informe pelo menos um celular para receber os avisos");
  }
  for (const phone of patch.sms.recipients) {
    if (normalizeSmsPhone(phone).length < 12) throw Errors.badRequest(`Número de celular inválido: ${phone}. Use DDD + número`);
  }

  const sameProvider = current.sms.provider === patch.sms.provider;
  const secrets = smsSecretKeys(patch.sms.provider);
  const config: Record<string, string> = {};
  for (const field of patch.sms.provider ? SMS_PROVIDERS[patch.sms.provider].fields : []) {
    const value = (patch.sms.config[field.key] ?? "").trim();
    if (secrets.has(field.key)) config[field.key] = value ? encryptSecret(value) : sameProvider ? (current.sms.config[field.key] ?? "") : "";
    else config[field.key] = value;
  }

  await write({
    events: Object.fromEntries(EVENT_KEYS.map((k) => [k, patch.events[k] ?? current.events[k] !== false])),
    email: {
      enabled: patch.email.enabled,
      host: patch.email.host.trim(),
      port: patch.email.port,
      secure: patch.email.secure,
      username: patch.email.username.trim(),
      password: patch.email.password ? encryptSecret(patch.email.password) : current.email.password,
      fromName: patch.email.fromName.trim() || EMPTY.email.fromName,
      fromEmail: patch.email.fromEmail.trim(),
      recipients: [...new Set(patch.email.recipients.map((r) => r.trim().toLowerCase()))],
    },
    sms: { enabled: patch.sms.enabled, provider: patch.sms.provider, config, recipients: [...new Set(patch.sms.recipients.map(normalizeSmsPhone))] },
    lastError: current.lastError,
    lastSentAt: current.lastSentAt,
  });
  return getOwnerAlerts();
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function sendEmail(stored: Stored, title: string, lines: string[]): Promise<void> {
  const { email } = stored;
  const transporter = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.secure,
    auth: email.username ? { user: email.username, pass: email.password ? decryptSecret(email.password) : undefined } : undefined,
  });
  const footer = `Aviso automático de ${env.WEB_APP_URL}`;
  await transporter.sendMail({
    from: `"${email.fromName}" <${email.fromEmail}>`,
    to: email.recipients.join(", "),
    subject: title,
    text: [...lines, "", footer].join("\n"),
    html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2937"><h2 style="font-size:16px;margin:0 0 12px">${escapeHtml(title)}</h2>${lines.map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join("")}<p style="margin:16px 0 0;font-size:12px;color:#6b7280">${escapeHtml(footer)}</p></div>`,
  });
}

async function sendSmsAlert(stored: Stored, title: string, lines: string[]): Promise<void> {
  const { sms } = stored;
  if (!sms.provider) throw new Error("Nenhum provedor de SMS configurado");
  const secrets = smsSecretKeys(sms.provider);
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(sms.config)) config[k] = secrets.has(k) && v ? decryptSecret(v) : v;
  // One SMS: the title and the first line, no accents lost to a second part.
  const text = `${title}: ${lines[0] ?? ""}`.slice(0, 155);
  for (const phone of sms.recipients) await SMS_SENDERS[sms.provider](config, phone, text);
}

/** Sends through every channel switched on; returns what went wrong on each (empty = all delivered). */
async function deliver(stored: Stored, title: string, lines: string[], only?: "email" | "sms"): Promise<{ channel: "email" | "sms"; message: string }[]> {
  const failures: { channel: "email" | "sms"; message: string }[] = [];
  const channels: ["email" | "sms", boolean, () => Promise<void>][] = [
    ["email", stored.email.enabled, () => sendEmail(stored, title, lines)],
    ["sms", stored.sms.enabled, () => sendSmsAlert(stored, title, lines)],
  ];
  for (const [channel, enabled, send] of channels) {
    if (only ? only !== channel : !enabled) continue;
    try {
      await send();
    } catch (err) {
      failures.push({ channel, message: (err as Error).message });
    }
  }
  return failures;
}

// The same alert again within its quiet time is dropped (a connection flapping, a burst of failed sends).
const lastSentByKey = new Map<string, number>();

/** Tests: forget what was sent recently. */
export function resetOwnerAlertThrottleForTests(): void {
  lastSentByKey.clear();
}

/**
 * Tells the Administrador that `event` happened, when they asked to be told. Never throws and never waits on the
 * caller's side for anything that matters to it — call it without awaiting where the caller must not be slowed down.
 */
export async function notifyOwner(event: OwnerAlertEvent, title: string, lines: string[], options: { throttleKey?: string; throttleMs?: number } = {}): Promise<void> {
  try {
    const stored = await read();
    if (stored.events[event] === false || (!stored.email.enabled && !stored.sms.enabled)) return;
    const key = `${event}:${options.throttleKey ?? ""}`;
    const now = Date.now();
    if (options.throttleMs && now - (lastSentByKey.get(key) ?? 0) < options.throttleMs) return;
    lastSentByKey.set(key, now);

    const failures = await deliver(stored, title, lines);
    for (const failure of failures) logger.warn({ event, ...failure }, "owner alert could not be delivered");
    const fresh = await read();
    const failed = failures[0];
    await write({
      ...fresh,
      // Delivered through at least one of the channels switched on.
      lastSentAt: failures.length < Number(stored.email.enabled) + Number(stored.sms.enabled) ? new Date(now).toISOString() : fresh.lastSentAt,
      lastError: failed ? { at: new Date(now).toISOString(), channel: failed.channel, message: failed.message.slice(0, 300) } : fresh.lastError,
    });
  } catch (err) {
    logger.error({ err, event }, "failed to send an owner alert");
  }
}

/** "Enviar teste": through one channel, with what is saved; the error (a wrong password, a refused number) comes back as is. */
export async function sendOwnerAlertTest(channel: "email" | "sms"): Promise<OwnerAlertsDTO> {
  const stored = await read();
  if (channel === "email" && (!stored.email.host || !stored.email.fromEmail || stored.email.recipients.length === 0)) throw Errors.badRequest("Salve o servidor, o remetente e quem recebe antes de testar");
  if (channel === "sms" && (!stored.sms.provider || stored.sms.recipients.length === 0)) throw Errors.badRequest("Salve o provedor e os celulares antes de testar");
  const [failure] = await deliver(stored, "Teste dos avisos do administrador", ["Se você recebeu esta mensagem, os avisos do administrador estão funcionando."], channel);
  const now = new Date().toISOString();
  await write({ ...stored, lastSentAt: failure ? stored.lastSentAt : now, lastError: failure ? { at: now, channel, message: failure.message.slice(0, 300) } : null });
  if (failure) throw Errors.badRequest(`Não foi possível enviar: ${failure.message}`);
  return getOwnerAlerts();
}
