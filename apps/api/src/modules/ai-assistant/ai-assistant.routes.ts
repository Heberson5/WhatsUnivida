import { Router } from "express";
import { z } from "zod";
import { AI_ASSISTANT_NAME_MAX, AI_ASSISTANT_TEST_PHONES_MAX, AI_ASSISTANT_TEXT_MAX } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import * as service from "./ai-assistant.service";
import { assistantClientData, simulateAssistant } from "./ai-engine.service";
import { maskCpf, extractCpf } from "./ai-text";

/** Configurações › Assistente Virtual — administrador only (it decides who talks to customers). */
export const aiAssistantRouter = Router();
aiAssistantRouter.use(requireAuth, requireRole("ADMIN"));

const settingsSchema = z.object({
  enabled: z.boolean(),
  name: z.string().max(AI_ASSISTANT_NAME_MAX),
  connectionIds: z.array(z.string().uuid()).max(200),
  testMode: z.boolean(),
  testPhones: z.array(z.string().max(30)).max(AI_ASSISTANT_TEST_PHONES_MAX),
  greeting: z.string().max(AI_ASSISTANT_TEXT_MAX),
  transferMessage: z.string().max(AI_ASSISTANT_TEXT_MAX),
  agentTranscription: z.boolean().default(false),
});

aiAssistantRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await service.getAiAssistantSettings());
  })
);

aiAssistantRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const saved = await service.updateAiAssistantSettings(settingsSchema.parse(req.body ?? {}));
    await writeAudit({
      userId: req.auth!.userId,
      action: "SETTINGS_AI_ASSISTANT_UPDATED",
      entity: "SystemSetting",
      entityId: "aiAssistant",
      ipAddress: req.ip ?? null,
      metadata: { enabled: saved.enabled, testMode: saved.testMode, connections: saved.connectionIds.length, testPhones: saved.testPhones.length, agentTranscription: saved.agentTranscription },
    });
    res.json(saved);
  })
);

aiAssistantRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.json(await service.getAiAssistantStatus());
  })
);

/** Dados dos clientes: can the assistant consult each connection's data right now (and why not). */
aiAssistantRouter.get(
  "/client-data",
  asyncHandler(async (_req, res) => {
    res.json(await assistantClientData());
  })
);

const simulateSchema = z.object({
  connectionId: z.string().uuid(),
  message: z.string().max(1000),
  cpf: z.string().max(30).nullable().optional(),
  when: z.enum(["now", "open", "closed"]).default("now"),
});

/** Simular atendimento: what the assistant would do, step by step — nothing goes to WhatsApp. */
aiAssistantRouter.post(
  "/simulate",
  asyncHandler(async (req, res) => {
    const input = simulateSchema.parse(req.body ?? {});
    const result = await simulateAssistant(input);
    const cpf = extractCpf(input.cpf ?? "") ?? extractCpf(input.message);
    await writeAudit({
      userId: req.auth!.userId,
      action: "AI_ASSISTANT_SIMULATED",
      entity: "WhatsAppConnection",
      entityId: input.connectionId,
      ipAddress: req.ip ?? null,
      metadata: { when: input.when, cpf: cpf ? maskCpf(cpf) : null, outcome: result.outcome },
    });
    res.json(result);
  })
);

/** For everyone logged in: whether the audios get the "Transcrever" button. */
export const aiFeaturesRouter = Router();
aiFeaturesRouter.use(requireAuth);
aiFeaturesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const settings = await service.getAiAssistantSettings();
    res.json({ agentTranscription: settings.agentTranscription });
  })
);
