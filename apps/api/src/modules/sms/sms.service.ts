import type { Prisma } from "@prisma/client";
import { SMS_PROVIDERS, type SmsAvailabilityDTO, type SmsProviderId, type SmsSettingsDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { SMS_SENDERS, normalizeSmsPhone } from "./sms-providers";

/**
 * Configurações › SMS: one provider at a time, its secret fields encrypted at rest (like the SMTP password) and never
 * sent back to the browser. A successful test SMS stamps verifiedAt — only then does "avisar por SMS" show up, and a
 * change of provider or credentials clears it until the next test.
 */

const KEY = "sms";

interface StoredSms {
  enabled: boolean;
  provider: SmsProviderId | null;
  config: Record<string, string>;
  verifiedAt: string | null;
  lastError: string | null;
}

const EMPTY: StoredSms = { enabled: false, provider: null, config: {}, verifiedAt: null, lastError: null };

function secretKeys(provider: SmsProviderId | null): Set<string> {
  return new Set(provider ? SMS_PROVIDERS[provider].fields.filter((f) => f.secret).map((f) => f.key) : []);
}

async function readStored(): Promise<StoredSms> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  return { ...EMPTY, ...((row?.value as Partial<StoredSms>) ?? {}) };
}

async function writeStored(next: StoredSms): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: KEY, value: next as unknown as Prisma.InputJsonValue },
  });
}

/** The provider's fields in clear text — only ever used to send. */
async function decryptedConfig(stored: StoredSms): Promise<Record<string, string>> {
  const secrets = secretKeys(stored.provider);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored.config)) out[k] = secrets.has(k) && v ? decryptSecret(v) : v;
  return out;
}

export async function getMaskedSettings(): Promise<SmsSettingsDTO> {
  const stored = await readStored();
  const secrets = secretKeys(stored.provider);
  const config: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(stored.config)) {
    if (secrets.has(k)) {
      config[k] = "";
      secretsSet[k] = Boolean(v);
    } else config[k] = v;
  }
  return { enabled: stored.enabled, provider: stored.provider, config, secretsSet, verifiedAt: stored.verifiedAt, lastError: stored.lastError };
}

/** A secret field left blank keeps the saved one — the form never receives it back to resend. */
export async function saveSettings(patch: { enabled: boolean; provider: SmsProviderId | null; config: Record<string, string> }): Promise<SmsSettingsDTO> {
  const current = await readStored();
  const sameProvider = current.provider === patch.provider;
  const secrets = secretKeys(patch.provider);
  const allowed = new Set(patch.provider ? SMS_PROVIDERS[patch.provider].fields.map((f) => f.key) : []);
  const config: Record<string, string> = {};
  for (const key of allowed) {
    const value = (patch.config[key] ?? "").trim();
    if (secrets.has(key)) config[key] = value ? encryptSecret(value) : sameProvider ? (current.config[key] ?? "") : "";
    else config[key] = value;
  }
  const credentialsChanged = !sameProvider || [...allowed].some((k) => (secrets.has(k) ? Boolean((patch.config[k] ?? "").trim()) : config[k] !== (current.config[k] ?? "")));
  await writeStored({
    enabled: patch.enabled && Boolean(patch.provider),
    provider: patch.provider,
    config,
    verifiedAt: credentialsChanged ? null : current.verifiedAt,
    lastError: credentialsChanged ? null : current.lastError,
  });
  return getMaskedSettings();
}

export async function sendSms(phone: string, text: string): Promise<void> {
  const stored = await readStored();
  if (!stored.provider) throw Errors.badRequest("Nenhum provedor de SMS configurado");
  const to = normalizeSmsPhone(phone);
  if (to.length < 10) throw Errors.badRequest(`Número de celular inválido: ${phone}`);
  await SMS_SENDERS[stored.provider](await decryptedConfig(stored), to, text);
}

/** Sends the test SMS and records the outcome — success is what turns the SMS option on in the alerts. */
export async function sendTest(phone: string): Promise<SmsSettingsDTO> {
  const stored = await readStored();
  try {
    await sendSms(phone, "Teste de SMS do sistema: se você recebeu esta mensagem, o envio de alertas por SMS está funcionando.");
    await writeStored({ ...stored, verifiedAt: new Date().toISOString(), lastError: null });
  } catch (err) {
    const message = (err as Error).message;
    await writeStored({ ...stored, verifiedAt: null, lastError: message });
    logger.warn({ err }, "test SMS failed");
    throw Errors.badRequest(message);
  }
  return getMaskedSettings();
}

export async function availability(): Promise<SmsAvailabilityDTO> {
  const stored = await readStored();
  const available = stored.enabled && Boolean(stored.provider) && Boolean(stored.verifiedAt);
  return { available, providerLabel: stored.provider ? SMS_PROVIDERS[stored.provider].label : null };
}
