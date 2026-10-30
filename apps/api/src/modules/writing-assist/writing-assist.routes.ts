import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import * as service from "./writing-assist.service";

export const writingAssistRouter = Router();

writingAssistRouter.use(requireAuth);

const checkSchema = z.object({
  text: z.string().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  spelling: z.boolean().optional(),
  grammar: z.boolean().optional(),
  informal: z.boolean().optional(),
  punctuation: z.boolean().optional(),
  companyTerms: z.array(z.string().trim().min(1).max(60)).max(500).optional(),
});

// No requirePermission here on purpose, same reasoning as quick-replies'
// conversation-scoped GET: the check runs on every attendant's message to a
// customer, not an administrative capability to curate.
writingAssistRouter.post(
  "/check",
  asyncHandler(async (req, res) => {
    const { text, conversationId } = checkSchema.parse(req.body);
    res.json(await service.checkText(text, { conversationId, userId: req.auth!.userId }));
  })
);

writingAssistRouter.get(
  "/settings",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (_req, res) => {
    res.json(await service.getWritingAssistSettings());
  })
);

writingAssistRouter.patch(
  "/settings",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateWritingAssistSettings(settingsSchema.parse(req.body)));
  })
);
