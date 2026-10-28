import { formatPhoneAsKnown } from "./format-phone";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const MONEY_COLUMN = /valor|saldo|multa|juros|preco|mensalidade/;
const PHONE_COLUMN = /telefone|celular|whatsapp|fone/;

/**
 * A data-source value as people read it: "396.4" in a value column → "R$ 396,40", a phone → "+55 65 99999-0000",
 * a CEP → "78300-000". Anything else (and a masked value) is shown as it came.
 */
export function formatDataValue(column: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("•")) return value;
  if (MONEY_COLUMN.test(column) && /^-?\d+(\.\d+)?$/.test(trimmed)) return BRL.format(Number(trimmed));
  const digits = trimmed.replace(/\D/g, "");
  if (PHONE_COLUMN.test(column) && /^[\d\s()+-]+$/.test(trimmed) && digits.length >= 10 && digits.length <= 13) {
    return formatPhoneAsKnown(digits.length <= 11 ? `55${digits}` : digits);
  }
  if (/^cep/.test(column) && /^\d{5}-?\d{3}$/.test(trimmed)) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return value;
}
