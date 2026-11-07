import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma, User } from "@prisma/client";
import { DEFAULT_AI_ASSISTANT_SETTINGS, type AiAssistantSettingsDTO, type AiAssistantStatusDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { phoneKey } from "../../lib/phone-key";
import { Errors, HttpError } from "../../lib/http-error";
import { writeAudit } from "../../lib/audit";
import { transcribeAudio } from "./ai-llm";

/**
 * Assistente Virtual — settings and the health of the local AI. The assistant itself (who it answers, what it says)
 * builds on these; with `enabled` false, nothing about a conversation changes.
 */

const SETTINGS_KEY = "aiAssistant";
const STATUS_TIMEOUT_MS = 3_000;

export async function getAiAssistantSettings(): Promise<AiAssistantSettingsDTO> {
  const record = await prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
  return record ? { ...DEFAULT_AI_ASSISTANT_SETTINGS, ...(record.value as Partial<AiAssistantSettingsDTO>) } : DEFAULT_AI_ASSISTANT_SETTINGS;
}

export async function updateAiAssistantSettings(next: AiAssistantSettingsDTO): Promise<AiAssistantSettingsDTO> {
  // Only connections that exist; phones kept as digits, without repeats.
  const connections = await prisma.whatsAppConnection.findMany({ where: { id: { in: next.connectionIds } }, select: { id: true } });
  const known = new Set(connections.map((c) => c.id));
  const testPhones = [...new Set(next.testPhones.map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 10))];
  const saved: AiAssistantSettingsDTO = {
    ...next,
    name: next.name.trim() || DEFAULT_AI_ASSISTANT_SETTINGS.name,
    greeting: next.greeting.trim(),
    transferMessage: next.transferMessage.trim(),
    connectionIds: next.connectionIds.filter((id) => known.has(id)),
    testPhones,
  };
  const value = saved as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value }, create: { key: SETTINGS_KEY, value } });
  await getAssistantUser(saved.name);
  return saved;
}

const ASSISTANT_EMAIL = "assistente-virtual@sistema.local";

/**
 * The Assistente Virtual as an attendant: the conversations it attends are assigned to this row and the ones it
 * closes are closed by it, so Relatórios, the Dashboard and the satisfaction survey count it like any attendant.
 * Always INACTIVE with a random password: it never logs in, never shows as online, never receives transfers.
 * Its name follows Configurações › Assistente Virtual.
 */
export async function getAssistantUser(name?: string): Promise<User> {
  const displayName = (name ?? (await getAiAssistantSettings()).name).trim() || DEFAULT_AI_ASSISTANT_SETTINGS.name;
  const existing = await prisma.user.findFirst({ where: { isAssistant: true } });
  if (existing) {
    if (existing.displayName === displayName && existing.status === "INACTIVE") return existing;
    return prisma.user.update({ where: { id: existing.id }, data: { displayName, fullName: displayName, status: "INACTIVE", presence: "OFFLINE" } });
  }
  return prisma.user.create({
    data: {
      email: ASSISTANT_EMAIL,
      fullName: displayName,
      displayName,
      role: "AGENT",
      status: "INACTIVE",
      presence: "OFFLINE",
      isAssistant: true,
      passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
    },
  });
}

/**
 * Whether the assistant takes this customer on this connection: switched on, the connection chosen, and — in Modo
 * teste — the phone on the test list (compared like the data sources: with or without 55 and the extra 9).
 */
export function assistantAnswers(settings: AiAssistantSettingsDTO, connectionId: string | null, phone: string | null): boolean {
  if (!settings.enabled || !connectionId || !settings.connectionIds.includes(connectionId)) return false;
  if (!settings.testMode) return true;
  const key = phoneKey(phone);
  return Boolean(key) && settings.testPhones.some((p) => phoneKey(p) === key);
}

/** Asks Ollama which models it has — never throws; a down service is reported, not raised. */
export async function getAiAssistantStatus(): Promise<AiAssistantStatusDTO> {
  const transcriptionReady = await fetch(`${env.AI_WHISPER_URL}/health`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
    .then(async (r) => (r.ok ? Boolean(((await r.json()) as { ready?: boolean }).ready) : false))
    .catch(() => false);
  const base: AiAssistantStatusDTO = { reachable: false, model: env.AI_MODEL, modelReady: false, transcriptionModel: env.AI_TRANSCRIPTION_MODEL, transcriptionReady, error: null };
  try {
    const response = await fetch(`${env.AI_OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!response.ok) return { ...base, error: `O serviço de IA respondeu ${response.status}` };
    const data = (await response.json()) as { models?: { name?: string; model?: string }[] };
    const names = (data.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => Boolean(n));
    const wanted = env.AI_MODEL.includes(":") ? env.AI_MODEL : `${env.AI_MODEL}:latest`;
    return { ...base, reachable: true, modelReady: names.includes(wanted) };
  } catch {
    return { ...base, error: "O serviço de IA (Ollama) não está acessível nesta VPS." };
  }
}

const transcribing = new Set<string>();

/**
 * "Transcrever" on a customer's audio, for the team — only when switched on in Configurações › Assistente Virtual.
 * The text is kept on the message (shown under the audio for everyone) and a second click just returns it.
 */
export async function transcribeMessageForTeam(conversationId: string, messageId: string, userId: string): Promise<string> {
  if (!(await getAiAssistantSettings()).agentTranscription) throw Errors.forbidden("A transcrição de áudio para atendentes está desligada nas Configurações");
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: { attachments: true } });
  if (!message || message.conversationId !== conversationId) throw Errors.notFound("Mensagem não encontrada");
  if (message.type !== "AUDIO" || !message.attachments[0]) throw Errors.badRequest("Só áudios podem ser transcritos");
  if (message.transcription) return message.transcription;
  if (transcribing.has(messageId)) throw Errors.conflict("Este áudio já está sendo transcrito — aguarde um instante");
  transcribing.add(messageId);
  try {
    const attachment = message.attachments[0];
    const text = await transcribeAudio(attachment.storageKey, attachment.mimeType);
    if (!text) throw new HttpError(502, "TRANSCRIPTION_UNAVAILABLE", "Não foi possível transcrever agora — o serviço de transcrição está indisponível ou o áudio está sem fala");
    await prisma.message.update({ where: { id: messageId }, data: { transcription: text } });
    await writeAudit({ userId, action: "AUDIO_TRANSCRIBED", entity: "Message", entityId: messageId, ipAddress: null, metadata: { conversationId } });
    return text;
  } finally {
    transcribing.delete(messageId);
  }
}
