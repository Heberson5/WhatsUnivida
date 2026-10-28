import type { Prisma } from "@prisma/client";
import { DEFAULT_PHONE_SETTINGS, type PhoneSettingsDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";

/**
 * Configurações › Números de telefone: whether a number typed by hand gets
 * the default country code and loses its extra 9. Both on from the start —
 * it only touches numbers typed by hand (Nova conversa › Novo número and the
 * contacts CSV import), never what WhatsApp itself reports.
 */

const SETTINGS_KEY = "phoneNumbers";

export async function getPhoneSettings(): Promise<PhoneSettingsDTO> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = (row?.value ?? {}) as Partial<PhoneSettingsDTO>;
  return {
    defaultCountryCodeEnabled: typeof stored.defaultCountryCodeEnabled === "boolean" ? stored.defaultCountryCodeEnabled : DEFAULT_PHONE_SETTINGS.defaultCountryCodeEnabled,
    defaultCountryCode: typeof stored.defaultCountryCode === "string" && /^\d{1,3}$/.test(stored.defaultCountryCode) ? stored.defaultCountryCode : DEFAULT_PHONE_SETTINGS.defaultCountryCode,
    fixExtraNineEnabled: typeof stored.fixExtraNineEnabled === "boolean" ? stored.fixExtraNineEnabled : DEFAULT_PHONE_SETTINGS.fixExtraNineEnabled,
  };
}

export async function updatePhoneSettings(input: PhoneSettingsDTO): Promise<PhoneSettingsDTO> {
  const json = input as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value: json }, create: { key: SETTINGS_KEY, value: json } });
  return input;
}
