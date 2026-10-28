/**
 * Contatos › "Padronizar nomes": names typed on the phone come as "MARIA DA SILVA", "123 tgs maria souza",
 * "dr carlos". The standard: each word capitalized ("da/de/do/das/dos/e" in lowercase), the city code (TGS, CNP, BBG,
 * DEN, NVO) and the number that goes with it moved to the end as "123-TGS", "Dr."/"Dra." with the period, and company
 * suffixes (LTDA, ME, EPP, EIRELI) in capitals. A name with no letters (just the number) stays as it is.
 */

/** City codes of the company's units — always in capitals, moved to the end with their number. */
export const CONTACT_NAME_CITY_CODES = ["TGS", "CNP", "BBG", "DEN", "NVO"] as const;
/** Company suffixes — kept where they are, in capitals. */
const COMPANY_SUFFIXES = new Set(["LTDA", "ME", "EPP", "EIRELI", "MEI", "S/A", "SA"]);
const LOWERCASE_PARTICLES = new Set(["da", "de", "do", "das", "dos", "e"]);
const CITY_CODES = new Set<string>(CONTACT_NAME_CITY_CODES);

const upper = (s: string) => s.toLocaleUpperCase("pt-BR");
const lower = (s: string) => s.toLocaleLowerCase("pt-BR");

/** "maria-clara", "d'ávila" → "Maria-Clara", "D'Ávila". A name written on purpose like "McDonald" stays. */
function capitalize(word: string): string {
  if (/^\p{Lu}\p{Ll}+\p{Lu}\p{Ll}/u.test(word)) return word;
  return lower(word).replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, letter: string) => sep + upper(letter));
}

/** The standard form of a contact's name — see the file comment. */
export function normalizeContactName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(collapsed)) return collapsed || raw;

  // Symbols in front of the name ("#José", "- Maria", "01- Ana") go; digits are kept to be moved.
  const tokens = collapsed.replace(/^[^\p{L}\p{N}]+/u, "").split(" ");
  const numbers: string[] = [];
  const codes: string[] = [];
  let title: string | null = null;
  const words: string[] = [];

  for (const token of tokens) {
    const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, "");
    if (!bare) continue;
    // "123", "01-", "#45" → a number; "123-tgs", "123tgs", "tgs123", "tgs-123" → number and code.
    const numberFirst = bare.match(/^(\d+)[-.]?(\p{L}{3})$/u);
    const codeFirst = bare.match(/^(\p{L}{3})[-.]?(\d+)$/u);
    const numberAndCode = numberFirst ? [numberFirst[1], numberFirst[2]] : codeFirst ? [codeFirst[2], codeFirst[1]] : null;
    if (/^\d+\.?$/.test(bare)) {
      numbers.push(bare.replace(/\D/g, ""));
      continue;
    }
    if (numberAndCode && CITY_CODES.has(upper(numberAndCode[1]))) {
      numbers.push(numberAndCode[0]);
      codes.push(upper(numberAndCode[1]));
      continue;
    }
    if (CITY_CODES.has(upper(bare))) {
      codes.push(upper(bare));
      continue;
    }
    // Dr / Dr. / DRA → "Dr." / "Dra.", only as the first word of the name.
    if (words.length === 0 && title === null && /^dra?\.?$/i.test(bare)) {
      title = /^dra/i.test(bare) ? "Dra." : "Dr.";
      continue;
    }
    if (COMPANY_SUFFIXES.has(upper(bare))) {
      words.push(upper(bare));
      continue;
    }
    const word = bare.replace(/\.$/, "");
    words.push(words.length > 0 && LOWERCASE_PARTICLES.has(lower(word)) ? lower(word) : capitalize(word));
  }

  const number = numbers[0];
  const code = codes[0];
  const suffix = number && code ? `${number}-${code}` : (number ?? code ?? "");
  if (words.length === 0) return title || suffix ? [title, suffix].filter(Boolean).join(" ") : collapsed;
  const name = [title, ...words].filter(Boolean).join(" ");
  return suffix ? `${name} ${suffix}` : name;
}

/** "Dr. João" / "Dra. Ana" keep the title in the first name; otherwise the first word. Expects a normalized name. */
export function firstNameWithTitle(name: string): string {
  const [first, second] = name.trim().split(/\s+/);
  if ((first === "Dr." || first === "Dra.") && second) return `${first} ${second}`;
  return first ?? "";
}
