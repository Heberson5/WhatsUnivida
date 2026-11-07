/**
 * Assistente Virtual — the parts of understanding the customer that must never be wrong, done by plain code:
 * the CPF/CNPJ in any way it is typed or spoken, the name and address comparison, and the obvious requests
 * (boleto, débitos, atendente, sim/não). The local AI is only asked when none of these recognise the message.
 */

/** Lower case, no accents, single spaces. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Spoken digits, as an audio transcription may write them ("meia" is how six is said in a phone number).
const DIGIT_WORDS: Record<string, string> = {
  zero: "0", um: "1", uma: "1", dois: "2", duas: "2", tres: "3", quatro: "4", cinco: "5", seis: "6", meia: "6",
  sete: "7", oito: "8", nove: "9",
};

function digitsFromWords(text: string): string {
  return fold(text).replace(/\b(zero|uma?|dois|duas|tres|quatro|cinco|seis|meia|sete|oito|nove)\b/g, (w) => DIGIT_WORDS[w]);
}

export function validCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

export function validCnpj(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const check = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(digits[i]) * w, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(digits[12]) && check(13) === Number(digits[13]);
}

/**
 * The CPF (or CNPJ) in a message, however it came: "123.456.789-09", "12345678909", "123 456 789 09",
 * "meu cpf é 123456789-09", or spoken digit by digit. Only a number whose check digits are right counts.
 */
export function extractCpf(text: string): string | null {
  const prepared = digitsFromWords(text);
  // Runs of digits with the separators people use between them (dot, dash, slash, space, comma).
  const runs = prepared.match(/\d[\d.\-/\s,]*\d/g) ?? [];
  for (const run of runs) {
    const digits = run.replace(/\D/g, "");
    if (validCpf(digits) || validCnpj(digits)) return digits;
    // A run that glued a CPF to another number ("cpf 12345678909 tel 65999...") — try every 11/14-digit window.
    for (const len of [11, 14]) {
      for (let i = 0; i + len <= digits.length; i++) {
        const slice = digits.slice(i, i + len);
        if ((len === 11 && validCpf(slice)) || (len === 14 && validCnpj(slice))) return slice;
      }
    }
  }
  return null;
}

/** Whether the message has a number that looks like an attempt at a CPF (so a wrong one gets a precise answer). */
export function looksLikeDocumentAttempt(text: string): boolean {
  return (digitsFromWords(text).replace(/\D/g, "").length >= 9);
}

