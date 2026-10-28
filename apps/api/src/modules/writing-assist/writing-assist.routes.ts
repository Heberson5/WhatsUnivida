import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import * as service from "./writing-assist.service";

export const writingAssistRouter = Router();

writingAssistRouter.use(requireAuth);

const checkSchema = z.object({
  text: z.string().min(1).max(4000),
});

// No requirePermission here on purpose, same reasoning as quick-replies'
// conversation-scoped GET: suggesting a correction is something every agent
// does while typing a reply, not an administrative capability to curate.
writingAssistRouter.post(
  "/check",
  asyncHandler(async (req, res) => {
    const { text } = checkSchema.parse(req.body);
    const suggestions = await service.checkText(text);
    res.json(suggestions);
  })
);
