import { Router } from "express";
import { z } from "zod";
import { AI_ASSISTANT_NAME_MAX, AI_ASSISTANT_TEST_PHONES_MAX, AI_ASSISTANT_TEXT_MAX } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import * as service from "./ai-assistant.service";

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
      metadata: { enabled: saved.enabled, testMode: saved.testMode, connections: saved.connectionIds.length, testPhones: saved.testPhones.length },
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
