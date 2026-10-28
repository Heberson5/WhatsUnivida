import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { getLinkPreview } from "./link-preview.service";

export const linkPreviewRouter = Router();

linkPreviewRouter.use(requireAuth);

const querySchema = z.object({ url: z.string().url().max(2000) });

// Every agent reads messages with links, so like writing-assist this needs no
// extra permission — only a signed-in user. The service refuses internal addresses.
linkPreviewRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { url } = querySchema.parse(req.query);
    res.json(await getLinkPreview(url));
  })
);
