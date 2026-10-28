import { env } from "../../config/env";
import { logger } from "../../lib/logger";

const CHECK_TIMEOUT_MS = 5_000;

export interface WritingSuggestion {
  offset: number;
  length: number;
  message: string;
  replacement: string;
}

interface LanguageToolMatch {
  offset: number;
  length: number;
  message: string;
  replacements: { value: string }[];
}

interface LanguageToolResponse {
  matches: LanguageToolMatch[];
}

/**
 * Best-effort grammar/spelling check for the Composer's suggestion chip —
 * never throws. A down or slow LanguageTool instance just means no
 * suggestions this time, not a failure the caller needs to handle; sending
 * a message must never depend on this service being up.
 */
export async function checkText(text: string): Promise<WritingSuggestion[]> {
  try {
    const response = await fetch(`${env.LANGUAGETOOL_URL}/v2/check`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text, language: "pt-BR" }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "languagetool check returned a non-OK status");
      return [];
    }
    const data = (await response.json()) as LanguageToolResponse;
    return data.matches
      .filter((match) => match.replacements.length > 0)
      .map((match) => ({
        offset: match.offset,
        length: match.length,
        message: match.message,
        replacement: match.replacements[0].value,
      }));
  } catch (err) {
    logger.warn({ err }, "languagetool check failed — skipping writing suggestions");
    return [];
  }
}
