import { freeFieldBB, mod10 } from "./boleto-code";

/**
 * The free field (positions 20–44 of the barcode) of each bank, and how the boleto prints "Agência/Código do
 * Beneficiário" and "Nosso Número" — each rule from the bank's own manual (cited by section), checked against the
 * manual's worked examples in tests/boleto-banks.test.ts. A bank's boletos still only go out after the validation with
 * real boletos (Dados › Boletos), like Banco do Brasil.
 */

export interface BankBoletoFields {
  agreement: string;
  ourNumber: string;
  wallet: string;
  agency: string;
  account: string;
  /** Sicredi: posto da cooperativa (posto_beneficiario). */
  post: string;
}

export interface BankBoletoParts {
  freeField: string;
  /** As printed in "Nosso Número" (with the bank's check digit). */
  ourNumberPrinted: string;
  /** As printed in "Agência / Código do Beneficiário"; null = the default (agência/conta). */
  agencyCodePrinted: string | null;
  /** As printed in "Carteira"; null = the source's. */
  walletPrinted: string | null;
}

export interface BoletoBank {
  name: string;
  /** Printed beside the logo, e.g. "748-X". */
  codeWithDigit: string;
  /** Where the rules come from. */
  source: string;
  build(fields: BankBoletoFields): BankBoletoParts;
}

const digits = (value: string | undefined | null) => (value ?? "").replace(/\D/g, "");
/** "0804-4" → "0804"; "12751-5" → "12751": the number without its check digit. */
const beforeDigit = (value: string) => digits(value.split("-")[0]);

function fit(value: string, size: number, what: string): string {
  if (value.length > size) throw new Error(`${what} com tamanho inesperado (${value.length} dígitos, o máximo é ${size})`);
  return value.padStart(size, "0");
}

