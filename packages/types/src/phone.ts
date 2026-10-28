/**
 * Phone numbers typed by hand — Nova conversa › Novo número and the contacts
 * CSV import. Adds the default country code and fixes the extra 9 that
 * Brazilian mobiles get typed with. Shared by the API, which is the
 * authority, and by the screens, which only preview what will be used.
 */

/** Configurações › Números de telefone. */
export interface PhoneSettingsDTO {
  /** Puts `defaultCountryCode` in front of a number typed without a country code. */
  defaultCountryCodeEnabled: boolean;
  /** Digits only, 1 to 3 of them — "55" is Brasil. */
  defaultCountryCode: string;
  /** Drops the extra 9 of a Brazilian mobile typed as DDD + 9 + 8 digits, which WhatsApp usually knows as DDD + 8 digits. */
  fixExtraNineEnabled: boolean;
}

export const DEFAULT_PHONE_SETTINGS: PhoneSettingsDTO = {
  defaultCountryCodeEnabled: true,
  defaultCountryCode: "55",
  fixExtraNineEnabled: true,
};

/** Answer of the "does this number exist on WhatsApp" check made while typing a number in Nova conversa. */
export interface PhoneLookupDTO {
  /** null when WhatsApp could not be asked right now (connection down) — starting is then refused until it answers. */
  exists: boolean | null;
  /**
   * A WhatsApp Oficial connection can't ask WhatsApp itself: a connected QR Code connection is asked instead. True when
   * there is none — the conversation may then start without the check.
   */
  unverifiable: boolean;
  /** The QR Code connection that answered for a WhatsApp Oficial one. */
  checkedByConnectionName: string | null;
  /** The number WhatsApp itself knows (and the conversation will use) — only when it exists. */
  phone: string | null;
  /** The typed number after the settings' rules, before asking WhatsApp. */
  normalizedPhone: string;
}

export interface NormalizedPhone {
  /** Digits, with the country code — what to use. Empty when nothing was typed. */
  phone: string;
  /** Other forms of the same number, in the order to try them when WhatsApp doesn't know `phone`. */
  alternates: string[];
}

const BRAZIL_COUNTRY_CODE = "55";

/**
 * Brazilian area codes (DDD) whose mobile accounts WhatsApp keeps registered
 * WITH the 9: 11–19, 21, 22, 24, 27 and 28. Everywhere else the account
 * usually still carries the old 8-digit form. Documented by WhatsApp
 * integrators (Gupshup, Whapi, WAHA) — a rule of thumb, not a guarantee,
 * which is why the interactive flow still asks WhatsApp.
 */
const NINTH_DIGIT_KEPT_DDDS = new Set(["11", "12", "13", "14", "15", "16", "17", "18", "19", "21", "22", "24", "27", "28"]);

const BR_MOBILE_WITH_NINE = /^55([1-9]\d)9(\d{8})$/;
// Landlines (first digit 2–5) never get a 9, so only mobile-looking numbers have a "with 9" twin.
const BR_MOBILE_WITHOUT_NINE = /^55([1-9]\d)([6-9]\d{7})$/;

/** Whether this typed number still lacks its country code. Brazil: DDD + number (10 digits, or 11 with the mobile 9). */
function lacksCountryCode(digits: string, countryCode: string): boolean {
  if (countryCode === BRAZIL_COUNTRY_CODE) return digits.length === 10 || (digits.length === 11 && digits[2] === "9");
  return digits.length >= 6 && digits.length <= 11 && !digits.startsWith(countryCode);
}

/**
 * What a number typed by hand becomes under the settings:
 * - leading zeros dropped and, if it has no country code, the default one added;
 * - a Brazilian mobile with the extra 9 loses it — except in the DDDs where
 *   WhatsApp keeps the 9, where the number stays as typed. Either way the other
 *   form is returned in `alternates`, for the caller to try when WhatsApp
 *   doesn't know the first one.
 * With both options off it is just the typed digits.
 */
export function normalizeTypedPhone(raw: string, settings: PhoneSettingsDTO): NormalizedPhone {
  let digits = raw.replace(/\D/g, "");
  if (settings.defaultCountryCodeEnabled && settings.defaultCountryCode) {
    digits = digits.replace(/^0+/, "");
    if (lacksCountryCode(digits, settings.defaultCountryCode)) digits = settings.defaultCountryCode + digits;
  }
  const mobile = settings.fixExtraNineEnabled ? BR_MOBILE_WITH_NINE.exec(digits) : null;
  if (!mobile) return { phone: digits, alternates: [] };
  const withoutNine = `${BRAZIL_COUNTRY_CODE}${mobile[1]}${mobile[2]}`;
  return NINTH_DIGIT_KEPT_DDDS.has(mobile[1]) ? { phone: digits, alternates: [withoutNine] } : { phone: withoutNine, alternates: [digits] };
}

/** A Brazilian mobile in both its forms (with and without the 9), the one given first; any other number is just itself. */
export function brazilianPhoneVariants(phone: string): string[] {
  const withNine = BR_MOBILE_WITH_NINE.exec(phone);
  if (withNine) return [phone, `${BRAZIL_COUNTRY_CODE}${withNine[1]}${withNine[2]}`];
  const withoutNine = BR_MOBILE_WITHOUT_NINE.exec(phone);
  if (withoutNine) return [phone, `${BRAZIL_COUNTRY_CODE}${withoutNine[1]}9${withoutNine[2]}`];
  return [phone];
}
