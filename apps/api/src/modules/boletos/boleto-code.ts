/**
 * Boleto (FEBRABAN) barcode and linha digitável, built only from the data
 * source's own fields — never from a linha typed by someone.
 *
 * Barcode (44): banco(3) moeda(1) DV(1) fator(4) valor(10) campo livre(25).
 * Linha: three fields of the barcode with a mod-10 digit each, the general
 * DV, then fator + valor.
 */

const DUE_FACTOR_BASE = Date.UTC(1997, 9, 7);
const DAY_MS = 86_400_000;

export function mod10(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    const product = Number(digits[i]) * weight;
    sum += product > 9 ? Math.floor(product / 10) + (product % 10) : product;
    weight = weight === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

/** Barcode general digit: weights 2..9 from the right; 0, 10 and 11 become 1. */
export function mod11Barcode(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const dv = 11 - (sum % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** Days since 07/10/1997; since 22/02/2025 (day 10000) it starts over at 1000. */
export function dueFactor(due: Date): string {
  const days = Math.round((Date.UTC(due.getFullYear(), due.getMonth(), due.getDate()) - DUE_FACTOR_BASE) / DAY_MS);
  const factor = days > 9999 ? ((days - 10000) % 9000) + 1000 : days;
  return String(factor).padStart(4, "0");
}

export function buildBarcode(bank: string, due: Date, valueCents: number, freeField: string): string {
  if (!/^\d{3}$/.test(bank) || !/^\d{25}$/.test(freeField)) throw new Error("Dados do boleto incompletos");
  const value = String(valueCents).padStart(10, "0");
  if (value.length > 10) throw new Error("Valor do boleto alto demais");
  const withoutDv = `${bank}9${dueFactor(due)}${value}${freeField}`;
  const dv = mod11Barcode(withoutDv);
  return `${withoutDv.slice(0, 4)}${dv}${withoutDv.slice(4)}`;
}

export function linhaFromBarcode(barcode: string): string {
  const free = barcode.slice(19);
  const f1 = `${barcode.slice(0, 4)}${free.slice(0, 5)}`;
  const f2 = free.slice(5, 15);
  const f3 = free.slice(15, 25);
  const field = (f: string) => `${f}${mod10(f)}`;
  const [a, b, c] = [field(f1), field(f2), field(f3)];
  return `${a.slice(0, 5)}.${a.slice(5)} ${b.slice(0, 5)}.${b.slice(5)} ${c.slice(0, 5)}.${c.slice(5)} ${barcode[4]} ${barcode.slice(5, 19)}`;
}

/** The barcode back from a linha, after checking its four check digits — null when any is wrong. */
export function barcodeFromLinha(linha: string): string | null {
  const d = linha.replace(/\D/g, "");
  if (d.length !== 47) return null;
  const fields = [d.slice(0, 10), d.slice(10, 21), d.slice(21, 32)];
  if (fields.some((f) => mod10(f.slice(0, -1)) !== Number(f.slice(-1)))) return null;
  const barcode = `${d.slice(0, 4)}${d[32]}${d.slice(33, 47)}${d.slice(4, 9)}${d.slice(10, 20)}${d.slice(21, 31)}`;
  return mod11Barcode(`${barcode.slice(0, 4)}${barcode.slice(5)}`) === Number(barcode[4]) ? barcode : null;
}

function digits(value: string | undefined | null): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Banco do Brasil, convênio de 7 dígitos (carteira 17): "000000" + convênio
 * + nosso número (10) + carteira. The source's nosso número may come with the
 * convênio in front (17 digits).
 */
export function freeFieldBB(agreement: string, ourNumber: string, wallet: string): string {
  const conv = digits(agreement);
  let nn = digits(ourNumber);
  if (conv.length !== 7) throw new Error("Convênio do Banco do Brasil precisa ter 7 dígitos");
  // As printed on the boleto: convênio + nosso número (17), sometimes followed by "-DV" (18).
  if ((nn.length === 17 || nn.length === 18) && nn.startsWith(conv)) nn = nn.slice(7, 17);
  if (nn.length > 10) throw new Error("Nosso número do Banco do Brasil com tamanho inesperado");
  const cart = digits(wallet).padStart(2, "0");
  return `000000${conv}${nn.padStart(10, "0")}${cart.slice(-2)}`;
}