/** Sum of digit × weight, weights 2..maxWeight from the right. */
function weightedSum(value: string, maxWeight: number): number {
  let sum = 0;
  let weight = 2;
  for (let i = value.length - 1; i >= 0; i--) {
    sum += Number(value[i]) * weight;
    weight = weight === maxWeight ? 2 : weight + 1;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Sicredi (748) — Manual Cobrança CNAB 400 do Sicredi: 5.3–5.4 (nosso número, págs. 7–8) e 10.7.1–10.7.2 (campo livre,
// págs. 51–52). Conferido também com um boleto real da Univida (0804.22.00017).

/** DV of the nosso número: 11 − (Σ mod 11); 10 or 11 → 0. Over cooperativa(4) posto(2) beneficiário(5) ano(2) byte(1) sequencial(5). */
export function sicrediOurNumberDigit(cooperative: string, post: string, beneficiary: string, yyBnnnnn: string): number {
  const dv = 11 - (weightedSum(`${cooperative}${post}${beneficiary}${yyBnnnnn}`, 9) % 11);
  return dv > 9 ? 0 : dv;
}

/** DV of the free field: 11 − (Σ mod 11); rest 0 or 1 → 0. */
export function sicrediFreeFieldDigit(first24: string): number {
  const rest = weightedSum(first24, 9) % 11;
  return rest <= 1 ? 0 : 11 - rest;
}

const sicredi: BoletoBank = {
  name: "Sicredi",
  codeWithDigit: "748-X",
  source: "Manual Cobrança CNAB 400 do Sicredi, itens 5.3–5.4 e 10.7",
  build({ agreement, ourNumber, agency, post }) {
    const cooperative = fit(beforeDigit(agency), 4, "Cooperativa do Sicredi");
    const postCode = fit(digits(post), 2, "Posto do Sicredi");
    if (!digits(post)) throw new Error("Falta o posto do Sicredi (coluna posto_beneficiario)");
    const beneficiary = fit(digits(agreement), 5, "Código do beneficiário do Sicredi");
    // AA + B + XXXXX (8 digits) — the system keeps the sequence with zeros in front; 9 digits already carry the DV.
    const nn = digits(ourNumber);
    if (!nn) throw new Error("Parcela sem nosso número");
    const body = nn.length === 9 ? nn.slice(0, 8) : nn.slice(-8).padStart(8, "0");
    const dv = sicrediOurNumberDigit(cooperative, postCode, beneficiary, body);
    if (nn.length === 9 && Number(nn[8]) !== dv) throw new Error("O dígito do nosso número do Sicredi não confere");
    const nn9 = `${body}${dv}`;
    const first24 = `11${nn9}${cooperative}${postCode}${beneficiary}10`;
    return {
      freeField: `${first24}${sicrediFreeFieldDigit(first24)}`,
      ourNumberPrinted: `${body.slice(0, 2)}/${body.slice(2)}-${dv}`,
      agencyCodePrinted: `${cooperative}.${postCode}.${beneficiary}`,
      walletPrinted: "1",
    };
  },
};

// ---------------------------------------------------------------------------
// Bradesco (237) — Manual de Procedimentos 4008.524.0121, versão 17: dígito do nosso número (págs. 17–19) e montagem do
// código de barras / campo livre (pág. 28).

/** Dígito de autoconferência: carteira + nosso número, módulo 11 base 7; resto 1 → "P", resto 0 → "0". */
export function bradescoOurNumberDigit(wallet2: string, ourNumber11: string): string {
  const rest = weightedSum(`${wallet2}${ourNumber11}`, 7) % 11;
  return rest === 0 ? "0" : rest === 1 ? "P" : String(11 - rest);
}

const bradesco: BoletoBank = {
  name: "Bradesco",
  codeWithDigit: "237-2",
  source: "Manual de Procedimentos Bradesco 4008.524.0121, versão 17",
  build({ ourNumber, wallet, agency, account }) {
    const agency4 = fit(beforeDigit(agency), 4, "Agência do Bradesco");
    const wallet2 = fit(digits(wallet), 2, "Carteira do Bradesco");
    if (!digits(wallet)) throw new Error("Falta a carteira do Bradesco");
    const nn = fit(digits(ourNumber), 11, "Nosso número do Bradesco");
    const account7 = fit(beforeDigit(account), 7, "Conta do Bradesco");
    return {
      freeField: `${agency4}${wallet2}${nn}${account7}0`,
      ourNumberPrinted: `${wallet2}/${nn}-${bradescoOurNumberDigit(wallet2, nn)}`,
      agencyCodePrinted: null,
      walletPrinted: wallet2,
    };
  },
};

// ---------------------------------------------------------------------------
// Itaú (341) — Layout Cobrança FEBRABAN 240 Itaú (jan/2017): nota 27 (DAC do nosso número), anexos 2 e 3, exemplo do
// código de barras (pág. 44). Carteira 198 tem outro leiaute de campo livre: não é montada aqui.

/** Carteiras cujo DAC do nosso número usa só carteira + nosso número (nota 27). */
const ITAU_WALLET_ONLY_DAC = new Set(["126", "131", "145", "150", "168"]);
const ITAU_OTHER_LAYOUT = new Set(["198"]);

export function itauOurNumberDac(agency4: string, account5: string, wallet3: string, ourNumber8: string): number {
  return mod10(ITAU_WALLET_ONLY_DAC.has(wallet3) ? `${wallet3}${ourNumber8}` : `${agency4}${account5}${wallet3}${ourNumber8}`);
}

const itau: BoletoBank = {
  name: "Itaú",
  codeWithDigit: "341-7",
  source: "Layout Cobrança FEBRABAN 240 Itaú (jan/2017), nota 27 e anexos 2–3",
  build({ ourNumber, wallet, agency, account }) {
    const wallet3 = fit(digits(wallet), 3, "Carteira do Itaú");
    if (!digits(wallet)) throw new Error("Falta a carteira do Itaú");
    if (ITAU_OTHER_LAYOUT.has(wallet3)) throw new Error(`A carteira ${wallet3} do Itaú tem outro leiaute de código de barras, ainda não disponível`);
    const agency4 = fit(beforeDigit(agency), 4, "Agência do Itaú");
    const account5 = fit(beforeDigit(account), 5, "Conta do Itaú");
    const nn = fit(digits(ourNumber), 8, "Nosso número do Itaú");
    const dac = itauOurNumberDac(agency4, account5, wallet3, nn);
    const accountDac = mod10(`${agency4}${account5}`);
    return {
      freeField: `${wallet3}${nn}${dac}${agency4}${account5}${accountDac}000`,
      ourNumberPrinted: `${wallet3}/${nn}-${dac}`,
      agencyCodePrinted: `${agency4}/${account5}-${accountDac}`,
      walletPrinted: wallet3,
    };
  },
};

// ---------------------------------------------------------------------------
// Caixa (104), carteira SIGCB — "Especificações técnicas para emissão de boletos de cobrança bancária CAIXA",
// leiaute 67.119 v014: 4.2.10.1.1 (composição), anexos III, IV e VI (págs. 25–39).

/** Módulo 11 da Caixa (DV do beneficiário, do nosso número e do campo livre): 11 − resto; maior que 9 → 0. */
export function caixaDigit(value: string): number {
  const dv = 11 - (weightedSum(value, 9) % 11);
  return dv > 9 ? 0 : dv;
}

const caixa: BoletoBank = {
  name: "Caixa",
  codeWithDigit: "104-0",
  source: "Especificações técnicas CAIXA SIGCB, leiaute 67.119 v014, anexos III, IV e VI",
  build({ agreement, ourNumber, agency }) {
    const code = digits(agreement).replace(/^0+(?=\d{6})/, "");
    if (!code) throw new Error("Falta o código do beneficiário da Caixa (coluna convenio)");
    // Up to 999999: 6 positions + DV; from 1100000 on: the 7 positions, no DV (Nota 3).
    const beneficiary = Number(code) >= 1_100_000 ? fit(code, 7, "Código do beneficiário da Caixa") : `${fit(code, 6, "Código do beneficiário da Caixa")}${caixaDigit(code.padStart(6, "0"))}`;
    // 17 positions: 1 (registrada) + 4 (emitido pelo beneficiário) + 15 livres. 15 digits get the "14" in front.
    let nn = digits(ourNumber);
    if (nn.length <= 15) nn = `14${nn.padStart(15, "0")}`;
    if (nn.length !== 17) throw new Error("Nosso número da Caixa com tamanho inesperado (são 17 posições)");
    const first24 = `${beneficiary}${nn.slice(2, 5)}${nn[0]}${nn.slice(5, 8)}${nn[1]}${nn.slice(8, 17)}`;
    const agency4 = beforeDigit(agency).padStart(4, "0").slice(-4);
    const code7 = code.padStart(7, "0");
    return {
      freeField: `${first24}${caixaDigit(first24)}`,
      ourNumberPrinted: `${nn}-${caixaDigit(nn)}`,
      agencyCodePrinted: `${agency4} / ${code7}-${caixaDigit(code7)}`,
      walletPrinted: "RG",
    };
  },
};

// ---------------------------------------------------------------------------
// Banco do Brasil (001) — the convênio de 7 dígitos rule already in use (boleto-code.ts).

const bancoDoBrasil: BoletoBank = {
  name: "Banco do Brasil",
  codeWithDigit: "001-9",
  source: "Banco do Brasil, convênio de 7 dígitos (em uso desde a versão 2.x)",
  build({ agreement, ourNumber, wallet }) {
    return { freeField: freeFieldBB(agreement, ourNumber, wallet), ourNumberPrinted: ourNumber, agencyCodePrinted: null, walletPrinted: null };
  },
};

export const BOLETO_BANK_RULES: Record<string, BoletoBank> = {
  "001": bancoDoBrasil,
  "748": sicredi,
  "237": bradesco,
  "341": itau,
  "104": caixa,
};
