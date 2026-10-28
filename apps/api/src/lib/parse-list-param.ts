/**
 * Normalizes a repeated query param (?x=a&x=b) or a comma-separated one
 * (?x=a,b) into a string array. Returns undefined when absent, which every
 * caller here treats as "no filter" (e.g. all WhatsApp connections).
 */
export function parseListParam(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((v) => v.split(",")).filter(Boolean);
}
