import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import type { Intent } from "./ai-text";

/**
 * The local AI (Ollama + Qwen2.5 3B) and the local transcription (Whisper large-v3-turbo), both on the VPS
 * (infrastructure/ia-local). Neither ever throws: a slow or missing service answers null, and the assistant then
 * passes the conversation to the queue.
 */

const CLASSIFY_TIMEOUT_MS = 45_000;
// A 1-minute audio takes 20–60 s on the VPS processor; longer ones are handed to a person anyway.
const TRANSCRIBE_TIMEOUT_MS = 240_000;

const INTENTS: Intent[] = ["BOLETO", "DEBITOS", "ATENDENTE", "ENCERRAR", "SAUDACAO", "AGRADECIMENTO", "OUTRO"];

const SYSTEM_PROMPT = `Você classifica mensagens de clientes de uma empresa de planos (funerária/saúde) recebidas pelo WhatsApp.
Responda só com JSON no formato {"intent": "...", "resumo": "..."}.
intent:
- "BOLETO": quer boleto, segunda via, linha digitável, código de barras, PIX ou pagar.
- "DEBITOS": quer saber se deve, quanto deve, parcelas em aberto ou atrasadas, valor atualizado.
- "ATENDENTE": pede para falar com uma pessoa/atendente.
- "ENCERRAR": quer encerrar ou sair desta conversa (não confundir com cancelar contrato ou plano, que é "OUTRO").
- "SAUDACAO": só cumprimenta.
- "AGRADECIMENTO": agradece ou encerra a conversa.
- "OUTRO": qualquer outro assunto (cancelamento, mudança de plano, reclamação, dúvida, comprovante etc.).
resumo: o pedido do cliente em até 15 palavras, em português.`;

/** Asks the local AI what the customer wants. Null when it is off, slow or answers something unusable. */
export async function classifyIntent(text: string): Promise<{ intent: Intent; summary: string } | null> {
  try {
    const response = await fetch(`${env.AI_OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
      body: JSON.stringify({
        model: env.AI_MODEL,
        stream: false,
        options: { temperature: 0, num_predict: 80 },
        format: {
          type: "object",
          properties: { intent: { type: "string", enum: INTENTS }, resumo: { type: "string" } },
          required: ["intent", "resumo"],
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "local AI answered with an error");
      return null;
    }
    const data = (await response.json()) as { message?: { content?: string } };
    const parsed = JSON.parse(data.message?.content ?? "{}") as { intent?: string; resumo?: string };
    if (!parsed.intent || !INTENTS.includes(parsed.intent as Intent)) return null;
    return { intent: parsed.intent as Intent, summary: String(parsed.resumo ?? "").slice(0, 200) };
  } catch (err) {
    logger.warn({ err }, "local AI unavailable — the assistant treats the message as another subject");
    return null;
  }
}

/** What the customer said in an audio stored in the uploads. Null when the service is off or fails. */
export async function transcribeAudio(storageKey: string, mimeType: string): Promise<string | null> {
  try {
    const filePath = path.join(env.UPLOAD_DIR, storageKey);
    if (!fs.existsSync(filePath)) return null;
    const audio = fs.readFileSync(filePath);
    const response = await fetch(`${env.AI_WHISPER_URL}/transcribe?language=pt`, {
      method: "POST",
      headers: { "content-type": mimeType || "application/octet-stream" },
      body: audio,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "transcription service answered with an error");
      return null;
    }
    const data = (await response.json()) as { text?: string };
    const text = (data.text ?? "").trim();
    return text || null;
  } catch (err) {
    logger.warn({ err }, "transcription unavailable");
    return null;
  }
}
