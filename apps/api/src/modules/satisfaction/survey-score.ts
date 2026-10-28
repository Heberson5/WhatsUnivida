const MAX_SCORE = 10;
// Up to this many words, an answer is just the score with a word or two around it.
const SHORT_ANSWER_WORDS = 4;
const SCORE_CUES_BEFORE = new Set(["nota", "da", "dar", "dou", "daria", "darei", "dei", "um", "e", "merece", "vale", "seria", "minha"]);
const SCORE_CUES_AFTER = new Set(["ponto", "pontos", "estrela", "estrelas"]);
/** Long enough for "Precisei primeira vez posso dar 10, gostei muito do atendimento"; a longer text is a conversation. */
export const MAX_SCORE_ANSWER_LENGTH = 200;

// Spelled-out scores, with the misspellings customers actually send. "um"/"uma" are left out: they are articles
// ("dou um 10") far more often than a score — a bare "um" is handled on its own below.
const WORD_SCORES: Record<string, number> = {
  zero: 0,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  des: 10,
  deiz: 10,
  deis: 10,
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * The 0–10 score inside a customer's answer, or null when there is none or more than one.
 * "10", "nota 9", "1o" / "l0" (letter for the zero), "dez", "10/10", "8 de 10", "de 0 a 10 dou 8",
 * "Precisei primeira vez posso da 10". "entre 7 e 8" or "pedido 12345" give null — never a guess.
 */
export function parseSurveyScore(text: string | null | undefined): number | null {
  const trimmed = text?.trim() ?? "";
  if (!trimmed || trimmed.length > MAX_SCORE_ANSWER_LENGTH) return null;
  let s = normalize(trimmed);
  if (/^(um|uma)\W*$/.test(s)) return 1;
  // A letter typed for the zero of 10: "1o", "1O", "l0", "lo" right before/after nothing alphanumeric.
  s = s.replace(/(^|[^a-z0-9])[1l][o0](?![a-z0-9])/g, "$110");
  // The scale itself, repeated from the question: "de 0 a 10", "0-10", "/10", "8 de 10".
  s = s.replace(/\b(de\s+)?0\s*(a|ate|-)\s*10\b/g, " ");
  s = s.replace(/(\d)\s*(\/|de|em)\s*10\b/g, "$1 ");
  for (const [word, value] of Object.entries(WORD_SCORES)) s = s.replace(new RegExp(`\\b${word}\\b`, "g"), ` ${value} `);
  // A short answer ("nota 9", "10 obrigado") is the score as it is. In a longer text a number is only the score
  // when it reads like one — "posso da 10", "dou um 10", "nota 9", "10 pontos" — never "o pedido 1 chegou quebrado".
  const words = s.match(/[a-z]+|\d+/g) ?? [];
  const short = words.length <= SHORT_ANSWER_WORDS;
  const candidates: string[] = [];
  words.forEach((word, i) => {
    if (!/^\d+$/.test(word)) return;
    if (short || i === 0 || SCORE_CUES_BEFORE.has(words[i - 1] ?? "") || SCORE_CUES_AFTER.has(words[i + 1] ?? "")) candidates.push(word);
  });
  // Order numbers, phones, dates: anything with 3+ digits is not a score — nor is an 11–99 standing as the score.
  if (candidates.some((n) => n.length > 2 || Number(n) > MAX_SCORE)) return null;
  const scores = new Set(candidates.map(Number));
  return scores.size === 1 ? [...scores][0] : null;
}

/** Whether an answer that gave no score was still trying to ("nota máxima", "1o0") — worth asking once for the number. */
export function looksLikeScoreAttempt(text: string | null | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  if (!trimmed || trimmed.length > MAX_SCORE_ANSWER_LENGTH) return false;
  const s = normalize(trimmed);
  return /\d/.test(s) || /\bnota\b/.test(s) || Object.keys(WORD_SCORES).some((w) => new RegExp(`\\b${w}\\b`).test(s));
}
