import type { Prisma } from "@prisma/client";
import { DEFAULT_WRITING_ASSIST_SETTINGS, type WritingAssistSettingsDTO, type WritingIssueDTO } from "@whatsatendende/types";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { getBranding } from "../settings/settings.service";

const CHECK_TIMEOUT_MS = 5_000;
const SETTINGS_KEY = "writingAssist";

type IssueKind = "spelling" | "grammar" | "informal" | "punctuation";

interface LanguageToolMatch {
  offset: number;
  length: number;
  message: string;
  replacements: { value: string }[];
  rule?: { issueType?: string; category?: { id?: string } };
}

interface LanguageToolResponse {
  matches: LanguageToolMatch[];
}

export async function getWritingAssistSettings(): Promise<WritingAssistSettingsDTO> {
  const record = await prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
  return record ? { ...DEFAULT_WRITING_ASSIST_SETTINGS, ...(record.value as object) } : DEFAULT_WRITING_ASSIST_SETTINGS;
}

export async function updateWritingAssistSettings(patch: Partial<WritingAssistSettingsDTO>): Promise<WritingAssistSettingsDTO> {
  const next = { ...(await getWritingAssistSettings()), ...patch };
  await prisma.systemSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: SETTINGS_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

/** Which Configurações › Corretor option a LanguageTool finding belongs to. */
function kindOf(match: LanguageToolMatch): IssueKind {
  const category = match.rule?.category?.id ?? "";
  const issue = match.rule?.issueType ?? "";
  if (category === "TYPOS" || category === "MISSPELLING" || issue === "misspelling") return "spelling";
  if (category === "FORMAL" || category === "COLLOQUIALISMS" || category === "STYLE" || issue === "style") return "informal";
  if (category === "CASING" || category === "PUNCTUATION" || category === "TYPOGRAPHY" || issue === "typographical") return "punctuation";
  return "grammar";
}

const normalize = (word: string) => word.trim().toLocaleLowerCase("pt-BR");

/** Names and the company's words are not errors: the customer's and the attendant's name, the company's, Configurações' list. */
async function knownWords(settings: WritingAssistSettingsDTO, context: { conversationId?: string; userId?: string }) {
  const [branding, conversation, user] = await Promise.all([
    getBranding(),
    context.conversationId ? prisma.conversation.findUnique({ where: { id: context.conversationId }, select: { contact: { select: { name: true } } } }) : null,
    context.userId ? prisma.user.findUnique({ where: { id: context.userId }, select: { fullName: true, displayName: true } }) : null,
  ]);
  const phrases = [...settings.companyTerms, branding.companyName, conversation?.contact.name, user?.fullName, user?.displayName];
  return new Set(phrases.flatMap((phrase) => (phrase ? phrase.split(/\s+/) : [])).map(normalize));
}

/**
 * Best-effort check behind the alert shown when sending to a customer — never throws. A down or slow LanguageTool
 * instance just means no alert this time; sending a message must never depend on this service being up.
 */
export async function checkText(text: string, context: { conversationId?: string; userId?: string } = {}): Promise<WritingIssueDTO[]> {
  const settings = await getWritingAssistSettings();
  if (!settings.enabled) return [];
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
    const known = await knownWords(settings, context);
    return data.matches
      .filter((match) => settings[kindOf(match)] && !known.has(normalize(text.slice(match.offset, match.offset + match.length))))
      .map((match) => ({
        offset: match.offset,
        length: match.length,
        message: match.message,
        replacement: match.replacements[0]?.value ?? null,
      }));
  } catch (err) {
    logger.warn({ err }, "languagetool check failed — skipping the writing alert");
    return [];
  }
}
