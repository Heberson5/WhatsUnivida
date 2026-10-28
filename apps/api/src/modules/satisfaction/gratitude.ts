/**
 * Whether a customer's message is only a thank-you / acknowledgement ("obrigado", "valeu",
 * "ok", 👍...) — as opposed to something that wants an answer.
 *
 * It matters while the survey is waiting for the score: a thank-you there must not open a
 * new conversation, but anything else must — nobody who writes should be left unheard. So
 * this is deliberately strict: the message has to be made ONLY of thank-you / acknowledgement
 * words (plus a few filler words around them), short, with no question and no number. Any
 * word outside the lists makes it "wants to talk" — "obrigado, mas tenho outra dúvida" is
 * not a thank-you.
 */

// At least one of these (or one of the emojis below) has to be there.
const GRATITUDE_WORDS = [
  "obrigado", "obrigada", "obrigadao", "obrigadinho", "obrigadinha", "obrigadissimo", "obrigadissima", "obg", "obgd", "brigado", "brigada",
  "agradeco", "agradecido", "agradecida", "agradecemos", "grato", "grata", "gratidao", "valeu", "vlw", "valeuu",
  "ok", "okay", "oks", "blz", "beleza", "show", "perfeito", "perfeita", "otimo", "otima", "excelente", "top", "tmj", "joia", "certo",
  "certinho", "combinado", "fechado", "entendi", "entendido", "tranquilo", "tchau", "flw", "falou", "abraco", "abracos", "parabens",
];

// Allowed around them, but not enough on their own.
const FILLER_WORDS = [
  "muito", "mto", "mt", "demais", "mesmo", "viu", "gente", "pessoal", "equipe", "time", "voce", "voces", "vc", "vcs", "pelo", "pela",
  "pelos", "pelas", "por", "tudo", "atendimento", "ajuda", "atencao", "rapidez", "paciencia", "de", "da", "do", "a", "o", "e", "um",
  "uma", "bom", "boa", "dia", "tarde", "noite", "ate", "logo", "mais", "sempre", "forte", "deus", "abencoe", "que", "bem",
];

// Reactions that thank or acknowledge; also allowed next to words.
const GRATITUDE_EMOJIS = ["👍", "🙏", "😊", "😀", "😁", "😄", "🙂", "😉", "😍", "🥰", "🤗", "❤", "💙", "💚", "💜", "🧡", "💛", "👏", "🤝", "✅", "✔", "👌", "🫡", "👋", "🙌"];

const MAX_WORDS = 8;

/** Lower case, no accents, and any run of the same letter squeezed to one ("obrigadooo" → "obrigado", "okkk" → "ok"). */
function squeeze(word: string): string {
  return word
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/(.)\1+/g, "$1");
}

const GRATITUDE_SET = new Set(GRATITUDE_WORDS.map(squeeze));
const FILLER_SET = new Set(FILLER_WORDS.map(squeeze));

// Variation selectors / joiners that ride along with emojis.
const EMOJI_GLUE = /\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}]/gu;

export function isGratitudeMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("?") || /\d/.test(trimmed)) return false;

  let emojiCount = 0;
  let rest = trimmed.replace(EMOJI_GLUE, "");
  for (const emoji of GRATITUDE_EMOJIS) {
    const parts = rest.split(emoji);
    emojiCount += parts.length - 1;
    rest = parts.join(" ");
  }

  // What is left must be words (letters) only — any other symbol, or an emoji we don't know, means it is not a plain thank-you.
  const words = rest.split(/[\s.,!;:()\-_/\\"'…~*]+/).filter(Boolean);
  if (words.some((word) => !/^\p{L}+$/u.test(word))) return false;
  if (words.length > MAX_WORDS) return false;

  const squeezed = words.map(squeeze);
  if (!squeezed.every((word) => GRATITUDE_SET.has(word) || FILLER_SET.has(word))) return false;
  return emojiCount > 0 || squeezed.some((word) => GRATITUDE_SET.has(word));
}