export function maskCpf(digits: string): string {
  if (digits.length === 11) return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  if (digits.length === 14) return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/****-**`;
  return "***";
}

const NAME_PARTICLES = new Set(["de", "da", "do", "das", "dos", "e", "d"]);

function nameTokens(name: string): string[] {
  return fold(name)
    .replace(/[^a-z\s]/g, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !NAME_PARTICLES.has(t));
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Same word, allowing a typo or a transcription slip: one letter in short words, two in long ones. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const tolerance = Math.max(a.length, b.length) <= 5 ? 1 : 2;
  return levenshtein(a, b) <= tolerance;
}

/**
 * The name the customer gave matches the registered one: first name and last surname must match (with a small
 * tolerance for typos and audio), every other word given must be part of the registered name, and at least two
 * words must be given. A middle name left out is fine.
 */
export function namesMatch(informed: string, registered: string): boolean {
  const given = nameTokens(informed);
  const known = nameTokens(registered);
  if (given.length < 2 || known.length < 2) return false;
  if (!sameWord(given[0], known[0])) return false;
  if (!sameWord(given[given.length - 1], known[known.length - 1])) return false;
  return given.every((word) => known.some((k) => sameWord(word, k)));
}

const ADDRESS_NOISE = new Set([
  "rua", "r", "avenida", "av", "travessa", "tv", "alameda", "al", "estrada", "rodovia", "praca", "pc", "numero", "n", "no", "nro",
  "bairro", "b", "casa", "apto", "apartamento", "ap", "bloco", "bl", "quadra", "qd", "lote", "lt", "cep", "centro", ...NAME_PARTICLES,
]);

function addressParts(address: string) {
  const folded = fold(address);
  const numbers = new Set((folded.match(/\d+/g) ?? []).filter((n) => n.length <= 6).map((n) => String(Number(n))));
  const words = folded
    .replace(/[^a-z\s]/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !ADDRESS_NOISE.has(w));
  return { numbers, words };
}

/**
 * The address the customer gave is the registered one: the house number given is in the registered address and
 * most of the street words match (abbreviations, accents and the order of the parts don't matter).
 */
export function addressesMatch(informed: string, registered: string): boolean {
  const given = addressParts(informed);
  const known = addressParts(registered);
  if (given.words.length === 0 || known.words.length === 0) return false;
  const numbersOk = given.numbers.size === 0 || [...given.numbers].some((n) => known.numbers.has(n));
  const matched = given.words.filter((w) => known.words.some((k) => sameWord(w, k))).length;
  return numbersOk && given.numbers.size > 0 && matched / given.words.length >= 0.5;
}

/** Folded and without punctuation: "Não, obrigado!" → "nao obrigado". */
function plain(text: string): string {
  return fold(text).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export type Intent = "BOLETO" | "DEBITOS" | "ATENDENTE" | "ENCERRAR" | "SAUDACAO" | "AGRADECIMENTO" | "OUTRO";

const RULES: [Intent, RegExp][] = [
  // Asked for a person: always first, it wins over anything else in the same message.
  ["ATENDENTE", /\b(atendente|atendentes|humano|operador|operadora|funcionari[oa]|gerente|falar com (um|uma|o|a|alguem|algum|uma pessoa|uma atendente)|pode me ligar|me liga|liga pra mim)\b/],
  // Wants to end the conversation — never "encerrar meu contrato/plano" (that is a cancellation, for the team).
  [
    "ENCERRAR",
    /^((pode|podemos|quero|vamos|pode sim|por favor|ja pode) )?(encerrar|encerra|finalizar|finaliza|fechar|terminar)( (o|a|nosso|nossa|esse|essa))?( (atendimento|conversa|chat|protocolo))?( (por favor|obrigad[oa]|ok))?$|\b(encerra|encerrar|finalizar|fechar|terminar) (o|a|esse|essa|nosso|nossa) (atendimento|conversa|chat)\b|^(quero |vou |preciso )?sair( (da|do|dessa|desse) (conversa|chat|atendimento))?( (por favor|obrigad[oa]))?$|\bsair (da|do|dessa|desse) (conversa|chat|atendimento)\b/,
  ],
  ["BOLETO", /\b(boleto|boletos|2a via|2 via|segunda via|linha digitavel|codigo de barras?|codigo do boleto|pix|copia e cola|pagar|pagamento|fatura|carne|mensalidade)\b/],
  ["DEBITOS", /\b(debito|debitos|devendo|divida|dividas|em aberto|atrasad[oa]s?|pendencia|pendencias|quanto (eu )?devo|quanto esta|valor atualizado|parcela|parcelas)\b/],
  ["AGRADECIMENTO", /^(ok|okay|blz|beleza|obrigad[oa]|muito obrigad[oa]|valeu|vlw|grat[oa]|so isso|era so isso|nao obrigad[oa]|tchau|ate mais)[\s!.,]*(obrigad[oa]|valeu)?[\s!.,]*$/],
  ["SAUDACAO", /^(oi+|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|tudo bem|tudo bom|hello|alo)[\s!.,?]*(tudo bem|tudo bom|bom dia|boa tarde|boa noite)?[\s!.,?]*$/],
];

// Words of a goodbye/"that's all" ("Não, era só isso, obrigado! Boa tarde"): a message made only of these ends the talk.
const CLOSING_WORDS = new Set([
  "nao", "n", "obrigado", "obrigada", "obg", "brigado", "brigada", "valeu", "vlw", "era", "e", "so", "isso", "tudo", "ok", "okay", "blz",
  "beleza", "tchau", "ate", "mais", "logo", "nada", "por", "enquanto", "agradeco", "muito", "mto", "grato", "grata", "certo", "perfeito",
  "otimo", "show", "bom", "boa", "dia", "tarde", "noite", "ta", "bem", "entao", "entendi", "resolvido", "resolveu", "deu", "certo", "ajudou",
]);
const CLOSING_MARKERS = /\b(obrigad[oa]|obg|brigad[oa]|valeu|vlw|tchau|so isso|era isso|nada mais|grat[oa]|agradeco|resolvido|resolveu|ajudou)\b/;

function isClosingTalk(folded: string): boolean {
  const words = folded.split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 12 && words.every((w) => CLOSING_WORDS.has(w)) && CLOSING_MARKERS.test(folded);
}

/** The request in a message when it is obvious; null when only the AI can tell. */
export function ruleIntent(text: string): Intent | null {
  const folded = plain(text);
  if (!folded) return null;
  for (const [intent, pattern] of RULES) {
    if (intent === "AGRADECIMENTO" && isClosingTalk(folded)) return intent;
    if (pattern.test(folded)) return intent;
  }
  return null;
}

export function isYes(text: string): boolean {
  return /^(sim|s|ss|claro|pode|pode sim|quero|quero sim|isso|ok|okay|por favor|manda|pode mandar|sim por favor|yes)[\s!.,]*$/.test(plain(text));
}

/** "Mesmo", "o mesmo", "pode ser o mesmo", "esse mesmo", "sim" — the CPF offered is the one. */
export function isSameAnswer(text: string): boolean {
  return /^(sim |pode |pode ser |e |eh |isso |)?(o |a |esse |este |o meu |meu )?(mesm[oa]|esse|este|meu|o meu)( (mesm[oa]|cpf|de antes|mesmo cpf|por favor|obrigad[oa]))*$|^sim$|^isso$|^pode$/.test(plain(text));
}

export function isNo(text: string): boolean {
  const folded = plain(text);
  if (/^n(ao)?\b/.test(folded) && folded.split(" ").every((w) => CLOSING_WORDS.has(w))) return true;
  return /^(nao|n|nao obrigad[oa]|nada|nao precisa|so isso|era so isso|nao quero|nenhum|nenhuma)[\s!.,]*$/.test(plain(text));
}

/** "2", "a 2", "opção 2", "segunda"… — the option picked, 1-based; "todas" = 0. Null when it isn't a choice. */
export function parseChoice(text: string, count: number): number | null {
  const folded = fold(text);
  if (/\b(todas|todos|tudo|todas elas)\b/.test(folded)) return 0;
  const ordinals = ["primeira", "segunda", "terceira", "quarta", "quinta", "sexta", "setima", "oitava", "nona", "decima"];
  const ordinal = ordinals.findIndex((o) => new RegExp(`\\b${o}\\b`).test(folded));
  if (ordinal >= 0 && ordinal < count) return ordinal + 1;
  const number = folded.match(/^\D{0,12}?(\d{1,2})\D{0,12}$/);
  if (number) {
    const n = Number(number[1]);
    if (n >= 1 && n <= count) return n;
  }
  return null;
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "10/03/2026" → "março/2026" — the month the parcel refers to. */
export function monthOf(dueBr: string | null): string | null {
  const m = dueBr?.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month}/${m[3]}` : null;
}

/** "150,5" / "150.50" / "R$ 1.234,56" → "R$ 1.234,56". */
export function formatBrl(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[^\d,.-]/g, "");
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return number.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
