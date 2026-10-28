/**
 * Matching key for a Brazilian phone, whatever way it was written: with or
 * without 55, with or without the extra 9, with a leading 0 or symbols.
 * "55 + DDD + the last 8 digits" — so (65) 99999-1234, 6599991234,
 * 5565999991234 and 556599991234 all give 556599991234.
 * Returns null for anything that isn't a Brazilian number with DDD.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  let digits = (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!digits.startsWith("55") || (digits.length !== 12 && digits.length !== 13)) return null;
  return `${digits.slice(0, 4)}${digits.slice(-8)}`;
}
